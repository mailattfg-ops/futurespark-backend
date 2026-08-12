import { db } from '../../../database/datasource';
import { GoogleRecordingService } from '../recording/recording.service';
import { logger } from '@futurespark/logger';

// Guards against overlapping ticks. A sweep that downloads several large
// recordings can easily exceed the 2-minute interval; without this the next
// timer fires into the same work and re-processes the same meetings.
let isRunning = false;
let skippedTicks = 0;

async function runSyncCheck() {
  if (isRunning) {
    skippedTicks++;
    logger.warn(`[Google Sync Cron] Previous sweep still running — skipping this tick (${skippedTicks} skipped in a row).`);
    return;
  }
  isRunning = true;
  skippedTicks = 0;
  const startedAt = Date.now();

  try {
    logger.info('[Google Sync Cron] Auditing ended meetings to auto-sync recordings & AI summaries...');
    
    // Find all meetings whose end time has passed and have no recording file linked yet.
    //
    // `provider` is mandatory. This sweep hands every row it selects to
    // GoogleRecordingService.syncMeetingRecording, which searches Drive and — when
    // it finds nothing, as it always will for a Zoom room — writes a
    // `pending_<id>` placeholder MeetingRecording. That placeholder is permanent
    // (nothing deletes it) and it makes the meeting invisible to the Zoom sweep,
    // which filters on `recordings: { none: {} }`. Without this filter the Google
    // cron silently disqualifies every Zoom meeting from ever being synced.
    // Meeting.provider is non-nullable with a "GOOGLE_MEET" default, so this
    // cannot drop pre-existing Google rows.
    //
    // `status` mirrors ZoomRecordingService.syncAllEndedRecordings: a cancelled
    // meeting has no recording to find, so scanning it only burns Drive quota and
    // leaves a placeholder behind.
    // Meetings still waiting on a Drive file — either none at all, or nothing but
    // unresolved `pending_` placeholders.
    //
    // `recordings: { none: {} }` alone was the reason nothing was ever automatic.
    // Google publishes a Meet recording to Drive 10-30 minutes after the call
    // ends, but this sweep runs two minutes after, finds nothing, and writes a
    // placeholder. The meeting then HAS a recording, so it never matched `none`
    // again and was abandoned — no download, no audio, no transcript, no summary,
    // until someone pressed "scan Drive" by hand. 33 of 36 rows were stuck this
    // way.
    //
    // `every` is vacuously true for a meeting with no recordings, so this one
    // condition covers both cases.
    const RETRY_WINDOW_MS = Number(process.env.RECORDING_SYNC_WINDOW_HOURS ?? 48) * 60 * 60 * 1000;

    const pastMeetings = await db.meeting.findMany({
      where: {
        provider: 'GOOGLE_MEET',
        status: { not: 'CANCELLED' },
        endTime: { lt: new Date() },
        // Bounded so a class that was genuinely never recorded is not re-searched
        // against Drive every two minutes for the rest of the year.
        AND: [{ endTime: { gt: new Date(Date.now() - RETRY_WINDOW_MS) } }],
        recordings: {
          every: { driveFileId: { startsWith: 'pending_' } },
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
  } finally {
    // Must be in `finally` — the early return above would otherwise wedge the
    // flag on and stop the daemon permanently.
    isRunning = false;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (Number(elapsed) > 120) {
      logger.warn(`[Google Sync Cron] Sweep took ${elapsed}s, longer than the 2 min interval — ticks will be skipped while it catches up.`);
    }
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
