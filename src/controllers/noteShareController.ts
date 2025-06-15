import { Response, NextFunction } from "express";
import Note, { IShare } from "../models/Note"; // INote is defined in Note.ts
import UserModel, { IUser } from "../models/User";
import { AuthRequest } from "../middleware/authMiddleware";
import mongoose, { Types } from "mongoose";
import { io } from "../server";
import { PopulatedNote, shareNoteSchema, checkPermissions } from "./noteUtils";

const logger = {
  info: console.log,
  error: console.error,
  warn: console.warn,
};

export const shareNote = async (
  req: AuthRequest,
  res: Response,
  _next: NextFunction // Changed next to _next
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
    if (!userToShareWith || !userToShareWith._id) {
      res.status(404).json({ message: `User with email ${email} not found.` });
      return;
    }

    const userToShareWithId = userToShareWith._id; // This is Types.ObjectId

    const existingShareIndex = note.sharedWith.findIndex((s) => {
      // s.userId is populated IUser, so s.userId._id is the ObjectId
      return (
        s.userId &&
        (s.userId as IUser)._id &&
        String((s.userId as IUser)._id) === String(userToShareWithId)
      );
    });

    let wasNewShare = false; // Flag to indicate if a new user was added

    if (existingShareIndex > -1) {
      note.sharedWith[existingShareIndex].role = role;
      logger.info(
        `[shareNote] Updated role for user ${userToShareWith.email} on note ${noteId} to ${role}`
      );
    } else {
      wasNewShare = true; // Set flag as this is a new share
      const newShare: IShare = {
        userId: userToShareWithId as Types.ObjectId, // Ensure TS treats this as ObjectId
        email: userToShareWith.email,
        role,
      };
      note.sharedWith.push(newShare as any); // 'as any' might be needed if populated type clashes
      logger.info(
        `[shareNote] Shared note ${noteId} with user ${userToShareWith.email} with role ${role}`
      );
    }

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

    if (
      populatedSavedNote &&
      populatedSavedNote._id &&
      req.user &&
      userToShareWith
    ) {
      const userToShareWithIdString = userToShareWith._id.toString();
      const ownerIdString = req.user._id.toString();

      // Prepare a common payload structure for note details
      const noteDetailsPayload = {
        _id: populatedSavedNote._id.toString(),
        title: populatedSavedNote.title,
        content: populatedSavedNote.content, // Consider if full content is always needed for all events
        creator: {
          _id: (populatedSavedNote.creator as IUser)?._id?.toString() || "",
          username:
            (populatedSavedNote.creator as IUser)?.username || "Unknown",
          email: (populatedSavedNote.creator as IUser)?.email || "",
        },
        sharedWith: populatedSavedNote.sharedWith.map((sw) => ({
          userId:
            typeof sw.userId === "string"
              ? sw.userId
              : {
                  _id: (sw.userId as IUser)?._id?.toString() || "",
                  username: (sw.userId as IUser)?.username || "Unknown",
                  email: (sw.userId as IUser)?.email || "",
                },
          role: sw.role,
          email: sw.email,
        })),
        isArchived: populatedSavedNote.isArchived,
        updatedAt: populatedSavedNote.updatedAt.toISOString(),
      };

      // 1. Notify the user involved in the share/update action
      if (wasNewShare) {
        // This is a new share: Notify the recipient
        const sharerUsername = req.user.username || "Someone"; // Fallback for username
        const newSharedNoteData = {
          ...noteDetailsPayload,
          roleYouWereGiven: role, // The role they were just given
          sharerUsername: sharerUsername,
          message: `${sharerUsername} shared the note '${populatedSavedNote.title}' with you with '${role}' role.`,
        };
        logger.info(
          `[shareNote] Attempting to emit 'newSharedNote' to user room: ${userToShareWithIdString} for note ${populatedSavedNote._id.toString()}`
        );
        io.to(userToShareWithIdString).emit("newSharedNote", newSharedNoteData);
        logger.info(
          `Emitted 'newSharedNote' to user ${userToShareWithIdString} for note ${populatedSavedNote._id.toString()} by sharer ${sharerUsername}.`
        );
      } else {
        // This is an update to an existing share: Notify the user whose role was changed
        const updaterUsername = req.user.username || "Someone"; // Fallback for username
        const roleUpdateData = {
          ...noteDetailsPayload,
          yourNewRole: role, // The new role for the recipient
          updaterUsername: updaterUsername,
          message: `Your role for the note '${populatedSavedNote.title}' was updated to '${role}' by ${updaterUsername}.`,
        };
        logger.info(
          `[shareNote] Attempting to emit 'yourShareRoleUpdated' to user room: ${userToShareWithIdString} for note ${populatedSavedNote._id.toString()}`
        );
        io.to(userToShareWithIdString).emit(
          "yourShareRoleUpdated",
          roleUpdateData
        );
        logger.info(
          `Emitted 'yourShareRoleUpdated' to user ${userToShareWithIdString} for note ${populatedSavedNote._id.toString()} by updater ${updaterUsername}`
        );
      }

      // 2. Notify the NOTE OWNER (SHARER/UPDATER) - for toast message
      if (ownerIdString !== userToShareWithIdString) {
        // Avoid self-notification if owner somehow changes their own share record via this flow
        io.to(ownerIdString).emit("noteSharingConfirmation", {
          note: noteDetailsPayload, // Send consistent note details
          message: wasNewShare
            ? `You shared '${populatedSavedNote.title}' with ${userToShareWith.email} (role: ${role}).`
            : `You updated ${userToShareWith.email}'s role for '${populatedSavedNote.title}' to '${role}'.`,
          recipientEmail: userToShareWith.email,
          sharedNoteId: populatedSavedNote._id.toString(),
          newRole: role,
          actionType: wasNewShare ? "share" : "update_role",
        });
        logger.info(
          `Emitted 'noteSharingConfirmation' to owner ${ownerIdString} for note ${populatedSavedNote._id.toString()}`
        );
      }

      // No general "noteSharingUpdated" event is emitted to other collaborators
      // to prevent notifications when they are not directly involved.
    }

    res.status(200).json(populatedSavedNote);
  } catch (err) {
    _next(err); // Changed next to _next
  }
};

