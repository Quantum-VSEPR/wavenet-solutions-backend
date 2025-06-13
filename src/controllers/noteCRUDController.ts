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
    const userId = req.user._id as Types.ObjectId;

    // Check for existing note with the same title for this user and is not archived
    const existingNote = await Note.findOne({
      title,
      creator: userId,
      isArchived: false,
    });
    if (existingNote) {
      res.status(409).json({
        message:
          "A note with this title already exists and is not archived. Please use a different title or check your archived notes.",
      }); // 409 Conflict
      return;
    }

    const note: INote = await Note.create({
      title,
      content,
      creator: userId, // Cast to Types.ObjectId
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
        creator: { _id: req.user._id, username: (req.user as any).username }, // Added 'as any' for username, ensure it's populated or handle if not
        sharedWith: [], // New notes are not shared initially
      },
      actorId: req.user._id.toString(), // Added actorId
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
      res.status(401).json({ message: "User not authenticated" });
      return;
    }

    const noteId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(noteId)) {
      res.status(400).json({ message: "Invalid note ID" });
      return;
    }

    const { title, content, isAutoSave } = value; // Added isAutoSave
    const userId = req.user._id.toString();
    const username = req.user.username;

    const note = await Note.findById(noteId);

    if (!note) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    const hasPermission = checkPermissions(note, userId, "write");
    if (!hasPermission) {
      res
        .status(403)
        .json({ message: "You do not have permission to edit this note" });
      return;
    }

    // Update note fields
    if (title !== undefined) note.title = title;
    if (content !== undefined) note.content = content;
    // note.lastUpdatedBy = userId; // This might be useful for tracking

    const updatedNote = await note.save();

    // Ensure updatedNote is treated as INote for type safety
    const typedUpdatedNote = updatedNote as INote;

    // Emit event for notes list update (e.g., if title or summary changed)
    // This ensures the list view is current for all users who can see this note.
    io.to(noteId).emit("notesListUpdated", {
      action: "update", // A generic update action
      note: {
        _id: (typedUpdatedNote._id as Types.ObjectId).toString(),
        title: typedUpdatedNote.title,
        updatedAt: typedUpdatedNote.updatedAt,
        // Potentially other fields needed for list display
      },
      actorId: userId,
    });

    // Emit an event to the updater (current user) for a toast notification
    // This is a specific event for the user who performed the update.
    io.to(userId).emit("noteUpdateSuccess", {
      noteId: (typedUpdatedNote._id as Types.ObjectId).toString(),
      title: typedUpdatedNote.title,
      message: `Note '${typedUpdatedNote.title}' updated successfully.`,
      isAutoSave: !!isAutoSave, // Pass along if it was an autosave
    });

    // If it's NOT an autosave, then notify other collaborators for a bell notification.
    if (!isAutoSave) {
      const populatedNote = await Note.findById(typedUpdatedNote._id)
        .populate<{
          creator: { _id: mongoose.Types.ObjectId; username: string };
        }>("creator", "username _id")
        .populate<{
          sharedWith: Array<{
            userId: { _id: mongoose.Types.ObjectId; username: string };
            role: string;
          }>;
        }>("sharedWith.userId", "username _id")
        .lean();

      if (populatedNote) {
        const collaboratorsToNotify: string[] = [];
        if (
          populatedNote.creator &&
          populatedNote.creator._id.toString() !== userId
        ) {
          collaboratorsToNotify.push(populatedNote.creator._id.toString());
        }
        populatedNote.sharedWith.forEach((share) => {
          if (share.userId && share.userId._id.toString() !== userId) {
            collaboratorsToNotify.push(share.userId._id.toString());
          }
        });

        const uniqueCollaboratorIds = [...new Set(collaboratorsToNotify)];
        if (uniqueCollaboratorIds.length > 0) {
          const notificationPayload = {
            noteId: populatedNote._id.toString(),
            noteTitle: populatedNote.title,
            editorUsername: username, // Username of the person who made the change
            message: `${username} updated the note '${populatedNote.title}'.`,
            updatedAt: populatedNote.updatedAt.toISOString(),
            type: "info",
            actionable: true, // Or based on significance
          };
          uniqueCollaboratorIds.forEach((collaboratorId) => {
            io.to(collaboratorId).emit(
              "notifyNoteUpdatedByOther",
              notificationPayload
            );
          });
          console.log(
            `[updateNote API] Emitted 'notifyNoteUpdatedByOther' to ${uniqueCollaboratorIds.length} collaborators for note ${populatedNote.title}`
          );
        }
      }
    }

    res.status(200).json(updatedNote);
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
    // For delete, the frontend expects `note` object with at least an _id and title for the notification.
    // However, the note is already deleted. We should send the minimal required info.
    // The frontend handler `handleNotesListUpdated` uses `data.note.title` and `data.note._id`.
    // We need to ensure `note` (the object before deletion) is available here or pass its details.

    // Determine creator info for the notification payload
    // Assuming 'note.creator' is an ObjectId here as it's not explicitly populated with .populate() in this function before this point.
    let creatorPayloadId = "unknown_creator_id";
    let creatorPayloadUsername = "Unknown User";

    if (note.creator) {
      // Check if note.creator is an ObjectId or a string representation of an ID
      if (typeof note.creator.toString === "function") {
        creatorPayloadId = note.creator.toString();
      }

      // In the less likely event that note.creator was somehow a populated object here,
      // attempt to get username and a more definitive _id.
      if (typeof note.creator === "object" && note.creator !== null) {
        const potentialCreatorObj = note.creator as any; // Use 'any' for robust property access
        if (
          potentialCreatorObj._id &&
          typeof potentialCreatorObj._id.toString === "function"
        ) {
          creatorPayloadId = potentialCreatorObj._id.toString();
        }
        if (typeof potentialCreatorObj.username === "string") {
          creatorPayloadUsername = potentialCreatorObj.username;
        }
      }
    }

    io.emit("notesListUpdated", {
      action: "delete",
      note: {
        _id: noteId,
        title: note.title, // Assuming 'note' still holds the data before deletion
        creator: {
          _id: creatorPayloadId,
          username: creatorPayloadUsername,
        },
        sharedWith: [], // Or reconstruct if necessary, but likely not needed for delete notification
        updatedAt: new Date().toISOString(), // Or use note.updatedAt if available
      },
      actorId: req.user._id.toString(), // Added actorId
    });

    res.status(200).json({ message: "Note deleted successfully" });
  } catch (err) {
    next(err);
  }
};

export const searchNotes = async (
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
    const query = (req.query.q as string) || "";

    if (!query) {
      res.status(400).json({ message: "Search query is required" });
      return;
    }

    let notes;
    // If the query is very short (e.g., 1 or 2 characters), a regex search might be more effective
    // as text search might ignore very short terms or common words.
    if (query.length <= 2) {
      const regex = new RegExp(
        query
          .split("")
          .map((char) => `(?=.*${char})`)
          .join(""),
        "i"
      ); // Case-insensitive regex
      notes = await Note.find({
        $or: [{ title: { $regex: regex } }, { content: { $regex: regex } }],
        isArchived: false,
        $and: [{ $or: [{ creator: userId }, { "sharedWith.userId": userId }] }],
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
        .sort({ updatedAt: -1 }) // Sort by update date for regex search
        .lean();
    } else {
      // Perform a text search on title and content for longer queries
      notes = await Note.find({
        $text: { $search: query },
        isArchived: false,
        $or: [{ creator: userId }, { "sharedWith.userId": userId }],
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
        .sort({ score: { $meta: "textScore" }, updatedAt: -1 }) // Sort by relevance, then by update date
        .lean();
    }

    res.status(200).json(notes);
  } catch (err) {
    next(err);
  }
};
