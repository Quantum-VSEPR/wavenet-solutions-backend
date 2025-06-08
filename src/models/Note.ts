import mongoose, { Schema, Document, Types } from "mongoose";

export interface IShare {
  userId: Types.ObjectId;
  email: string; // Denormalized for easier display, but userId is the source of truth
  role: "read" | "write" | "owner"; // 'owner' is implicitly the creator
}

export interface INote extends Document {
  title: string;
  content: string;
  creator: Types.ObjectId; // User ID of the creator
  sharedWith: IShare[];
  createdAt: Date;
  updatedAt: Date;
}

const ShareSchema: Schema<IShare> = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    role: {
      type: String,
      enum: ["read", "write", "owner"],
      required: true,
      default: "read",
    },
  },
  { _id: false } // No separate _id for subdocuments in this case
);

const NoteSchema: Schema<INote> = new Schema(
  {
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
    },
    content: {
      type: String,
      default: "",
    },
    creator: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sharedWith: [ShareSchema],
  },
  { timestamps: true } // Adds createdAt and updatedAt automatically
);

// Index for efficient querying of notes by creator or shared users
NoteSchema.index({ creator: 1 });
NoteSchema.index({ "sharedWith.userId": 1 });
NoteSchema.index({ updatedAt: -1 });

const Note = mongoose.model<INote>("Note", NoteSchema);

export default Note;
