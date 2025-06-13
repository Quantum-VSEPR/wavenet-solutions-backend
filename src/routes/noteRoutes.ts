import express, { RequestHandler } from "express";
import { protect } from "../middleware/authMiddleware";

// Import functions from the new specialized controller files
import {
  createNote,
  getMyNotes,
  getSharedWithMeNotes,
  getAllUserNotes,
  getNoteById,
  updateNote,
  deleteNote,
  searchNotes, // Added searchNotes import
} from "../controllers/noteCRUDController";

import {
  getArchivedNotes,
  archiveNote,
  unarchiveNote,
} from "../controllers/noteArchiveController";

import { shareNote, unshareNote } from "../controllers/noteShareController";

const router = express.Router();

// Apply protect middleware to all note routes
router.use(protect as RequestHandler);

// Search route - Placed before routes with /:id to avoid conflict
router.get("/search", searchNotes as RequestHandler);

router
  .route("/")
  .post(createNote as RequestHandler)
  .get(getAllUserNotes as RequestHandler); // Typically, GET / for all notes of a user or context

router.get("/mynotes", getMyNotes as RequestHandler);
router.get("/sharedwithme", getSharedWithMeNotes as RequestHandler);
router.get("/archived", getArchivedNotes as RequestHandler);

router
  .route("/:id")
  .get(getNoteById as RequestHandler)
  .put(updateNote as RequestHandler)
  .delete(deleteNote as RequestHandler);

// Sharing routes
router.post("/:id/share", shareNote as RequestHandler); // Add a new share or update role
router.put("/:id/share", shareNote as RequestHandler); // Explicitly for updating role, maps to same handler
router.delete("/:id/share/:userId", unshareNote as RequestHandler); // Remove a specific user

// Archiving routes
router.put("/:id/archive", archiveNote as RequestHandler);
router.put("/:id/unarchive", unarchiveNote as RequestHandler);

export default router;
