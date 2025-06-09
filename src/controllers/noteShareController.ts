import { Response, NextFunction } from "express";
import Note, { IShare } from "../models/Note"; // Removed unused INote import
import UserModel, { IUser } from "../models/User";
import { AuthRequest } from "../middleware/authMiddleware";
import mongoose, { Types } from "mongoose";
import { io } from "../server";
import {
  PopulatedNote,
  shareNoteSchema,
  checkPermissions,
  getUserIdStringFromField,
} from "./noteUtils";

// Placeholder for a logger if you have one
const logger = {
  info: console.log,
  error: console.error,
  warn: console.warn,
};

// Placeholder for getSocketIdForUser if needed for more specific notifications
// const getSocketIdForUser = (userId: string): string | undefined => {
//   // Implementation to get socket ID for a user
//   return undefined;
// };

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

    // Only the owner or those with write permission can share/manage shares
    // Let's refine: typically only owner should add new people,
    // but people with write might be able to change roles of existing people (depends on desired logic)
    // For simplicity here, let's say 'write' permission is enough to modify shares.
    // A stricter rule would be 'owner' for adding/removing, 'write' for role changes of existing.
    // The original checkPermissions was used with "write" for updateNote, which is analogous.
    if (
      !checkPermissions(note as PopulatedNote, authenticatedUserId, "write")
    ) {
      res.status(403).json({
        message: "You do not have permission to manage sharing for this note",
      });
      return;
    }

    const { email, role } = value;

    if (email === req.user.email) {
      res
        .status(400)
        .json({ message: "You cannot share a note with yourself." });
      return;
    }

    const userToShareWith = await UserModel.findOne({ email });
    if (!userToShareWith) {
      res.status(404).json({ message: `User with email ${email} not found.` });
      return;
    }

    const userToShareWithId = userToShareWith._id as Types.ObjectId; // Explicitly cast to Types.ObjectId

    // Check if already shared with this user
    const existingShareIndex = note.sharedWith.findIndex(
      (s) =>
        getUserIdStringFromField(s.userId as Types.ObjectId | IUser) ===
        userToShareWithId.toString()
    );

    if (existingShareIndex > -1) {
      // User already in sharedWith, update their role
      note.sharedWith[existingShareIndex].role = role;
      logger.info(
        `[shareNote] Updated role for user ${userToShareWith.email} on note ${noteId} to ${role}`
      );
    } else {
      // Add new user to sharedWith
      const newShare: IShare = {
        // Explicitly type newShare as IShare
        userId: userToShareWithId, // Already Types.ObjectId
        email: userToShareWith.email,
        role,
      };
      note.sharedWith.push(newShare as any); // Cast to any to satisfy TypeScript due to population
      logger.info(
        `[shareNote] Shared note ${noteId} with user ${userToShareWith.email} with role ${role}`
      );
    }

    const savedNote = await note.save();

    // Populate for response and notification
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
      // Emit to the note's room
      io.to(noteId).emit("noteUpdated", populatedSavedNote);
      io.to(noteId).emit("noteShared", {
        noteId,
        sharedWithUser: {
          _id: userToShareWithId,
          email: userToShareWith.email,
          username: userToShareWith.username,
        },
        role,
      });

      // Emit to general list update
      io.emit("notesListUpdated", {
        action: "share", // Or "update" if more generic
        noteId: populatedSavedNote._id.toString(),
        // Include enough data for list updates
        title: populatedSavedNote.title,
        updatedAt: populatedSavedNote.updatedAt,
        creator: populatedSavedNote.creator,
        sharedWith: populatedSavedNote.sharedWith,
      });

      // Specific notification to the user being shared with
      const targetSocketId = getUserIdStringFromField(userToShareWithId); // userToShareWithId is now Types.ObjectId
      if (targetSocketId) {
        // io.to(targetSocketId).emit("sharedWithYou", populatedSavedNote);
        // Or a more generic notification system
      }
      io.to(userToShareWithId.toString()).emit("notification", {
        // userToShareWithId is Types.ObjectId
        type: "note_shared",
        message: `Note '${populatedSavedNote.title}' has been shared with you by ${req.user.username}.`,
        noteId: populatedSavedNote._id.toString(),
      });

      res.status(200).json(populatedSavedNote);
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
    const userIdToUnshare = req.params.userId; // ID of the user to remove from sharing

    if (!mongoose.Types.ObjectId.isValid(noteId)) {
      res.status(400).json({ message: "Invalid note ID" });
      return;
    }
    if (!mongoose.Types.ObjectId.isValid(userIdToUnshare)) {
      res.status(400).json({ message: "Invalid user ID to unshare" });
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
    const noteCreatorId = getUserIdStringFromField(
      note.creator as Types.ObjectId | IUser
    );

    // Permission check:
    // 1. The note owner can unshare from anyone.
    // 2. A user can unshare themselves (if they are `userIdToUnshare`).
    // 3. Users with 'write' permission (who are not the owner) generally shouldn't be able to unshare others,
    //    unless specific business logic allows it. For now, only owner or self-unshare.

    let canUnshare = false;
    if (noteCreatorId === authenticatedUserId) {
      canUnshare = true; // Owner can unshare anyone
    } else if (userIdToUnshare === authenticatedUserId) {
      canUnshare = true; // User can unshare themselves
    }

    if (!canUnshare) {
      // Fallback to check general 'write' permission if not owner or self-unsharing,
      // though this might be too permissive for unsharing *others*.
      // The original logic used 'write' for general share management.
      // Let's stick to owner or self-unshare for removing someone.
      // If general 'write' permission should allow unsharing others, then use:
      // if (!checkPermissions(note as PopulatedNote, authenticatedUserId, "write")) { ... }
      res.status(403).json({
        message:
          "You do not have permission to unshare this user from the note.",
      });
      return;
    }

    const shareIndex = note.sharedWith.findIndex(
      (s) =>
        getUserIdStringFromField(s.userId as Types.ObjectId | IUser) ===
        userIdToUnshare
    );

    if (shareIndex === -1) {
      res
        .status(404)
        .json({ message: "User not found in the share list of this note." });
      return;
    }

    // const unsharedUser = note.sharedWith[shareIndex]; // Removed unused variable
    note.sharedWith.splice(shareIndex, 1);
    const savedNote = await note.save();

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
      io.to(noteId).emit("noteUnshared", {
        noteId,
        unsharedUserId: userIdToUnshare,
      });

      io.emit("notesListUpdated", {
        action: "unshare", // Or "update"
        noteId: populatedSavedNote._id.toString(),
        title: populatedSavedNote.title,
        updatedAt: populatedSavedNote.updatedAt,
        creator: populatedSavedNote.creator,
        sharedWith: populatedSavedNote.sharedWith,
      });

      // Notify the unshared user
      io.to(userIdToUnshare).emit("notification", {
        type: "note_unshared",
        message: `You are no longer a collaborator on note '${populatedSavedNote.title}'.`,
        noteId: populatedSavedNote._id.toString(),
      });

      res.status(200).json(populatedSavedNote);
    } else {
      res
        .status(500)
        .json({ message: "Failed to retrieve note after unsharing." });
    }
  } catch (err) {
    next(err);
  }
};
