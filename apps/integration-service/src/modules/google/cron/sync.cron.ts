import { db } from '../../../database/datasource';
import { GoogleRecordingService } from '../recording/recording.service';
import { logger } from '@futurespark/logger';

async function runSyncCheck() {
  try {
    logger.info('[Google Sync Cron] Auditing ended meetings to auto-sync recordings & AI summaries...');
    
    // Find all meetings whose end time has passed and have no recording file linked yet
    const pastMeetings = await db.meeting.findMany({
      where: {
        endTime: { lt: new Date() },
        recordings: {
          none: {},
        },
      },
      orderBy: { endTime: 'desc' },
      take: 25,
    });

    if (pastMeetings.length === 0) {
      logger.info('[Google Sync Cron] All ended meetings have recordings synced.');
      return;
    }

    logger.info(`[Google Sync Cron] Found ${pastMeetings.length} ended meeting(s) awaiting Drive recordings.`);

    for (const meeting of pastMeetings) {
      try {
        logger.info(`[Google Sync Cron] Scanning Drive for meeting: "${meeting.title}" (ID: ${meeting.id}, Meet URL: ${meeting.meetUrl})`);
        
        // Auto-sync recording (which automatically chains: Drive Match -> Video Download -> Audio Extract -> Groq AI Summary)
        const recording = await GoogleRecordingService.syncMeetingRecording(meeting.id);
        
        if (recording && !recording.driveFileId?.startsWith('pending_')) {
          await db.meeting.update({
            where: { id: meeting.id },
            data: { status: 'COMPLETED' },
          }).catch(() => {});
          logger.info(`[Google Sync Cron] [✓] Successfully auto-linked & started AI summary pipeline for meeting ${meeting.id}!`);
        }
      } catch (err: any) {
        logger.error(`[Google Sync Cron] Failed to process past meeting ${meeting.id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    logger.error(`[Google Sync Cron] Error running Google Meet sync job: ${err.message}`);
  }
}

export function startSyncCron() {
  // Poll every 2 minutes (120,000 ms)
  const INTERVAL = 2 * 60 * 1000;

  logger.info('[Google Sync Cron] Initializing Google Meet automated sync daemon (2 min interval)...');

  // 1. Initial run 5 seconds after boot
  setTimeout(() => {
    runSyncCheck();
  }, 5000);

  // 2. Recurring background loop
  setInterval(() => {
    runSyncCheck();
  }, INTERVAL);
}
