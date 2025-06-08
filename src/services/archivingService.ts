import Note from "../models/Note";
import { CronJob } from "cron";
import config from "../config";

const ARCHIVE_AFTER_DAYS = config.archiveNotesAfterDays || 90; // Default to 90 days

export const archiveOldNotes = async (): Promise<void> => {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - ARCHIVE_AFTER_DAYS);

  console.log(
    `[ArchivingService] Starting job. Archiving notes not updated since ${thresholdDate.toISOString()}...`
  );

  try {
    const result = await Note.updateMany(
      {
        isArchived: false,
        updatedAt: { $lt: thresholdDate },
      },
      {
        $set: {
          isArchived: true,
          archivedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount > 0) {
      console.log(
        `[ArchivingService] Successfully archived ${result.modifiedCount} notes.`
      );
    } else {
      console.log("[ArchivingService] No notes needed archiving at this time.");
    }
  } catch (error) {
    console.error("[ArchivingService] Error during note archiving:", error);
  }
};

// Schedule the job (e.g., once a day at midnight)
// The cron pattern '0 0 * * *' means 'at 00:00 (midnight) every day'
// You can adjust the schedule as needed.
// See https://crontab.guru/ for help with cron patterns.
export const archivingCronJob = new CronJob(
  config.archivingCronSchedule || "0 0 * * *",
  async () => {
    console.log(
      "[ArchivingService] Cron job triggered. Running archiveOldNotes..."
    );
    await archiveOldNotes();
  },
  null, // onComplete
  false, // start automatically? Set to false, we will start it in server.ts
  "UTC" // Timezone
);

// Function to start the cron job
export const startArchivingJob = () => {
  // The cron job is initialized with start: false, so the first call to .start() will run it.
  // Subsequent calls to .start() on an already running job are typically a no-op or handled by the library.
  archivingCronJob.start();
  console.log(
    `[ArchivingService] Archiving job initiated. Will run based on schedule: ${
      config.archivingCronSchedule || "0 0 * * *"
    }.`
  );
};
