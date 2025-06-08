import { Response, NextFunction } from "express";
import Joi from "joi";
import Note, { INote, IShare } from "../models/Note";
import UserModel, { IUser } from "../models/User";
import { AuthRequest } from "../middleware/authMiddleware";
import mongoose, { Types, Document } from "mongoose";
import { io } from "../server";

// Helper type for a Mongoose document that is an INote and also a Document
type INoteDocument = INote & Document;

// Helper type for a note document where creator and sharedWith.userId are populated
type PopulatedNote = Omit<INoteDocument, "creator" | "sharedWith"> & {
  _id: Types.ObjectId;
  creator: IUser;
  sharedWith: Array<Omit<IShare, "userId"> & { userId: IUser }>;
};

// Joi schema for creating a note
const createNoteSchema = Joi.object({
  title: Joi.string().required(),
  content: Joi.string().allow(""),
});

// Joi schema for updating a note
const updateNoteSchema = Joi.object({
  title: Joi.string().optional(),
  content: Joi.string().allow("").optional(),
});

// Joi schema for sharing a note
const shareNoteSchema = Joi.object({
  email: Joi.string().email().required(),
  role: Joi.string().valid("read", "write").required(),
});

// Helper function to safely extract a user ID string from various field types
const getUserIdStringFromField = (
  field: Types.ObjectId | IUser | string | null | undefined
): string | null => {
  if (!field) return null;

  if (field instanceof mongoose.Types.ObjectId) {
    return field.toString();
  }
  // Check if it's a string representation of ObjectId
  if (typeof field === "string") {
    return mongoose.Types.ObjectId.isValid(field) ? field : null;
  }
  // Check if it's a populated IUser-like object (must be an object and have _id)
  if (typeof field === "object" && "_id" in field && field._id) {
    const idSource = field._id; // idSource is Types.ObjectId | string (from IUser._id) or from any object with _id
    if (idSource instanceof mongoose.Types.ObjectId) {
      return idSource.toString();
    }
    if (
      typeof idSource === "string" &&
      mongoose.Types.ObjectId.isValid(idSource)
    ) {
      return idSource;
    }
  }
  return null;
};

