import express from "express";
import { searchUserByEmail } from "../controllers/userController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

// All user routes should be protected
router.use(protect);

// Route to search for users by email (e.g., for sharing notes)
// GET /api/users/search?email=user@example.com
router.get("/search", searchUserByEmail);

export default router;
