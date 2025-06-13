import mongoose, { Types, Document } from "mongoose";
import Joi from "joi";
import { INote, IShare } from "../models/Note";
import { IUser } from "../models/User";

// Helper type for a Mongoose document that is an INote and also a Document
export type INoteDocument = INote & Document;

// Helper type for a note document where creator and sharedWith.userId are populated
export type PopulatedNote = Omit<INoteDocument, "creator" | "sharedWith"> & {
  _id: Types.ObjectId;
  creator: IUser; // Creator is populated
  sharedWith: Array<Omit<IShare, "userId"> & { userId: IUser }>; // sharedWith.userId is populated
};

// Joi schema for creating a note
export const createNoteSchema = Joi.object({
  title: Joi.string().required(),
  content: Joi.string().allow(""), // Allow empty content
});

// Joi schema for updating a note
export const updateNoteSchema = Joi.object({
  title: Joi.string().optional(),
  content: Joi.string().allow("").optional(),
  isAutoSave: Joi.boolean().optional(), // Allow isAutoSave field
});

// Joi schema for sharing a note
export const shareNoteSchema = Joi.object({
  email: Joi.string().email().required(),
  role: Joi.string().valid("read", "write").required(),
});

// Helper function to safely extract a user ID string from various field types
export const getUserIdStringFromField = (
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
    const idSource = field._id;
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
export const checkPermissions = (
  note: INote | PopulatedNote, // Accept either INote or PopulatedNote
  authenticatedUserId: string,
  requiredRole: "read" | "write" | "owner"
): boolean => {
  console.log(`[checkPermissions] --- Start ---`);
  console.log(
    `[checkPermissions] Authenticated User ID (param): '${authenticatedUserId}', Type: ${typeof authenticatedUserId}`
  );
  console.log(`[checkPermissions] Required Role: '${requiredRole}'`);

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
  const shareInfo = note.sharedWith.find((shareEntry) => {
    const sharedUserField = (
      shareEntry as IShare | (Omit<IShare, "userId"> & { userId: IUser })
    ).userId;
    const sharedUserIdString = getUserIdStringFromField(
      sharedUserField as Types.ObjectId | IUser
    );

    if (!sharedUserIdString) {
      console.warn(
        `[checkPermissions] Could not extract valid shared user ID from:`,
        sharedUserField,
        `in shareEntry:`,
        shareEntry
      );
      return false;
    }
    return sharedUserIdString === authenticatedUserId;
  });

  if (!shareInfo) {
    console.log(
      "[checkPermissions] FAILURE: User not found in sharedWith array. Permission denied."
    );
    console.log(`[checkPermissions] --- End (Failure - Not in sharedWith) ---`);
    return false;
  }

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
        "[checkPermissions] SUCCESS: User has sufficient 'read' (or higher) role. Permission granted."
      );
      console.log(`[checkPermissions] --- End (Success - Read role) ---`);
      return true;
    }
  }

  if (requiredRole === "write") {
    if (shareInfo.role === "write" || shareInfo.role === "owner") {
      console.log(
        "[checkPermissions] SUCCESS: User has sufficient 'write' (or 'owner') role. Permission granted."
      );
      console.log(`[checkPermissions] --- End (Success - Write role) ---`);
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
