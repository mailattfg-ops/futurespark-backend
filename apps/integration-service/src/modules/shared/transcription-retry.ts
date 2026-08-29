import { db } from '../../database/datasource';
import { logger } from '@futurespark/logger';
import { recordSystemEvent } from './audit-http';

/**
 * Retrying transcriptions that failed for reasons that pass.
 *
 * The Groq free tier meters audio: 7,200 seconds an hour and 28,800 a day —
 * roughly two 90-minute classes in any hour, five in any day. Past that it
 * returns 429, and until now that was terminal: the recording sweep only ever
 * revisits meetings whose recordings are still `pending_` placeholders, and by
 * the time transcription runs the real file is already linked.
 *
 * So the sixth class of a day downloaded fine, failed once, and was never
 * looked at again. Seventy-two hours later the parent-report cron marked it
 * "[NO_RECORDING]" — for a recording sitting on disk.
 *
 * Quota failures are not permanent. They just need to be tried later.
 */

/** Give up after this many attempts — a genuinely broken file is not a quota problem. */
const MAX_ATTEMPTS = Number(process.env.TRANSCRIPTION_MAX_ATTEMPTS ?? 8);

/** How long a rate-limited recording waits before its next attempt. */
const HOURLY_BACKOFF_MS = Number(process.env.TRANSCRIPTION_RATE_BACKOFF_MINUTES ?? 65) * 60 * 1000;

/** A daily cap cannot clear before the next UTC day, so do not keep poking it. */
const DAILY_BACKOFF_MS = Number(process.env.TRANSCRIPTION_DAILY_BACKOFF_HOURS ?? 6) * 60 * 60 * 1000;

/** Non-quota failures back off gently, in case the cause is transient. */
const GENERIC_BACKOFF_MS = 15 * 60 * 1000;

/**
 * How long to wait, judged from what actually failed.
 *
 * The distinction matters: an hourly cap clears in an hour, a daily cap does
 * not clear until tomorrow, and retrying the daily one every hour spends the
 * next day's quota on rejections.
 */
const backoffFor = (message: string): { ms: number; reason: string } => {
  const text = (message || '').toLowerCase();

  if (/per day|daily|28,?800|audio seconds per day|asd/.test(text)) {
    return { ms: DAILY_BACKOFF_MS, reason: 'daily audio quota' };
  }
  if (/rate limit|429|per hour|7,?200|tokens per minute|tpm/.test(text)) {
    return { ms: HOURLY_BACKOFF_MS, reason: 'hourly / per-minute quota' };
  }
  return { ms: GENERIC_BACKOFF_MS, reason: 'transient failure' };
};

/**
 * The provider account is out of money.
 *
 * Matched on the message because that is all a caller has by the time the
 * failure crosses two services. Anchored forms only ("http 402", not bare
 * "402") so a stray digit sequence in a uuid cannot classify a real failure
 * as a billing one.
 */
const isBillingFailure = (message: string): boolean =>
  /http 402|status 402|out of credits|requires at least \$|insufficient credit|payment required/i.test(
    message || ''
  );

/** Record a failed attempt and schedule the next one. */
export const recordTranscriptionFailure = async (recordingId: string, error: string): Promise<void> => {
  try {
    /* ── A billing outage is not the recording's fault ────────────────────
     * Out of credits fails EVERY recording the sweep touches, identically,
     * until someone tops up. Charging attempts for that ran whole backlogs
     * to permanent FAILED during one empty-balance afternoon — recordings
     * that had never once been tried against a working account. No attempt
     * is spent: the recording stays PENDING and retries hourly, so the
     * error message's promise that "the retry daemon will finish the
     * backlog once credit is restored" is actually kept. */
    if (isBillingFailure(error)) {
      await db.meetingRecording.update({
        where: { id: recordingId },
        data: {
          transcriptionStatus: 'PENDING',
          transcriptionError: error.slice(0, 1000),
          transcriptionRetryAt: new Date(Date.now() + HOURLY_BACKOFF_MS),
        },
      });
      logger.warn(
        `[TranscriptionRetry] Recording ${recordingId} hit a provider billing failure (out of credits). ` +
          'No attempt was charged — it retries hourly until the balance is topped up.'
      );
      return;
    }

    const current = await db.meetingRecording.findUnique({
      where: { id: recordingId },
      select: { transcriptionAttempts: true },
    });
    const attempts = (current?.transcriptionAttempts ?? 0) + 1;
    const { ms, reason } = backoffFor(error);
    const exhausted = attempts >= MAX_ATTEMPTS;

    await db.meetingRecording.update({
      where: { id: recordingId },
      data: {
        transcriptionStatus: exhausted ? 'FAILED' : 'PENDING',
        transcriptionAttempts: attempts,
        transcriptionError: error.slice(0, 1000),
        transcriptionRetryAt: exhausted ? null : new Date(Date.now() + ms),
      },
    });

    if (exhausted) {
      logger.error(
        `[TranscriptionRetry] Recording ${recordingId} has failed ${attempts} times and will not be retried ` +
          `automatically. Last error: ${error.slice(0, 200)}`
      );
      recordSystemEvent({
        action: 'failed',
        entityType: 'transcription',
        entityId: recordingId,
        summary: `The system gave up on a recording after ${attempts} failed transcription attempts — use Re-run to retry it manually`,
      });
    } else {
      logger.warn(
        `[TranscriptionRetry] Recording ${recordingId} attempt ${attempts}/${MAX_ATTEMPTS} failed ` +
          `(${reason}); next try in ${Math.round(ms / 60_000)} min.`
      );
    }
  } catch (err: any) {
    logger.error(`[TranscriptionRetry] Could not record the failure for ${recordingId}: ${err.message}`);
  }
};