// Helper function to check permissions
const checkPermissions = (
  note: INote | PopulatedNote, // Accept either INote or PopulatedNote
  authenticatedUserId: string,
  requiredRole: "read" | "write" | "owner"
): boolean => {
  console.log(`[checkPermissions] --- Start ---`);
  console.log(
    `[checkPermissions] Authenticated User ID (param): '${authenticatedUserId}', Type: ${typeof authenticatedUserId}`
  );
  console.log(`[checkPermissions] Required Role: '${requiredRole}'`);
  // console.log(`[checkPermissions] Note Object (raw):`, JSON.stringify(note, null, 2)); // Can be very verbose

  // note.creator can be Types.ObjectId (from INote) or IUser (from PopulatedNote)
  const noteCreator = note.creator as Types.ObjectId | IUser;
  console.log(
    `[checkPermissions] Raw Note Creator Field:`,
    noteCreator,
    `, Type: ${typeof noteCreator}`
  );

  const noteCreatorIdString = getUserIdStringFromField(noteCreator);

  if (!noteCreatorIdString) {
    console.error(
      "[checkPermissions] Critical: Could not extract valid note creator ID from:",
      noteCreator
    );
    console.log(
      `[checkPermissions] --- End (Failure - Invalid creator ID) ---`
    );
    return false;
  }
  console.log(
    `[checkPermissions] Extracted Note Creator ID: '${noteCreatorIdString}', Type: ${typeof noteCreatorIdString}`
  );

  if (noteCreatorIdString === authenticatedUserId) {
    console.log(
      "[checkPermissions] SUCCESS: Authenticated user IS the note creator. Permission granted."
    );
    console.log(`[checkPermissions] --- End (Success - Creator) ---`);
    return true;
  }
  console.log(
    `[checkPermissions] DEBUG: Creator ID ('${noteCreatorIdString}') !== Authenticated User ID ('${authenticatedUserId}'). Proceeding to check sharedWith...`
  );

  if (requiredRole === "owner") {
    console.log(
      "[checkPermissions] FAILURE: 'owner' role required, but user is not the creator. Permission denied."
    );
    console.log(`[checkPermissions] --- End (Failure - Owner check) ---`);
    return false;
  }

  console.log(
    "[checkPermissions] INFO: Authenticated user is NOT the note creator. Checking sharedWith array..."
  );
  // note.sharedWith elements' userId can be Types.ObjectId or IUser
  const shareInfo = note.sharedWith.find((shareEntry) => {
    // shareEntry type inferred
    const sharedUserField = (
      shareEntry as IShare | (Omit<IShare, "userId"> & { userId: IUser })
    ).userId;
    const sharedUserIdString = getUserIdStringFromField(
      sharedUserField as Types.ObjectId | IUser
    );

    if (!sharedUserIdString) {
      console.error(
        "[checkPermissions] Invalid or unextractable userId in sharedWith entry:",
        shareEntry.userId
      );
      return false; // Problem with this share entry, evaluate to false for find callback
    }
    // console.log(`[checkPermissions] Comparing Shared User: (Shared)'${sharedUserIdString}' === (User)'${authenticatedUserId}'`);
    return sharedUserIdString === authenticatedUserId;
  });

  if (!shareInfo) {
    console.log(
      "[checkPermissions] FAILURE: User not found in sharedWith array. Permission denied."
    );
    console.log(`[checkPermissions] --- End (Failure - Not in sharedWith) ---`);
    return false;
  }

  // shareInfo.role is "read" | "write" | "owner" from IShare schema.
  // For shared users, "owner" role implies full control like "write".
  console.log(
    `[checkPermissions] INFO: User found in sharedWith array with role: '${shareInfo.role}'.`
  );

  if (requiredRole === "read") {
    if (
      shareInfo.role === "read" ||
      shareInfo.role === "write" ||
      shareInfo.role === "owner"
    ) {
      console.log(
        "[checkPermissions] SUCCESS: 'read' permission granted via sharedWith array."
      );
      console.log(
        `[checkPermissions] --- End (Success - Read via sharedWith) ---`
      );
      return true;
    }
  }

  if (requiredRole === "write") {
    if (shareInfo.role === "write" || shareInfo.role === "owner") {
      console.log(
        "[checkPermissions] SUCCESS: 'write' permission granted via sharedWith array."
      );
      console.log(
        `[checkPermissions] --- End (Success - Write via sharedWith) ---`
      );
      return true;
    }
  }

  console.log(
    `[checkPermissions] FAILURE: User in sharedWith array, but role ('${shareInfo.role}') does not meet required role ('${requiredRole}'). Permission denied.`
  );
  console.log(
    `[checkPermissions] --- End (Failure - Role mismatch in sharedWith) ---`
  );
  return false;
};

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
      // Added check for req.user._id
      res
        .status(401)
        .json({ message: "User not authenticated or user ID missing" });
      return;
    }

    const { title, content } = value;
    const note: INote = await Note.create({
      title,
      content,
      creator: req.user._id as Types.ObjectId,
      sharedWith: [],
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
      console.error("[getMyNotes] User not authenticated or _id missing");
      res.status(401).json({
        message: "User not authenticated or user ID is missing",
      });
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
          email: string;
        }>;
      }>({
        path: "sharedWith.userId",
        select: "username email _id",
      })
      .lean(); // Use lean for potentially faster queries and plain JS objects

    const notesFromDb = await notesQuery;

    console.log(
      "[getMyNotes] Notes found (before shared check):",
      notesFromDb.length
    );

    // Augment notes to indicate if they are shared by the current user
    const augmentedNotes = notesFromDb.map((note) => {
      // A note is considered "shared by the current user" if they are the creator
      // AND the sharedWith array is not empty.
      const isSharedByCurrentUser =
        note.sharedWith && note.sharedWith.length > 0;
      return {
        ...note,
        isSharedByCurrentUser, // Add the new boolean flag
      };
    });

    const totalNotes = await Note.countDocuments({
      creator: userId,
      isArchived: false, // Exclude archived notes from count
    });
    console.log("[getMyNotes] Total notes for user:", totalNotes);

    res.status(200).json({
      notes: augmentedNotes, // Send augmented notes
      totalPages: Math.ceil(totalNotes / limit),
      currentPage: page,
      totalNotes,
    });
  } catch (err) {
    console.error("[getMyNotes] Error:", err);
    next(err);
  }
};

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
      console.error("[getArchivedNotes] User not authenticated or _id missing");
      res.status(401).json({
        message: "User not authenticated or user ID is missing",
      });
      return;
    }
    const userId = req.user._id as Types.ObjectId;

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;
    const sortBy = (req.query.sortBy as string) || "archivedAt"; // Default sort by archivedAt
    const sortOrderQuery = (req.query.sortOrder as string) || "desc";
    const sortOrder: 1 | -1 = sortOrderQuery === "asc" ? 1 : -1;

    const sortOptions: { [key: string]: 1 | -1 } = {};
    if (sortBy === "title") {
      sortOptions.title = sortOrder;
    } else if (sortBy === "createdAt") {
      sortOptions.createdAt = sortOrder;
    } else if (sortBy === "updatedAt") {
      sortOptions.updatedAt = sortOrder;
    } else {
      // Default to archivedAt
      sortOptions.archivedAt = sortOrder;
    }

    const notes = await Note.find({ creator: userId, isArchived: true })
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
      });

    console.log("[getArchivedNotes] Archived notes found:", notes.length);

    const totalNotes = await Note.countDocuments({
      creator: userId,
      isArchived: true,
    });
    console.log(
      "[getArchivedNotes] Total archived notes for user:",
      totalNotes
    );

    res.status(200).json({
      notes,
      totalPages: Math.ceil(totalNotes / limit),
      currentPage: page,
      totalNotes,
    });
  } catch (err) {
    console.error("[getArchivedNotes] Error:", err);
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
      isArchived: false, // Exclude archived notes
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
      });

    const totalNotes = await Note.countDocuments({
      "sharedWith.userId": req.user._id as Types.ObjectId,
      isArchived: false, // Exclude archived notes from count
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
      isArchived: false, // Exclude archived notes
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
      .sort({ updatedAt: -1 });

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
      .populate<{ sharedWith: Array<IShare & { userId: IUser }> }>({
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

    // Log creator ID safely
    const creatorIdForLog = getUserIdStringFromField(
      note.creator // creator is IUser due to PopulatedNote type
    );
    console.log(
      `[getNoteById] Note Creator ID (pre-check from field): ${creatorIdForLog}`
    );

    if (!checkPermissions(note, authenticatedUserId, "read")) {
      // No cast needed if checkPermissions accepts PopulatedNote
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

    const note = (await Note.findById(noteId)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{ sharedWith: Array<IShare & { userId: IUser }> }>({
        path: "sharedWith.userId",
        select: "username email _id",
      })) as PopulatedNote | null;

    if (!note) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    const authenticatedUserId = req.user._id.toString();

    if (!checkPermissions(note, authenticatedUserId, "write")) {
      // No cast needed
      res
        .status(403)
        .json({ message: "You do not have permission to edit this note" });
      return;
    }

    const { title, content } = value;
    if (title !== undefined) note.title = title;
    if (content !== undefined) note.content = content;

    const savedNote = await note.save();

    const populatedSavedNote = (await Note.findById(savedNote._id)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{ sharedWith: Array<IShare & { userId: IUser }> }>({
        path: "sharedWith.userId",
        select: "username email _id",
      })) as PopulatedNote | null;

    if (populatedSavedNote) {
      io.to(noteId).emit("noteUpdated", populatedSavedNote);
      io.emit("notesListUpdated", {
        noteId: populatedSavedNote._id.toString(),
        title: populatedSavedNote.title,
        updatedAt: populatedSavedNote.updatedAt,
        creator: populatedSavedNote.creator,
        sharedWith: populatedSavedNote.sharedWith,
      });
      res.status(200).json(populatedSavedNote);
    } else {
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

    const note = (await Note.findById(noteId)) as INoteDocument | null;

    if (!note) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    // For delete, only the creator can delete. note.creator is Types.ObjectId here.
    if (
      getUserIdStringFromField(note.creator as Types.ObjectId | IUser) !== // Explicit cast for clarity
      req.user._id.toString()
    ) {
      res
        .status(403)
        .json({ message: "You do not have permission to delete this note" });
      return;
    }

    await Note.findByIdAndDelete(noteId);

    io.to(noteId).emit("noteDeleted", { noteId });
    io.emit("notesListUpdated", { noteId, isDelete: true });

    res.status(200).json({ message: "Note deleted successfully" });
  } catch (err) {
    next(err);
  }
};

export const shareNote = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { error, value } = shareNoteSchema.validate(req.body);
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

    const { email, role } = value; // value is used now

    const noteToShare = (await Note.findById(noteId)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{ sharedWith: Array<IShare & { userId: IUser }> }>({
        path: "sharedWith.userId",
        select: "username email _id",
      })) as PopulatedNote | null;

    if (!noteToShare) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    const authenticatedUserId = req.user._id.toString();

    if (!checkPermissions(noteToShare, authenticatedUserId, "owner")) {
      // No cast needed
      res
        .status(403)
        .json({ message: "Only the owner can modify sharing permissions" });
      return;
    }

    const userToShareWith = (await UserModel.findOne({ email })) as
      | (IUser & Document & { _id: Types.ObjectId })
      | null;
    if (!userToShareWith) {
      res
        .status(404)
        .json({ message: `User to share with (email: ${email}) not found` });
      return;
    }
    const userToShareWithId = userToShareWith._id;

    if (userToShareWithId.toString() === authenticatedUserId) {
      res
        .status(400)
        .json({ message: "You cannot share a note with yourself" });
      return;
    }

    const existingShareIndex = noteToShare.sharedWith.findIndex(
      (
        s: Omit<IShare, "userId"> & { userId: IUser } // Explicitly type s
      ) => getUserIdStringFromField(s.userId) === userToShareWithId.toString()
    );

    if (existingShareIndex > -1) {
      noteToShare.sharedWith[existingShareIndex].role = role as
        | "read"
        | "write";
      noteToShare.sharedWith[existingShareIndex].email = userToShareWith.email;
    } else {
      noteToShare.sharedWith.push({
        userId: userToShareWithId as any, // Cast to any for Mongoose to handle ObjectId correctly
        role: role as "read" | "write",
        email: userToShareWith.email,
      });
    }

    const savedNote = await noteToShare.save();

    const populatedNote = (await Note.findById(savedNote._id)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{ sharedWith: Array<IShare & { userId: IUser }> }>({
        path: "sharedWith.userId",
        select: "username email _id",
      })) as PopulatedNote | null;

    if (populatedNote) {
      io.to(noteId).emit("noteShared", populatedNote);
      io.to(userToShareWithId.toString()).emit(
        "noteSharedWithYou",
        populatedNote
      );
      io.to(authenticatedUserId).emit("myNoteShareUpdated", populatedNote);
      io.emit("notesListUpdated", populatedNote);
      res.status(200).json(populatedNote);
    } else {
      res
        .status(500)
        .json({ message: "Failed to retrieve note after sharing." });
    }
  } catch (err) {
    next(err);
  }
};

export const unshareNote = async (
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
    const emailToUnshare = req.body.email;

    if (!mongoose.Types.ObjectId.isValid(noteId)) {
      res.status(400).json({ message: "Invalid note ID" });
      return;
    }
    if (!emailToUnshare || typeof emailToUnshare !== "string") {
      res.status(400).json({ message: "Email to unshare is required" });
      return;
    }

    const note = (await Note.findById(noteId)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{ sharedWith: Array<IShare & { userId: IUser }> }>({
        path: "sharedWith.userId",
        select: "username email _id",
      })) as PopulatedNote | null;

    if (!note) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    const authenticatedUserId = req.user._id.toString();

    if (!checkPermissions(note, authenticatedUserId, "owner")) {
      // No cast needed
      res
        .status(403)
        .json({ message: "Only the owner can modify sharing permissions" });
      return;
    }

    const userToUnshare = (await UserModel.findOne({
      email: emailToUnshare,
    })) as (IUser & Document & { _id: Types.ObjectId }) | null;
    if (!userToUnshare) {
      res
        .status(404)
        .json({ message: `User with email ${emailToUnshare} not found.` });
      return;
    }
    const userToUnshareIdString = userToUnshare._id.toString();

    const initialShareCount = note.sharedWith.length;
    note.sharedWith = note.sharedWith.filter(
      (
        s: Omit<IShare, "userId"> & { userId: IUser } // Explicitly type s
      ) => getUserIdStringFromField(s.userId) !== userToUnshareIdString
    );

    if (note.sharedWith.length === initialShareCount) {
      res
        .status(404)
        .json({ message: `Note was not shared with user ${emailToUnshare}` });
      return;
    }

    const savedNote = await note.save();

    const populatedNote = (await Note.findById(savedNote._id)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{ sharedWith: Array<IShare & { userId: IUser }> }>({
        path: "sharedWith.userId",
        select: "username email _id",
      })) as PopulatedNote | null;

    if (populatedNote) {
      io.to(noteId).emit("noteUnshared", {
        noteId,
        unsharedEmail: emailToUnshare,
        sharedWith: populatedNote.sharedWith,
      });
      io.to(userToUnshareIdString).emit("noteUnsharedWithYou", {
        noteId: populatedNote._id.toString(),
      });
      io.to(authenticatedUserId).emit("myNoteShareUpdated", populatedNote);
      io.emit("notesListUpdated", populatedNote);
      res.status(200).json(populatedNote);
    } else {
      res
        .status(500)
        .json({ message: "Failed to retrieve note after unsharing." });
    }
  } catch (err) {
    next(err);
  }
};

// Controller to archive a note
export const archiveNote = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const noteId = req.params.id;
    if (!req.user || !req.user._id) {
      res.status(401).json({ message: "User not authenticated" });
      return;
    }
    const authenticatedUserId = req.user._id.toString();

    const note = await Note.findById(noteId);

    if (!note) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    // Only the creator can archive the note
    if (note.creator.toString() !== authenticatedUserId) {
      res.status(403).json({
        message: "Permission denied: Only the owner can archive this note",
      });
      return;
    }

    if (note.isArchived) {
      res.status(400).json({ message: "Note is already archived" });
      return;
    }

    note.isArchived = true;
    note.archivedAt = new Date();
    await note.save();

    // Emit a socket event for real-time update if needed
    // io.to(note.creator.toString()).emit('noteArchived', note);
    // note.sharedWith.forEach(share => io.to(share.userId.toString()).emit('noteArchived', note));

    res.status(200).json(note);
  } catch (err) {
    next(err);
  }
};

// Controller to unarchive a note
export const unarchiveNote = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const noteId = req.params.id;
    if (!req.user || !req.user._id) {
      res.status(401).json({ message: "User not authenticated" });
      return;
    }
    const authenticatedUserId = req.user._id.toString();

    const note = await Note.findById(noteId);

    if (!note) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    // Only the creator can unarchive the note
    if (note.creator.toString() !== authenticatedUserId) {
      res.status(403).json({
        message: "Permission denied: Only the owner can unarchive this note",
      });
      return;
    }

    if (!note.isArchived) {
      res.status(400).json({ message: "Note is not archived" });
      return;
    }

    note.isArchived = false;
    note.archivedAt = undefined; // Remove the archivedAt date
    await note.save();

    // Emit a socket event for real-time update if needed
    // io.to(note.creator.toString()).emit('noteUnarchived', note);
    // note.sharedWith.forEach(share => io.to(share.userId.toString()).emit('noteUnarchived', note));

    res.status(200).json(note);
  } catch (err) {
    next(err);
  }
};
