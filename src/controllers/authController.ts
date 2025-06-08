import { Request, Response, NextFunction } from "express";
import Joi from "joi";
import User, { IUser } from "../models/User";
import generateToken from "../utils/generateToken";
import config from "../config";
import mongoose from "mongoose"; // Added mongoose import

// Joi schema for registration
const registerSchema = Joi.object({
  username: Joi.string().alphanum().min(3).max(30).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
});

// Joi schema for login
const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

export const registerUser = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) {
      res.status(400).json({ message: error.details[0].message });
      return;
    }

    const { username, email, password } = value;

    const userExists = await User.findOne({ $or: [{ email }, { username }] });
    if (userExists) {
      res
        .status(400)
        .json({ message: "User already exists with this email or username" });
      return;
    }

    const user: IUser = await User.create({
      username,
      email,
      password, // Password will be hashed by the pre-save hook in the User model
    });

    if (user) {
      const userId = (user._id as mongoose.Types.ObjectId).toString();
      const token = generateToken(userId);
      res.cookie("token", token, {
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: "strict",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });
      res.status(201).json({
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        token, // Also send token in response body for frontend to store if needed
      });
    } else {
      res.status(400).json({ message: "Invalid user data" });
    }
  } catch (err) {
    next(err);
  }
};

export const loginUser = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      res.status(400).json({ message: error.details[0].message });
      return;
    }

    const { email, password } = value;
    const user: IUser | null = await User.findOne({ email }).select(
      "+password"
    ); // Explicitly select password

    if (user && (await user.comparePassword(password))) {
      const userId = (user._id as mongoose.Types.ObjectId).toString();
      const token = generateToken(userId);
      res.cookie("token", token, {
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: "strict",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });
      res.json({
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        token,
      });
    } else {
      res.status(401).json({ message: "Invalid email or password" });
    }
  } catch (err) {
    next(err);
  }
};

export const logoutUser = (
  _req: Request, // Prefixed req with _
  res: Response,
  next: NextFunction
): void => {
  try {
    res.cookie("token", "", {
      httpOnly: true,
      expires: new Date(0),
      secure: config.nodeEnv === "production",
      sameSite: "strict",
    });
    res.status(200).json({ message: "User logged out successfully" });
  } catch (err) {
    next(err);
  }
};

export const getMe = async (
  req: any, // Using any for req.user, consider creating a custom Request type
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // req.user is populated by the `protect` middleware
    if (!req.user) {
      res.status(401).json({ message: "Not authorized" });
      return;
    }
    // User object from req.user already has password excluded by toJSON or select('-password')
    res.status(200).json(req.user);
  } catch (err) {
    next(err);
  }
};
