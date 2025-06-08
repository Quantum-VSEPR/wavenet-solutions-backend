import express from "express";
import {
  createNote,
  getMyNotes,
  getSharedWithMeNotes,
  getAllUserNotes,
  getNoteById,
  updateNote,
  deleteNote,
  shareNote,
  unshareNote,
} from "../controllers/noteController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

// Apply protect middleware to all note routes
router.use(protect);

router.route("/").post(createNote).get(getAllUserNotes); // Gets all notes (created by user and shared with user)

router.get("/mynotes", getMyNotes); // Specifically get notes created by the user
router.get("/sharedwithme", getSharedWithMeNotes); // Specifically get notes shared with the user

router.route("/:id").get(getNoteById).put(updateNote).delete(deleteNote);

router.post("/:id/share", shareNote);
router.put("/:id/share", shareNote); // Add PUT method to also use shareNote for role updates
router.delete("/:id/share/:userId", unshareNote); // Route to remove a specific user from a note's share list

export default router;
