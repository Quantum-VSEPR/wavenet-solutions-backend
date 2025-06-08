import express, { Express, Request, Response } from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import mongoose from "mongoose";
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

const app: Express = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "http://localhost:3000", // Adjust this to your frontend URL
    methods: ["*", "GET", "POST", "PUT", "DELETE"],
    credentials: true,
  },
});

// Middleware
app.use(cors({ origin: "http://localhost:3000", credentials: true }));
app.use(helmet());
app.use(morgan(config.nodeEnv === "development" ? "dev" : "combined"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
io.on("connection", (socket) => {
  console.log("New client connected", socket.id);

  socket.on("joinNoteRoom", (noteId: string) => {
    socket.join(noteId);
    console.log(`Socket ${socket.id} joined room ${noteId}`);
  });

  socket.on("leaveNoteRoom", (noteId: string) => {
    socket.leave(noteId);
    console.log(`Socket ${socket.id} left room ${noteId}`);
  });

  socket.on("noteUpdate", (data: { noteId: string; content: string }) => {
    socket.to(data.noteId).emit("noteUpdated", data);
  });

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
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

export { io }; // Export io for use in other modules if needed
