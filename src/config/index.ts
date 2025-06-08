import dotenv from "dotenv";

dotenv.config();

const config = {
  port: process.env.PORT || "5001",
  mongoURI:
    process.env.MONGO_URI || "mongodb://localhost:27017/collaborative-notes",
  jwtSecret: process.env.JWT_SECRET || "yourjwtsecret",
  nodeEnv: process.env.NODE_ENV || "development",
  archiveNotesAfterDays: parseInt(
    process.env.ARCHIVE_NOTES_AFTER_DAYS || "90",
    10
  ),
  archivingCronSchedule: process.env.ARCHIVING_CRON_SCHEDULE || "0 0 * * *", // At midnight every day
};

export default config;
