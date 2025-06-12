import { Response, NextFunction } from "express";
import Note, { INote } from "../models/Note";
import { IUser } from "../models/User"; // UserModel is not directly used here, but IUser is.
import { AuthRequest } from "../middleware/authMiddleware";
import mongoose, { Types } from "mongoose";
import { io } from "../server";
import {
  PopulatedNote,
  createNoteSchema,
  updateNoteSchema,
  getUserIdStringFromField,
  checkPermissions,
} from "./noteUtils";

export const createNote = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { error, value } = createNoteSchema.validate(req.body);
    if (error) {
      res.status(400).json({ message: error.details[0].message });
      return;
    }

    if (!req.user || !req.user._id) {
      res
        .status(401)
        .json({ message: "User not authenticated or user ID missing" });
      return;
    }

    const { title, content } = value;
    const note: INote = await Note.create({
      title,
      content,
      creator: req.user._id as Types.ObjectId, // Cast to Types.ObjectId
      sharedWith: [],
      isArchived: false, // Default value
    });

    // Emit event for notes list update
    io.emit("notesListUpdated", {
      action: "create",
      note: {
        _id: (note._id as Types.ObjectId).toString(),
        title: note.title,
        updatedAt: note.updatedAt,
        creator: { _id: req.user._id, username: req.user.username }, // Send minimal creator info
        sharedWith: [], // New notes are not shared initially
      },
    });

    res.status(201).json(note);
  } catch (err) {
    next(err);
  }
};

