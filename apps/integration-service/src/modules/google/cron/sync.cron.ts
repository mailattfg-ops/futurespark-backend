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
    
    // Find meetings the mentor has signed off and that still have no real Drive
    // file linked. See "THE GATE" below for why sign-off, and not the booked end
    // time, is the trigger.
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
    //
    // ── THE GATE ──
    // Two conditions decide whether a meeting is eligible AT ALL, and together
    // they are what stopped this sweep burning Drive quota:
    //
    //   1. `classCompletedAt` is set — the MENTOR signed the class off. A slot
    //      whose end time merely passed proves nothing; the class may have
    //      overrun, been cut short, or never happened.
    //   2. That sign-off is at least RECORDING_SEARCH_DELAY_MINUTES old.
    //      Google publishes a Meet recording to Drive 10-30 minutes after the
    //      call ends, and the processed video can lag further. Searching before
    //      then always finds nothing, so every early search is wasted quota.
    //
    // Before the gate, each meeting was searched every 2 minutes for 48 hours —
    // up to 1,440 Drive queries for one class, nearly all of them before the
    // file existed. Now it is one search per interval starting 90 minutes after
    // sign-off, capped by MAX_RECORDING_SEARCHES.
    const RETRY_WINDOW_MS = Number(process.env.RECORDING_SYNC_WINDOW_HOURS ?? 48) * 60 * 60 * 1000;
    const SEARCH_DELAY_MS = Number(process.env.RECORDING_SEARCH_DELAY_MINUTES ?? 90) * 60 * 1000;
    const MAX_SEARCHES = Number(process.env.MAX_RECORDING_SEARCHES ?? 24);
    // Space repeat searches out. Without this the "at least 90 minutes old"
    // condition stays true forever and the meeting is re-searched on every tick.
    const SEARCH_INTERVAL_MS = Number(process.env.RECORDING_SEARCH_INTERVAL_MINUTES ?? 15) * 60 * 1000;

    const now = Date.now();
    const eligibleSince = new Date(now - SEARCH_DELAY_MS);

    const pastMeetings = await db.meeting.findMany({
      where: {
        provider: 'GOOGLE_MEET',
        status: { not: 'CANCELLED' },
        // The mentor has closed the class out, and the publish delay has elapsed.
        classCompletedAt: {
          lt: eligibleSince,
          // Bounded so a class that was genuinely never recorded is not
          // re-searched against Drive for the rest of the year.
          gt: new Date(now - RETRY_WINDOW_MS),
        },
        recordingSearches: { lt: MAX_SEARCHES },
        OR: [
          { recordingSearchedAt: null },
          { recordingSearchedAt: { lt: new Date(now - SEARCH_INTERVAL_MS) } },
        ],
        recordings: {
          every: { driveFileId: { startsWith: 'pending_' } },
        },
      },
      orderBy: { classCompletedAt: 'asc' },
      take: 25,
    });

    if (pastMeetings.length === 0) {
      logger.info('[Google Sync Cron] No completed meetings are due a Drive search right now.');
      return;
    }

    logger.info(`[Google Sync Cron] Found ${pastMeetings.length} completed meeting(s) due a Drive search.`);

    for (const meeting of pastMeetings) {
      try {
        const waitedMin = meeting.classCompletedAt
          ? Math.round((now - meeting.classCompletedAt.getTime()) / 60_000)
          : 0;
        logger.info(
          `[Google Sync Cron] Scanning Drive for "${meeting.title}" (ID: ${meeting.id}, ` +
            `Meet URL: ${meeting.meetUrl}) — ${waitedMin}m since the mentor marked it complete, ` +
            `attempt ${meeting.recordingSearches + 1}/${MAX_SEARCHES}.`
        );

        // Stamped BEFORE the search, not after. A search that throws still
        // counts: otherwise a meeting that fails every time is retried on every
        // tick forever, which is the exact quota burn the gate exists to stop.
        await db.meeting.update({
          where: { id: meeting.id },
          data: { recordingSearches: { increment: 1 }, recordingSearchedAt: new Date() },
        }).catch(() => {});

        // Auto-sync recording (which automatically chains: Drive Match -> Video Download -> Audio Extract -> Groq AI Summary)
        const recording = await GoogleRecordingService.syncMeetingRecording(meeting.id);

        if (recording && !recording.driveFileId?.startsWith('pending_')) {
          await db.meeting.update({
            where: { id: meeting.id },
            data: { status: 'COMPLETED' },
          }).catch(() => {});
          logger.info(`[Google Sync Cron] [✓] Successfully auto-linked & started AI summary pipeline for meeting ${meeting.id}!`);
        } else if (meeting.recordingSearches + 1 >= MAX_SEARCHES) {
          logger.warn(
            `[Google Sync Cron] Giving up on meeting ${meeting.id} ("${meeting.title}") after ` +
              `${MAX_SEARCHES} Drive searches — no recording was ever published. The parent report ` +
              'will go out without a summary unless someone links the file by hand.'
          );
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
