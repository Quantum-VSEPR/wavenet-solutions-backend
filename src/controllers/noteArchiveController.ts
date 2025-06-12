import { Response, NextFunction } from "express";
import Note from "../models/Note";
import { AuthRequest } from "../middleware/authMiddleware";
import mongoose, { Types } from "mongoose";
import { PopulatedNote, checkPermissions } from "./noteUtils";
import { IUser } from "../models/User"; // Required for PopulatedNote and checkPermissions context
import { io } from "../server"; // For real-time updates

export const getArchivedNotes = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  console.log(
    "[getArchivedNotes] Called by user:",
    req.user?._id,
    "Query:",
    req.query
  );
  try {
    if (!req.user || !req.user._id) {
      res
        .status(401)
        .json({ message: "User not authenticated or user ID missing" });
      return;
    }
    const userId = req.user._id as Types.ObjectId;

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;
    const sortBy = (req.query.sortBy as string) || "updatedAt"; // Default sort
    const sortOrderQuery = (req.query.sortOrder as string) || "desc";
    const sortOrder: 1 | -1 = sortOrderQuery === "asc" ? 1 : -1;

    const sortOptions: { [key: string]: 1 | -1 } = {};
    if (sortBy === "title") {
      sortOptions.title = sortOrder;
    } else if (sortBy === "createdAt") {
      sortOptions.createdAt = sortOrder;
    } else {
      sortOptions.updatedAt = sortOrder;
    }

    // Find notes created by the user AND are archived
    const notes = await Note.find({
      creator: userId, // Only notes created by the user
      isArchived: true,
    })
      .sort(sortOptions)
      .skip(skip)
      .limit(limit)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{
        sharedWith: Array<{
          userId: IUser;
          role: "read" | "write";
          email: string;
        }>;
      }>({
        path: "sharedWith.userId",
        select: "username email _id",
      })
      .lean();

    const totalNotes = await Note.countDocuments({
      creator: userId, // Only count notes created by the user
      isArchived: true,
    });

    res.status(200).json({
      notes,
      totalPages: Math.ceil(totalNotes / limit),
      currentPage: page,
      totalNotes,
    });
  } catch (err) {
    next(err);
  }
};

export const archiveNote = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      res
        .status(401)
        .json({ message: "User not authenticated or user ID missing" });
      return;
    }
    const noteId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(noteId)) {
      res.status(400).json({ message: "Invalid note ID" });
      return;
    }

    const note = await Note.findById(noteId)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{
        sharedWith: Array<{
          userId: IUser;
          role: "read" | "write";
          email: string;
        }>;
      }>({
        path: "sharedWith.userId",
        select: "username email _id",
      });

    if (!note) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    const authenticatedUserId = req.user._id.toString();
    // User needs write permission to archive/unarchive
    if (
      !checkPermissions(note as PopulatedNote, authenticatedUserId, "write")
    ) {
      res
        .status(403)
        .json({ message: "You do not have permission to archive this note" });
      return;
    }

    if (note.isArchived) {
      res.status(400).json({ message: "Note is already archived" });
      return;
    }

    // If the user archiving the note is the creator, also clear the sharedWith list
    if (
      note.creator &&
      req.user &&
      note.creator._id.toString() === req.user._id.toString()
    ) {
      note.sharedWith = [];
      console.log(
        `[archiveNote] Owner ${req.user._id.toString()} is archiving note ${note._id.toString()}. Clearing sharedWith list.`
      );
    }

    note.isArchived = true;
    const savedNote = await note.save();

    const populatedSavedNote = await Note.findById(savedNote._id)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{
        sharedWith: Array<{
          userId: IUser;
          role: "read" | "write";
          email: string;
        }>;
      }>({
        path: "sharedWith.userId",
        select: "username email _id",
      });

    io.to(noteId).emit("noteUpdated", populatedSavedNote); // Notify clients viewing this specific note
    io.emit("notesListUpdated", {
      action: "archive",
      noteId: (savedNote._id as Types.ObjectId).toString(), // Cast to Types.ObjectId
      isArchived: true,
      note: populatedSavedNote,
      actorId: req.user._id.toString(), // Added actorId
    });

    res.status(200).json(populatedSavedNote);
  } catch (err) {
    next(err);
  }
};

export const unarchiveNote = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      res
        .status(401)
        .json({ message: "User not authenticated or user ID missing" });
      return;
    }
    const noteId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(noteId)) {
      res.status(400).json({ message: "Invalid note ID" });
      return;
    }

    const note = await Note.findById(noteId)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{
        sharedWith: Array<{
          userId: IUser;
          role: "read" | "write";
          email: string;
        }>;
      }>({
        path: "sharedWith.userId",
        select: "username email _id",
      });

    if (!note) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    const authenticatedUserId = req.user._id.toString();
    // User needs write permission to archive/unarchive
    if (
      !checkPermissions(note as PopulatedNote, authenticatedUserId, "write")
    ) {
      res
        .status(403)
        .json({ message: "You do not have permission to unarchive this note" });
      return;
    }

    if (!note.isArchived) {
      res.status(400).json({ message: "Note is not archived" });
      return;
    }

    note.isArchived = false;
    const savedNote = await note.save();

    const populatedSavedNote = await Note.findById(savedNote._id)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{
        sharedWith: Array<{
          userId: IUser;
          role: "read" | "write";
          email: string;
        }>;
      }>({
        path: "sharedWith.userId",
        select: "username email _id",
      });

    io.to(noteId).emit("noteUpdated", populatedSavedNote); // Notify clients viewing this specific note
    io.emit("notesListUpdated", {
      action: "unarchive",
      noteId: (savedNote._id as Types.ObjectId).toString(), // Cast to Types.ObjectId
      isArchived: false,
      note: populatedSavedNote,
      actorId: req.user._id.toString(), // Added actorId
    });

    res.status(200).json(populatedSavedNote);
  } catch (err) {
    next(err);
  }
};
