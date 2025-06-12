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
app.use(cors({ origin: "http://localhost:3000", credentials: true }));
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
      socket.join(userId);
      console.log(`Socket ${socket.id} registered and joined room ${userId}`);
    }
  });

  socket.on("joinNoteRoom", (noteId: string) => {
    socket.join(noteId);
    console.log(`Socket ${socket.id} joined room ${noteId}`);
  });

  socket.on("leaveNoteRoom", (noteId: string) => {
    socket.leave(noteId);
    console.log(`Socket ${socket.id} left room ${noteId}`);
  });

  // Real-time content updates within a note room
  socket.on(
    "noteContentChange",
    (data: { noteId: string; content: any; updatedBy: string }) => {
      socket.to(data.noteId).emit("noteContentUpdated", {
        noteId: data.noteId,
        content: data.content,
        updatedBy: data.updatedBy,
      });
      console.log(
        `Content updated for note ${data.noteId} by ${data.updatedBy}, changes broadcasted.`
      );
    }
  );

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

  socket.on(
    "userFinishedEditingNote",
    async (data: {
      noteId: string;
      noteTitle: string;
      editorUsername: string;
      editorId: string;
    }) => {
      console.log(
        `[Socket] Received userFinishedEditingNote from ${data.editorUsername} for note ${data.noteTitle}`
      );
      try {
        const NoteModel = mongoose.model("Note"); // Use mongoose.model
        const note = await NoteModel.findById(data.noteId)
          .select("sharedWith creator")
          .populate("sharedWith.userId", "username")
          .populate("creator", "username")
          .exec();

        if (note) {
          const collaboratorsToNotify: string[] = [];

          if (
            note.creator &&
            (note.creator as any)._id.toString() !== data.editorId
          ) {
            collaboratorsToNotify.push((note.creator as any)._id.toString());
          }

          (note.sharedWith as any[]).forEach((share: any) => {
            if (share.userId && share.userId._id.toString() !== data.editorId) {
              collaboratorsToNotify.push(share.userId._id.toString());
            }
          });

          const uniqueCollaboratorIds = [...new Set(collaboratorsToNotify)];

          if (uniqueCollaboratorIds.length > 0) {
            console.log(
              `[Socket] Emitting noteEditFinishedByOtherUser to users: ${uniqueCollaboratorIds.join(
                ", "
              )} for note ${data.noteTitle}`
            );
            uniqueCollaboratorIds.forEach((userId) => {
              io.to(userId).emit("noteEditFinishedByOtherUser", {
                noteId: data.noteId,
                noteTitle: data.noteTitle,
                editorUsername: data.editorUsername,
                editorId: data.editorId,
              });
            });
          }
        } else {
          console.log(
            `[Socket] Note not found for ID: ${data.noteId} during userFinishedEditingNote handling.`
          );
        }
      } catch (error) {
        console.error(
          "[Socket] Error handling userFinishedEditingNote:",
          error
        );
      }
    }
  );

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
      // Add this line to confirm Socket.IO is attached
      console.log(`Socket.IO listening on port ${config.port}`);
      startArchivingJob(); // Start the archiving cron job
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

export { io }; // Export io for use in other modules if needed
