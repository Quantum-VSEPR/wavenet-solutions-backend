import express, { RequestHandler } from "express"; // Import RequestHandler
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
  getArchivedNotes, // Added import
  archiveNote, // Import the new controller function
  unarchiveNote, // Import the new controller function
} from "../controllers/noteController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

// Apply protect middleware to all note routes
router.use(protect as RequestHandler);

router
  .route("/")
  .post(createNote as RequestHandler)
  .get(getAllUserNotes as RequestHandler);

router.get("/mynotes", getMyNotes as RequestHandler);
router.get("/sharedwithme", getSharedWithMeNotes as RequestHandler);
router.get("/archived", getArchivedNotes as RequestHandler); // Added route for archived notes

router
  .route("/:id")
  .get(getNoteById as RequestHandler)
  .put(updateNote as RequestHandler)
  .delete(deleteNote as RequestHandler);

router.post("/:id/share", shareNote as RequestHandler);
router.put("/:id/share", shareNote as RequestHandler); // Add PUT method to also use shareNote for role updates
router.delete("/:id/share/:userId", unshareNote as RequestHandler); // Route to remove a specific user from a note's share list

// Route to archive a note
router.put("/:id/archive", archiveNote as RequestHandler);

// Route to unarchive a note
router.put("/:id/unarchive", unarchiveNote as RequestHandler);

export default router;