export const unshareNote = async (
  req: AuthRequest,
  res: Response,
  _next: NextFunction // Changed next to _next
): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      res
        .status(401)
        .json({ message: "User not authenticated or user ID missing" });
      return;
    }

    const noteId = req.params.id;
    const userIdToUnshareString = req.params.userId;

    if (!mongoose.Types.ObjectId.isValid(noteId)) {
      res.status(400).json({ message: "Invalid note ID" });
      return;
    }
    if (!mongoose.Types.ObjectId.isValid(userIdToUnshareString)) {
      res.status(400).json({ message: "Invalid user ID to unshare" });
      return;
    }

    const userToUnshareObjectId = new Types.ObjectId(userIdToUnshareString);

    const note = await Note.findById(noteId)
      .populate<{ creator: IUser }>("creator", "username email _id")
      .populate<{
        sharedWith: Array<{ userId: IUser; role: string; email: string }>;
      }>({
        path: "sharedWith.userId",
        select: "username email _id",
      });

    if (!note || !note._id) {
      res.status(404).json({ message: "Note not found" });
      return;
    }

    if (!note.creator || !(note.creator as IUser)._id) {
      logger.error(
        `[unshareNote] Note ${noteId} found, but creator information is missing or invalid.`
      );
      res
        .status(500)
        .json({ message: "Note creator information is missing or invalid." });
      return;
    }
    const authenticatedUserId = req.user._id;

    if (String((note.creator as IUser)._id) !== String(authenticatedUserId)) {
      res
        .status(403)
        .json({ message: "You do not have permission to unshare this note" });
      return;
    }

    const initialSharedWithCount = note.sharedWith.length;

    const userWasInList = note.sharedWith.some(
      (
        s: any // Added type any to s for now, ideally should be IShare with populated IUser
      ) =>
        s.userId &&
        (s.userId as IUser)._id &&
        String((s.userId as IUser)._id) === String(userToUnshareObjectId)
    );

    if (!userWasInList) {
      res
        .status(404)
        .json({ message: "User not found in the shared list of this note." });
      return;
    }

    note.sharedWith = note.sharedWith.filter((s: any) => {
      // Added type any to s
      return !(
        s.userId &&
        (s.userId as IUser)._id &&
        String((s.userId as IUser)._id) === String(userToUnshareObjectId)
      );
    });

    if (note.sharedWith.length === initialSharedWithCount && userWasInList) {
      logger.warn(
        `[unshareNote] User ${userIdToUnshareString} was in shared list for note ${noteId}, but filter did not remove. This indicates an issue.`
      );
      res.status(400).json({
        message:
          "User found in shared list, but failed to unshare. Please try again.",
      });
      return;
    }

    const savedNote = await note.save();

    const populatedNoteAfterUnshare = (await Note.findById(savedNote._id)
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

    if (populatedNoteAfterUnshare && populatedNoteAfterUnshare._id) {
      const unsharedUserObjectIdString = userIdToUnshareString;
      const unsharedUserDetails = await UserModel.findById(
        unsharedUserObjectIdString
      )
        .select("email username")
        .lean();
      const unsharedUserEmail = unsharedUserDetails
        ? unsharedUserDetails.email
        : "the user";

      // 1. Notify ONLY the user who was unshared
      io.to(unsharedUserObjectIdString).emit("noteUnshared", {
        noteId: populatedNoteAfterUnshare._id.toString(),
        title: populatedNoteAfterUnshare.title,
        unsharerUsername: req.user!.username,
        message: `You were unshared from the note '${
          populatedNoteAfterUnshare.title
        }' by ${req.user!.username}. Access removed.`, // Corrected template literal
      });
      logger.info(
        `Emitted 'noteUnshared' to user ${unsharedUserObjectIdString} for note ${populatedNoteAfterUnshare._id.toString()} by unsharer ${
          req.user!.username
        }` // Corrected template literal
      );

      // 2. Notify ONLY the note owner (unsharer) - for their confirmation toast
      io.to(req.user!._id.toString()).emit("noteSharingConfirmation", {
        note: populatedNoteAfterUnshare.toObject(), // Send lean object
        message: `You unshared '${populatedNoteAfterUnshare.title}' from ${unsharedUserEmail}.`, // Corrected template literal
        actionType: "unshare",
        unsharedUserEmail: unsharedUserEmail,
        sharedNoteId: populatedNoteAfterUnshare._id.toString(),
      });
      logger.info(
        `Emitted 'noteSharingConfirmation' to unsharer (owner) ${req.user._id.toString()} for note ${populatedNoteAfterUnshare._id.toString()}` // Corrected template literal
      );

      // REMOVED notifications to other collaborators
      // REMOVED io.to(noteId).emit("noteDetailsUpdated", ...);
      // REMOVED io.emit("notesListGlobalUpdate", ...);
      // This is to ensure other users are not notified about this specific unshare action.
      // Their lists will update upon next general fetch or if another mechanism is in place.

      res.status(200).json({
        message: "User unshared successfully.",
        note: populatedNoteAfterUnshare,
      });
    } else {
      res
        .status(500)
        .json({ message: "Failed to retrieve note after unsharing." });
    }
  } catch (err) {
    _next(err); // Changed next to _next
  }
};
