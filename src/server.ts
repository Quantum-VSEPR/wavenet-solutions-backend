import express, { Express, Request, Response } from "express";
import http from "http";
import { Server as SocketIOServer, Socket } from "socket.io"; // Added Socket type
import mongoose from "mongoose"; // Ensure mongoose is imported if used in socket handlers
import cors from "cors";
import morgan from "morgan";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import config from "./config";
import { errorHandler } from "./middleware/errorHandler";
import { rateLimiter } from "./middleware/rateLimiter";
import authRoutes from "./routes/authRoutes";
import noteRoutes from "./routes/noteRoutes";
import userRoutes from "./routes/userRoutes";
import { startArchivingJob } from "./services/archivingService"; // Import archiving service
import Note from "./models/Note"; // Import the Note model

const app: Express = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin:
      config.nodeEnv === "development"
        ? "http://localhost:3000"
        : process.env.FRONTEND_URL, // More flexible origin
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  },
});

// Middleware
app.use(
  cors({ origin: "https://wavenet-solution.vercel.app/api", credentials: true })
);
app.use(helmet());
app.use(morgan(config.nodeEnv === "development" ? "dev" : "combined"));
app.use(express.json({ limit: "50mb" })); // Increased payload size limit for JSON
app.use(express.urlencoded({ limit: "50mb", extended: true })); // Increased payload size limit for URL-encoded
app.use(cookieParser());
app.use(rateLimiter); // Apply rate limiting to all requests

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/notes", noteRoutes);
app.use("/api/users", userRoutes);

// Root Route
app.get("/", (_req: Request, res: Response) => {
  res.send("Collaborative Notes API Running");
});