export const getMyNotes = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  console.log(
    "[getMyNotes] Called by user:",
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
    const sortBy = (req.query.sortBy as string) || "updatedAt";
    const sortOrderQuery = (req.query.sortOrder as string) || "desc";
    const sortOrder: 1 | -1 = sortOrderQuery === "asc" ? 1 : -1;

    const sortOptions: { [key: string]: 1 | -1 } = {};
    if (sortBy === "title") {
      sortOptions.title = sortOrder;
    } else if (sortBy === "createdAt") {
      sortOptions.createdAt = sortOrder;
    } else {
      // Default to updatedAt
      sortOptions.updatedAt = sortOrder;
    }

    const notesQuery = Note.find({ creator: userId, isArchived: false })
      .sort(sortOptions)
      .skip(skip)
      .limit(limit)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{
        sharedWith: Array<{
          userId: IUser;
          role: "read" | "write";
          email: string; // This was in original, might be from a specific type for sharedWith population
        }>;
      }>({
        path: "sharedWith.userId",
        select: "username email _id",
      })
      .lean(); // Use .lean() for performance if not modifying documents

    const notes = await notesQuery;
    const totalNotes = await Note.countDocuments({
      creator: userId,
      isArchived: false,
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

export const getSharedWithMeNotes = async (
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
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;
    const sortBy = (req.query.sortBy as string) || "updatedAt";
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

    const notes = await Note.find({
      "sharedWith.userId": req.user._id as Types.ObjectId,
      isArchived: false,
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
      "sharedWith.userId": req.user._id as Types.ObjectId,
      isArchived: false,
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

export const getAllUserNotes = async (
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

    const userId = req.user._id as Types.ObjectId;

    const notes = await Note.find({
      $or: [{ creator: userId }, { "sharedWith.userId": userId }],
      isArchived: false,
    })
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
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json(notes);
  } catch (err) {
    next(err);
  }
};

export const getNoteById = async (
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

    const note = (await Note.findById(noteId)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{
        sharedWith: Array<{
          userId: IUser;
          role: "read" | "write";
          email: string;
        }>;
      }>({
        // Adjusted PopulatedNote equivalent
        path: "sharedWith.userId",
        select: "username email _id",
      })) as PopulatedNote | null;

    if (!note) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    const authenticatedUserId = req.user._id.toString();

    console.log(`[getNoteById] Attempting to access note: ${noteId}`);
    console.log(
      `[getNoteById] Authenticated User ID (pre-check): ${authenticatedUserId}`
    );

    const creatorIdForLog = getUserIdStringFromField(
      note.creator // creator is IUser due to PopulatedNote type
    );
    console.log(
      `[getNoteById] Note Creator ID (pre-check from field): ${creatorIdForLog}`
    );

    if (!checkPermissions(note, authenticatedUserId, "read")) {
      console.log(
        `[getNoteById] Permission DENIED by checkPermissions for user ${authenticatedUserId} on note ${noteId}`
      );
      res
        .status(403)
        .json({ message: "You do not have permission to view this note" });
      return;
    }

    console.log(
      `[getNoteById] Permission GRANTED for user ${authenticatedUserId} on note ${noteId}`
    );
    res.status(200).json(note);
  } catch (err) {
    console.error(`[getNoteById] Error fetching note ${req.params.id}:`, err);
    next(err);
  }
};

export const updateNote = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { error, value } = updateNoteSchema.validate(req.body);
    if (error) {
      res.status(400).json({ message: error.details[0].message });
      return;
    }

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

    // Fetch the note as a Mongoose document to use .save()
    const noteInstance = await Note.findById(noteId);

    if (!noteInstance) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    // Now cast to PopulatedNote for permission checking after populating separately if needed,
    // or ensure checkPermissions can handle INote. The current checkPermissions handles INote.
    // For permission check, we need a structure that checkPermissions understands.
    // Let's re-fetch with population for consistent permission checking structure.
    const noteToCheckPermissions = (await Note.findById(noteId)
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
      })) as PopulatedNote | null;

    if (!noteToCheckPermissions) {
      // Should not happen if noteInstance was found, but as a safeguard
      res
        .status(404)
        .json({ message: "Note disappeared before permission check" });
      return;
    }

    const authenticatedUserId = req.user._id.toString();

    if (
      !checkPermissions(noteToCheckPermissions, authenticatedUserId, "write")
    ) {
      res
        .status(403)
        .json({ message: "You do not have permission to edit this note" });
      return;
    }

    // Apply updates to the original Mongoose document instance
    const { title, content } = value;
    if (title !== undefined) noteInstance.title = title;
    if (content !== undefined) noteInstance.content = content;
    // noteInstance.updatedAt will be updated by Mongoose by default due to timestamps: true in schema

    const savedNote = await noteInstance.save();

    // Populate the saved note for the response
    const populatedSavedNote = (await Note.findById(savedNote._id)
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
      })) as PopulatedNote | null;

    if (populatedSavedNote) {
      io.to(noteId).emit("noteUpdated", populatedSavedNote);
      // Emit event for notes list update
      io.emit("notesListUpdated", {
        action: "update",
        noteId: populatedSavedNote._id.toString(),
        title: populatedSavedNote.title,
        updatedAt: populatedSavedNote.updatedAt,
        creator: populatedSavedNote.creator, // Send populated creator
        sharedWith: populatedSavedNote.sharedWith, // Send populated sharedWith
      });
      res.status(200).json(populatedSavedNote);
    } else {
      // This case should ideally not be reached if save was successful
      res
        .status(500)
        .json({ message: "Failed to retrieve note after update." });
    }
  } catch (err) {
    next(err);
  }
};

export const deleteNote = async (
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

    const note = (await Note.findById(noteId)
      .populate<{ creator: IUser }>("creator", "_id") // Only need ID for owner check
      .populate<{
        sharedWith: Array<{ userId: Pick<IUser, "_id">; role: string }>;
      }>({
        // Only need ID for shared check
        path: "sharedWith.userId",
        select: "_id",
      })) as PopulatedNote | null;

    if (!note) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    const authenticatedUserId = req.user._id.toString();

    // For deletion, user must be the owner (creator)
    if (!checkPermissions(note, authenticatedUserId, "owner")) {
      res
        .status(403)
        .json({ message: "You do not have permission to delete this note" });
      return;
    }

    await Note.findByIdAndDelete(noteId);

    io.to(noteId).emit("noteDeleted", { noteId }); // Notify clients viewing this specific note
    io.emit("notesListUpdated", { action: "delete", noteId }); // Notify all clients to update their lists

    res.status(200).json({ message: "Note deleted successfully" });
  } catch (err) {
    next(err);
  }
};
