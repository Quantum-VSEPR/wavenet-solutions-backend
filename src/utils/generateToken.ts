import jwt from "jsonwebtoken";
import config from "../config";

const generateToken = (userId: string): string => {
  return jwt.sign({ userId }, config.jwtSecret, {
    expiresIn: "30d", // Token expiration (e.g., 30 days)
  });
};

export default generateToken;
