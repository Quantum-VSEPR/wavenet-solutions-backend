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
    console.log(
      `[updateNote] Request to update note ID: ${req.params.id} by user: ${req.user?._id}`
    );
    console.log(`[updateNote] Request body:`, req.body);

    const { error, value } = updateNoteSchema.validate(req.body); // Joi validation
    if (error) {
      console.error("[updateNote] Validation error:", error.details[0].message);
      res.status(400).json({ message: error.details[0].message });
      return;
    }
    console.log("[updateNote] Validated request value:", value);

    if (!req.user || !req.user._id) {
      console.error("[updateNote] User not authenticated");
      res.status(401).json({ message: "User not authenticated" });
      return;
    }

    const noteId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(noteId)) {
      console.error("[updateNote] Invalid note ID:", noteId);
      res.status(400).json({ message: "Invalid note ID" });
      return;
    }

    const note = await Note.findById(noteId);

    if (!note) {
      console.error("[updateNote] Note not found:", noteId);
      res.status(404).json({ message: "Note not found" });
      return;
    }
    console.log(
      "[updateNote] Found note. Original title:",
      note.title,
      "Original content snippet:",
      note.content.substring(0, 50) + "..."
    );

    const hasEditPermission = checkPermissions(
      note,
      req.user._id.toString(),
      "write"
    );

    if (!hasEditPermission) {
      console.error(
        "[updateNote] Permission denied for user:",
        req.user._id,
        "on note:",
        noteId
      );
      res.status(403).json({ message: "Not authorized to update this note" });
      return;
    }

    if (note.isArchived) {
      console.warn("[updateNote] Attempt to edit archived note:", noteId);
      res.status(400).json({ message: "Archived notes cannot be edited." });
      return;
    }

    const originalTitle = note.title;
    const originalContent = note.content; // Schema default: ''

    // value.title and value.content are from Joi validation.
    // Joi schema for updateNoteSchema:
    // title: Joi.string().trim().max(100).optional()
    // content: Joi.string().trim().allow('').optional()
    // This means value.title and value.content are already trimmed if they were provided as strings.
    // They will be undefined if not present in the request payload.

    let titleActuallyChanged = false;
    // If value.title is provided in the request and it's different from the original DB title,
    // then it's a change. The note's title will be updated with the Joi-processed value.
    if (value.title !== undefined && value.title !== originalTitle) {
      note.title = value.title;
      titleActuallyChanged = true;
    }

    let contentActuallyChanged = false;
    // If value.content is provided in the request and it's different from the original DB content,
    // then it's a change. The note's content will be updated with the Joi-processed value.
    if (value.content !== undefined && value.content !== originalContent) {
      note.content = value.content;
      contentActuallyChanged = true;
    }

    const overallHasChanges = titleActuallyChanged || contentActuallyChanged;
    console.log(
      `[updateNote] Change detection: titleActuallyChanged=${titleActuallyChanged}, contentActuallyChanged=${contentActuallyChanged}, overallHasChanges=${overallHasChanges}`
    );

    if (!overallHasChanges) {
      console.log(
        "[updateNote] No substantive changes detected. Returning current note data."
      );
      // No substantive changes to title or content that require saving or notification.
      // Fetch the note again to ensure the response is populated correctly,
      // as the frontend might expect a fully populated note object.
      const populatedUnchangedNote = await Note.findById(noteId)
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

      res.status(200).json(populatedUnchangedNote);
      return;
    }

    console.log(
      "[updateNote] Substantive changes detected. Proceeding with save."
    );
    // If overallHasChanges is true, note.title and/or note.content have been updated in the 'note' object.
    // note.updatedAt will be updated automatically by Mongoose timestamps due to the upcoming save operation.
    const updatedNote = await note.save();
    console.log(
      "[updateNote] Note saved. New updatedAt:",
      updatedNote.updatedAt
    );

    const populatedNote = await Note.findById(updatedNote._id)
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

    if (!populatedNote) {
      console.error(
        "[updateNote] Updated note not found after population:",
        updatedNote._id
      );
      res
        .status(404)
        .json({ message: "Updated note not found after population" });
      return;
    }

    // Emit event to other users in the room (note ID)
    const eventPayload = {
      noteId: populatedNote._id.toString(),
      noteTitle: populatedNote.title,
      editorUsername: (req.user as any).username,
      editorId: req.user._id.toString(),
      isArchived: populatedNote.isArchived,
      titleChanged: titleActuallyChanged,
      contentChanged: contentActuallyChanged,
      content: contentActuallyChanged ? populatedNote.content : undefined, // Send content only if it actually changed
      updatedAt: populatedNote.updatedAt.toISOString(), // Send the latest timestamp
    };
    console.log(
      "[updateNote] Emitting 'noteEditFinishedByOtherUser' to room:",
      noteId.toString(),
      "with payload:",
      eventPayload
    );
    io.to(noteId.toString()).emit("noteEditFinishedByOtherUser", eventPayload);

    // Emit global list update if title actually changed
    if (titleActuallyChanged) {
      const listUpdatePayload = {
        event: "note_title_updated",
        action: "update",
        noteId: populatedNote._id.toString(),
        noteTitle: populatedNote.title,
        originalTitle: originalTitle,
        updatedAt: populatedNote.updatedAt.toISOString(), // Consistent string format
        actorId: req.user._id.toString(),
      };
      console.log(
        "[updateNote] Emitting 'notesListGlobalUpdate' for title change with payload:",
        listUpdatePayload
      );
      io.emit("notesListGlobalUpdate", listUpdatePayload);
    }

    res.status(200).json(populatedNote);
  } catch (err) {
    console.error("[updateNote] Error in updateNote:", err);
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
      .populate<{ creator: IUser }>("creator", "_id username") // Added username for notification
      .populate<{
        sharedWith: Array<{ userId: Pick<IUser, "_id">; role: string }>;
      }>({
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

    const noteTitleForNotification = note.title; // Store before deletion
    const noteCreatorForNotification = {
      _id: getUserIdStringFromField(note.creator),
      username: (note.creator as IUser)?.username || "Unknown User",
    };
    const noteUpdatedAtForNotification = note.updatedAt
      ? new Date(note.updatedAt).toISOString()
      : new Date().toISOString();

    await Note.findByIdAndDelete(noteId);

    io.to(noteId).emit("noteDeleted", { noteId }); // Notify clients viewing this specific note

    io.emit("notesListUpdated", {
      action: "delete",
      note: {
        _id: noteId,
        title: noteTitleForNotification,
        creator: noteCreatorForNotification,
        sharedWith: [],
        updatedAt: noteUpdatedAtForNotification,
      },
      actorId: req.user._id.toString(),
    });

    res.status(200).json({ message: "Note deleted successfully" });
  } catch (err) {
    next(err);
  }
};