// Socket.IO connection
io.on("connection", (socket: Socket) => {
  console.log("New client connected", socket.id);

  socket.on("registerUser", (userId: string) => {
    if (userId) {
      socket.join(userId); // Join user-specific room
      console.log(
        `Socket ${socket.id} registered and joined user room ${userId}`
      );
    }
  });

  socket.on("joinUserRoom", (userId: string) => {
    // Ensure this is distinct if used elsewhere or consolidate
    if (userId) {
      socket.join(userId);
      console.log(
        `Socket ${socket.id} explicitly joined user room ${userId} from client request.`
      );
    }
  });

  socket.on("joinNoteRoom", (noteId: string) => {
    socket.join(noteId);
    console.log(`Socket ${socket.id} joined note room ${noteId}`);
  });

  socket.on("leaveNoteRoom", (noteId: string) => {
    socket.leave(noteId);
    console.log(`Socket ${socket.id} left note room ${noteId}`);
  });

  // REMOVED: Real-time content updates for live typing to prevent immediate sync
  // socket.on(
  //   "noteContentChange",
  //   (data: { noteId: string; content: any; updatedBy: string }) => {
  //     // socket.to(data.noteId).emit("noteContentUpdated", { // This was causing live updates
  //     //   noteId: data.noteId,
  //     //   content: data.content,
  //     //   updatedBy: data.updatedBy,
  //     // });
  //     // console.log(
  //     //   `Content changed for note ${data.noteId} by ${data.updatedBy}, changes NOT broadcasted live.`
  //     // );
  //   }
  // );

  socket.on(
    "userStartedEditingNote",
    (data: { noteId: string; userId: string; username: string }) => {
      socket.to(data.noteId).emit("otherUserStartedEditing", data);
      console.log(`User ${data.username} started editing note ${data.noteId}`);
    }
  );

  socket.on(
    "userStoppedEditingNote",
    (data: { noteId: string; userId: string; username: string }) => {
      socket.to(data.noteId).emit("otherUserStoppedEditing", data);
      console.log(`User ${data.username} stopped editing note ${data.noteId}`);
    }
  );

  // Listener for when a user signals they have finished editing a note (e.g., on blur or explicit save)
  socket.on(
    "userFinishedEditingNoteWithContent",
    async (data: {
      noteId: string;
      title: string;
      content: any;
      editorId: string;
      editorUsername: string;
    }) => {
      console.log(
        `[Socket] Received userFinishedEditingNoteWithContent from ${data.editorUsername} (ID: ${data.editorId}) for note ${data.noteId}`
      );
      try {
        const note = await Note.findById(data.noteId)
          .populate<{
            creator: { _id: mongoose.Types.ObjectId; username: string };
          }>("creator", "username _id")
          .populate<{
            sharedWith: Array<{
              userId: { _id: mongoose.Types.ObjectId; username: string };
              role: string;
            }>;
          }>("sharedWith.userId", "username _id")
          .exec();

        if (note) {
          let contentChanged = false;
          if (
            typeof note.content === "object" &&
            typeof data.content === "object"
          ) {
            contentChanged =
              JSON.stringify(note.content) !== JSON.stringify(data.content);
          } else {
            contentChanged = note.content !== data.content;
          }

          const titleChanged = note.title !== data.title;

          if (titleChanged || contentChanged) {
            console.log(
              `[Socket] Changes detected for note ${data.noteId}. Title changed: ${titleChanged}, Content changed: ${contentChanged}. Attempting to save.`
            );
            note.title = data.title;
            note.content = data.content;
            // Assuming lastModifiedBy field exists in your INote and schema
            if (note.schema.paths.lastModifiedBy) {
              (note as any).lastModifiedBy = new mongoose.Types.ObjectId(
                data.editorId
              );
            }
            await note.save();
            console.log(
              `[Socket] Note ${data.noteId} updated successfully by ${data.editorUsername}.`
            );

            // Proceed to notify collaborators
            const collaboratorsToNotify: string[] = [];

            // Notify creator if they are not the editor
            if (note.creator && note.creator._id.toString() !== data.editorId) {
              collaboratorsToNotify.push(note.creator._id.toString());
            }

            // Notify shared users if they are not the editor
            (
              note.sharedWith as Array<{
                userId: { _id: mongoose.Types.ObjectId; username: string };
                role: string;
              }>
            ).forEach((share) => {
              if (
                share.userId &&
                share.userId._id.toString() !== data.editorId
              ) {
                collaboratorsToNotify.push(share.userId._id.toString());
              }
            });

            const uniqueCollaboratorIds = [...new Set(collaboratorsToNotify)];

            if (uniqueCollaboratorIds.length > 0) {
              const notificationPayload = {
                noteId: data.noteId,
                noteTitle: data.title, // Use the new title from data
                editorUsername: data.editorUsername,
                message: `${data.editorUsername} updated the note '${data.title}'.`,
                updatedAt: new Date().toISOString(),
                type: "info",
                actionable: true,
              };
              console.log(
                `[Socket] Emitting 'notifyNoteUpdatedByOther' to user rooms: ${uniqueCollaboratorIds.join(
                  ", "
                )} for note ${data.noteId}`
              );
              uniqueCollaboratorIds.forEach((userId) => {
                io.to(userId).emit(
                  "notifyNoteUpdatedByOther",
                  notificationPayload
                );
              });
            } else {
              console.log(
                `[Socket] No other collaborators to notify for note ${data.noteId} after update by ${data.editorUsername}.`
              );
            }
          } else {
            console.log(
              `[Socket] No significant changes detected for note ${data.noteId} by ${data.editorUsername}. No update or notification needed.`
            );
          }
        } else {
          console.log(
            `[Socket] Note not found for ID: ${data.noteId} during userFinishedEditingNoteWithContent handling.`
          );
        }
      } catch (error) {
        console.error(
          "[Socket] Error handling userFinishedEditingNoteWithContent:",
          error
        );
        // Optionally, emit an error back to the originating client
        socket.emit("noteUpdateError", {
          noteId: data.noteId,
          message: "Failed to save changes on server.",
        });
      }
    }
  );

  // REMOVE or REFACTOR the old "userFinishedEditingNote" if "userFinishedEditingNoteWithContent" replaces its purpose
  // For now, I'll comment it out to avoid conflicts. If it serves a different purpose, it needs to be re-evaluated.
  /*
  socket.on(
    "userFinishedEditingNote",
    async (data: {
      noteId: string;
      noteTitle: string; // This was from the old payload
      editorUsername: string;
      editorId: string;
    }) => {
      console.log(
        `[Socket] Received OLD userFinishedEditingNote from ${data.editorUsername} for note ${data.noteTitle}`
      );
      // ... existing logic for the old event ...
      // This logic should be merged or replaced by userFinishedEditingNoteWithContent
    }
  );
  */

  socket.on("disconnect", () => {
    console.log("Client disconnected", socket.id);
  });
});

// Global Error Handler
app.use(errorHandler);

// Database Connection
mongoose
  .connect(config.mongoURI)
  .then(() => {
    console.log("MongoDB Connected");
    server.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      startArchivingJob(); // Start the archiving cron job
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

export { io }; // Export io for use in other modules if needed
