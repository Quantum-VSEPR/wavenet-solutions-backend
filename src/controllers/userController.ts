import { Response, NextFunction } from "express";
import User from "../models/User";
import { AuthRequest } from "../middleware/authMiddleware";
import Joi from "joi";

const searchUserSchema = Joi.object({
  email: Joi.string().email().required(),
});

export const searchUserByEmail = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { error, value } = searchUserSchema.validate(req.query); // Search query from query params
    if (error) {
      res.status(400).json({ message: error.details[0].message });
      return;
    }

    if (!req.user) {
      res.status(401).json({ message: "User not authenticated" });
      return;
    }

    const { email } = value;

    const foundUser = await User.findOne({ email }).select(
      "username email _id"
    );

    if (!foundUser) {
      // Return an empty array under the 'data' key if no user is found
      res.status(200).json({ data: [] });
      return;
    }

    // Prevent users from searching for themselves if that's a requirement (optional)
    // if (foundUser._id.toString() === req.user._id.toString()) {
    //   res.status(404).json({ message: \'Cannot search for yourself\' });
    //   return;
    // }

    // Return the found user in an array under the 'data' key
    res.status(200).json({ data: [foundUser] });
  } catch (err) {
    next(err);
  }
};
