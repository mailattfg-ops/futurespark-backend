import { db } from '../../../database/datasource';
import { GoogleRecordingService } from '../recording/recording.service';
import { logger } from '@futurespark/logger';

export function startSyncCron() {
  // Sync every 30 minutes
  const INTERVAL = 30 * 60 * 1000;

  logger.info('[Google Sync Cron] Initializing Google Meet sync daemon...');

  // Start the background process
  setInterval(async () => {
    try {
      logger.info('[Google Sync Cron] Auditing completed meetings to retrieve Google Drive recordings...');
      
      // Find all meetings where end time has passed and status is SCHEDULED
      const pastMeetings = await db.meeting.findMany({
        where: {
          endTime: { lt: new Date() },
          status: 'SCHEDULED',
        },
      });

      for (const meeting of pastMeetings) {
        try {
          logger.info(`[Google Sync Cron] Checking recordings for meeting: "${meeting.title}" (ID: ${meeting.id})`);
          
          // Try to sync recording
          const recording = await GoogleRecordingService.syncMeetingRecording(meeting.id);
          
          if (recording) {
            // Update status to COMPLETED once recording is matched
            await db.meeting.update({
              where: { id: meeting.id },
              data: { status: 'COMPLETED' },
            });
            logger.info(`[Google Sync Cron] Meeting ${meeting.id} updated status to COMPLETED.`);
          }
        } catch (err: any) {
          logger.error(`[Google Sync Cron] Failed to process past meeting ${meeting.id}: ${err.message}`);
        }
      }
    } catch (err: any) {
      logger.error(`[Google Sync Cron] Error running Google Meet sync job: ${err.message}`);
    }
  }, INTERVAL);
}
