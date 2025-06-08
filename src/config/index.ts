import dotenv from "dotenv";

dotenv.config();

const config = {
  port: process.env.PORT || "5001",
  mongoURI:
    process.env.MONGO_URI ||
    "mongodb://localhost:27017/collaborative_notes_app",
  jwtSecret: process.env.JWT_SECRET || "yourjwtsecretkey",
  nodeEnv: process.env.NODE_ENV || "development",
};

export default config;
