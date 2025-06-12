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

    const userToShareWithId = userToShareWith._id;

    const existingShareIndex = note.sharedWith.findIndex((s) => {
      return s.userId && s.userId._id && s.userId._id.equals(userToShareWithId);
    });

    const isUpdatingExistingShare = existingShareIndex > -1;

    if (isUpdatingExistingShare) {
      note.sharedWith[existingShareIndex].role = role;
      logger.info(
        `[shareNote] Updated role for user ${userToShareWith.email} on note ${noteId} to ${role}`
      );
    } else {
      const newShare: IShare = {
        userId: userToShareWithId,
        email: userToShareWith.email,
        role,
      };
      note.sharedWith.push(newShare as any);
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
      const sharerUsername = req.user.username;
      const noteTitle = populatedSavedNote.title;

      if (isUpdatingExistingShare) {
        // Notify the user whose role was updated
        io.to(userToShareWithId.toString()).emit("noteSharingUpdated", {
          note: populatedSavedNote.toObject(),
          message: `Your role for note '${noteTitle}' was updated to '${role}' by ${sharerUsername}.`,
          actor: "other",
        });
        logger.info(
          `Emitted 'noteSharingUpdated' (role update) to user ${userToShareWithId.toString()} for note ${noteId}`
        );

        // REMOVED: Loop that notified other collaborators with 'noteSharingUpdated'
        // Their UIs will rely on 'noteDetailsUpdated' for silent refresh if the note is open,
        // and 'notesListGlobalUpdate' (without a message) for list refreshes.
      } else {
        // This is a new share
        // Notify the newly shared user
        const newSharedNotePayload = {
          _id: populatedSavedNote._id.toString(),
          title: populatedSavedNote.title,
          content: populatedSavedNote.content,
          creator: {
            _id: (populatedSavedNote.creator as IUser)._id.toString(),
            username: (populatedSavedNote.creator as IUser).username,
            email: (populatedSavedNote.creator as IUser).email,
          },
          sharedWith: populatedSavedNote.sharedWith.map((sw) => ({
            userId:
              typeof sw.userId === "string"
                ? sw.userId
                : {
                    _id: (sw.userId as IUser)._id.toString(),
                    username: (sw.userId as IUser).username,
                    email: (sw.userId as IUser).email,
                  },
            role: sw.role,
            email: sw.email,
          })),
          isArchived: populatedSavedNote.isArchived,
          updatedAt: populatedSavedNote.updatedAt.toISOString(),
          sharerUsername: sharerUsername,
        };
        io.to(userToShareWithId.toString()).emit(
          "newSharedNote",
          newSharedNotePayload
        );
        logger.info(
          `Emitted 'newSharedNote' to user ${userToShareWithId.toString()} for note ${populatedSavedNote._id.toString()} by sharer ${sharerUsername}.`
        );
      }

      // Notify the owner (sharer) - this happens for both new share and role update
      io.to(req.user._id.toString()).emit("noteSharingUpdated", {
        note: populatedSavedNote.toObject(),
        message: isUpdatingExistingShare
          ? `You updated ${userToShareWith.username}'s role to '${role}' for note '${noteTitle}'.`
          : `You shared '${noteTitle}' with ${userToShareWith.email}.`,
        actor: "self",
      });
      logger.info(
        `Emitted 'noteSharingUpdated' (self) to owner ${req.user._id.toString()} for note ${populatedSavedNote._id.toString()}`
      );

      // Emit to the general note room for UI updates (e.g., collaborator list)
      io.to(noteId).emit("noteDetailsUpdated", populatedSavedNote.toObject());
      logger.info(`Emitted 'noteDetailsUpdated' to room ${noteId}`);

      // Emit a global list update for dashboard/list views
      io.emit("notesListGlobalUpdate", {
        action: "share_update",
        noteId: populatedSavedNote._id.toString(),
        updatedNote: populatedSavedNote.toObject(), // Keep sending updatedNote for frontend checks
        actorId: req.user._id.toString(),
        // Ensure no specific message is sent here for role updates to avoid duplicate/confusing notifications
        // message: isUpdatingExistingShare ? undefined : `A note's sharing status was updated.`
        // Let's rely on the frontend to not generate a default message for 'share_update' if no message is provided.
      });
      logger.info(
        `Emitted 'notesListGlobalUpdate' (action: share_update) for note ${noteId}`
      );

      res.status(200).json(populatedSavedNote);
    } else {
      logger.error(
        "[shareNote] Failed to populate note after saving share or missing critical data."
      );
      res.status(500).json({
        message: "Failed to process share operation due to server error.",
      });
    }
  } catch (error) {
    logger.error(`[shareNote] Error sharing note ${req.params.id}:`, error);
    next(error);
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
        path: "sharedWith.userId", // Populate userId within sharedWith
        select: "username email _id",
      });

    if (!note || !note._id) {
      // Check note and note._id
      res.status(404).json({ message: "Note not found" });
      return;
    }

    if (!note.creator || !note.creator._id) {
      // Check creator and creator._id
      logger.error(
        `[unshareNote] Note ${noteId} found, but creator information is missing or invalid.`
      );
      res
        .status(500)
        .json({ message: "Note creator information is missing or invalid." });
      return;
    }
    const authenticatedUserId = req.user._id; // This is Types.ObjectId

    if (!note.creator._id.equals(authenticatedUserId)) {
      // Compare ObjectIds
      res
        .status(403)
        .json({ message: "You do not have permission to unshare this note" });
      return;
    }

    const initialSharedWithCount = note.sharedWith.length;

    // Before filtering, ensure the user to unshare was actually in the list
    const userWasInList = note.sharedWith.some(
      (s) =>
        s.userId && s.userId._id && s.userId._id.equals(userToUnshareObjectId)
    );

    if (!userWasInList) {
      res
        .status(404)
        .json({ message: "User not found in the shared list of this note." });
      return;
    }

    note.sharedWith = note.sharedWith.filter((s) => {
      // s.userId is populated as IUser, so s.userId._id is the ObjectId
      return !(
        s.userId &&
        s.userId._id &&
        s.userId._id.equals(userToUnshareObjectId)
      );
    });

    // This check might be redundant if the userWasInList check is sufficient,
    // but can be a safeguard if the filter logic had an unexpected issue.
    if (note.sharedWith.length === initialSharedWithCount) {
      // This case should ideally not be reached if userWasInList was true and filter is correct
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

    const populatedNoteAfterUnshare = (await Note.findById(savedNote._id) // savedNote._id is Types.ObjectId
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

      // Notify the user who was unshared
      io.to(unsharedUserObjectIdString).emit("noteUnshared", {
        noteId: populatedNoteAfterUnshare._id.toString(),
        title: populatedNoteAfterUnshare.title,
        unsharerUsername: req.user!.username,
        message: `You were unshared from the note '${
          populatedNoteAfterUnshare.title
        }' by ${req.user!.username}.`,
      });
      logger.info(
        `Emitted 'noteUnshared' to user ${unsharedUserObjectIdString} for note ${populatedNoteAfterUnshare._id.toString()} by unsharer ${
          req.user!.username
        }`
      );

      // Notify the note owner (unsharer)
      io.to(req.user!._id.toString()).emit("noteSharingUpdated", {
        note: populatedNoteAfterUnshare.toObject(),
        message: `You unshared '${populatedNoteAfterUnshare.title}' from ${unsharedUserEmail}.`,
        actor: "self",
      });
      logger.info(
        `Emitted 'noteSharingUpdated' to unsharer (owner) ${req.user._id.toString()} for note ${populatedNoteAfterUnshare._id.toString()}`
      );

      // REMOVE notification to remaining collaborators about who was unshared.
      // They will receive 'noteDetailsUpdated' to refresh their view if the note is open.
      // populatedNoteAfterUnshare.sharedWith.forEach((share) => {
      //   if (share.userId && share.userId._id) {
      //     const collaboratorIdStr = share.userId._id.toString();
      //     io.to(collaboratorIdStr).emit("noteSharingUpdated", {
      //       note: populatedNoteAfterUnshare.toObject(),
      //       // NO message or a very generic one if absolutely necessary for some UI update,
      //       // but ideally, no direct notification about *who* was removed.
      //       actor: "other",
      //       actionType: "unshare_others_view"
      //     });
      //     logger.info(
      //       `Emitted \'noteSharingUpdated\' (unshare_others_view) to remaining collaborator ${collaboratorIdStr} for note ${populatedNoteAfterUnshare._id!.toString()} after unshare by ${
      //         req.user!.username
      //       }`
      //     );
      //   }
      // });

      // Emit to the general note room for UI updates (e.g., collaborator list in NoteEditor)
      io.to(noteId).emit(
        "noteDetailsUpdated",
        populatedNoteAfterUnshare.toObject()
      );
      logger.info(
        `Emitted 'noteDetailsUpdated' to room ${noteId} after unshare.`
      );

      // General event for lists
      io.emit("notesListGlobalUpdate", {
        action: "unshare_update",
        noteId: populatedNoteAfterUnshare._id.toString(),
        removedUserId: unsharedUserObjectIdString,
        updatedNote: populatedNoteAfterUnshare.toObject(),
        actorId: req.user!._id.toString(),
        // message: `${req.user!.username} unshared note \'${
        //   populatedNoteAfterUnshare.title
        // }\' from ${unsharedUserEmail}.`, // Message removed to prevent duplicate notifications for collaborators
      });
      logger.info(
        `Emitted 'notesListGlobalUpdate' due to unshare action on note ${populatedNoteAfterUnshare._id.toString()}`
      );

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
    next(err);
  }
};