export const recordTranscriptionSuccess = async (recordingId: string): Promise<void> => {
  try {
    await db.meetingRecording.update({
      where: { id: recordingId },
      data: { transcriptionStatus: 'COMPLETED', transcriptionError: null, transcriptionRetryAt: null },
    });
  } catch (err: any) {
    logger.error(`[TranscriptionRetry] Could not mark ${recordingId} transcribed: ${err.message}`);
  }
};

/**
 * The retry daemon.
 *
 * Deliberately serial and one-at-a-time. The failure being recovered from is
 * usually "too much audio too quickly" — sending a backlog of five recordings
 * at once would reproduce it exactly.
 */
export const startTranscriptionRetryCron = (
  transcribe: (recordingId: string, provider: string) => Promise<unknown>
): void => {
  if (process.env.TRANSCRIPTION_RETRY_ENABLED === 'false') {
    logger.warn('[TranscriptionRetry] Disabled by TRANSCRIPTION_RETRY_ENABLED=false.');
    return;
  }

  const intervalMs = Number(process.env.TRANSCRIPTION_RETRY_INTERVAL_MINUTES ?? 10) * 60 * 1000;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const due = await db.meetingRecording.findFirst({
        where: {
          transcriptionStatus: 'PENDING',
          transcriptionAttempts: { gt: 0, lt: MAX_ATTEMPTS },
          transcriptionRetryAt: { not: null, lte: new Date() },
          // Only recordings that actually have audio to send.
          audioPath: { not: null },
        },
        orderBy: { transcriptionRetryAt: 'asc' },
        include: { meeting: { select: { provider: true, title: true } } },
      });

      if (!due) return;

      logger.info(
        `[TranscriptionRetry] Retrying "${due.meeting?.title ?? due.fileName}" ` +
          `(attempt ${due.transcriptionAttempts + 1}/${MAX_ATTEMPTS}).`
      );
      recordSystemEvent({
        action: 'updated',
        entityType: 'transcription',
        entityId: due.id,
        entityName: due.meeting?.title ?? due.fileName,
        summary: `The system is retrying the transcription of "${due.meeting?.title ?? due.fileName}" (attempt ${due.transcriptionAttempts + 1}/${MAX_ATTEMPTS})`,
      });

      try {
        await transcribe(due.id, due.meeting?.provider ?? 'GOOGLE_MEET');
        await recordTranscriptionSuccess(due.id);
        logger.info(`[TranscriptionRetry] Recording ${due.id} transcribed on retry.`);
      } catch (err: any) {
        await recordTranscriptionFailure(due.id, err?.message ?? String(err));
      }
    } catch (err: any) {
      logger.error(`[TranscriptionRetry] Pass failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  logger.info(
    `[TranscriptionRetry] Starting the transcription retry daemon (every ` +
      `${Math.round(intervalMs / 60_000)} min, up to ${MAX_ATTEMPTS} attempts per recording).`
  );
  setTimeout(() => void tick(), 60_000);
  setInterval(() => void tick(), intervalMs);
};

/**
 * Clear transcriptions that a restart orphaned.
 *
 * `transcriptionStatus = RUNNING` is set in the database, but the job that owns
 * it lives in this process's memory. A deploy, a crash or a `pm2 restart`
 * therefore leaves a row claiming to be running with nothing running it — and
 * because the retry daemon only looks at PENDING rows, that class is stranded:
 * never finished, never retried, never reported on.
 *
 * Called once at boot. Anything still marked RUNNING cannot be, because this
 * process has only just started and owns no jobs yet.
 */
export const resetStuckTranscriptions = async (): Promise<void> => {
  try {
    const stuck = await db.meetingRecording.findMany({
      where: { transcriptionStatus: 'RUNNING' },
      select: { id: true, fileName: true, transcriptionAttempts: true },
    });

    if (stuck.length === 0) return;

    await db.meetingRecording.updateMany({
      where: { transcriptionStatus: 'RUNNING' },
      data: {
        transcriptionStatus: 'PENDING',
        // Attempts must be > 0 for the retry daemon to consider a row, and an
        // interrupted run genuinely was an attempt. `retryAt` in the past makes
        // it eligible on the very next pass rather than after a backoff it did
        // not earn.
        transcriptionAttempts: { increment: 1 },
        transcriptionRetryAt: new Date(Date.now() - 1000),
        transcriptionError: 'Interrupted by a service restart before it finished.',
      },
    });

    logger.warn(
      `[TranscriptionRetry] ${stuck.length} transcription(s) were left RUNNING by a previous ` +
        `process and have been requeued: ${stuck.map((s) => s.fileName).join(', ')}`
    );
    recordSystemEvent({
      action: 'updated',
      entityType: 'transcription',
      summary: `The system requeued ${stuck.length} transcription(s) interrupted by a restart`,
    });
  } catch (err: any) {
    logger.error(`[TranscriptionRetry] Could not requeue orphaned transcriptions: ${err.message}`);
  }
};
