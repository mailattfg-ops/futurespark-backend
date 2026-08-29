import { db } from '../../database/datasource';
import { logger } from '@futurespark/logger';
import { recordTranscriptionFailure, recordTranscriptionSuccess } from './transcription-retry';
import { recordSystemEvent } from './audit-http';

/**
 * Running the transcription pipeline OUTSIDE the HTTP request that asked for it.
 *
 * ── Why ──
 * The admin's "generate transcript" button used to await the whole pipeline:
 * extract audio, upload to Groq, transcribe, then analyse. On the Groq free
 * tier the analysis alone runs in paced passes and takes about six minutes,
 * and Node's DEFAULT `server.requestTimeout` is five. The socket was killed
 * mid-flight, Express answered with a bare "Internal Server Error", and the
 * carefully-worded diagnosis never ran — while the work carried on in the
 * background, which is why nothing useful appeared in the logs either.
 *
 * Raising the timeout would only move the cliff. A job measured in minutes has
 * no business inside a request: it is started here, the caller is told it
 * started, and the result is collected by polling.
 */

/** Jobs in flight in this process, so a double-click cannot start two. */
const inFlight = new Map<string, Promise<unknown>>();

export interface TranscriptionJobState {
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  attempts: number;
  error?: string | null;
  retryAt?: Date | null;
}

/**
 * Start the pipeline for one recording, unless it is already running.
 *
 * Returns immediately. Never rejects — a failure is recorded against the
 * recording (which schedules a retry) rather than thrown at a caller who has
 * already been told the job started.
 */
export const startTranscriptionJob = (
  recordingId: string,
  run: () => Promise<unknown>
): { started: boolean; alreadyRunning: boolean } => {
  if (inFlight.has(recordingId)) {
    return { started: false, alreadyRunning: true };
  }

  logger.info(`[TranscriptionJob] Starting background transcription for ${recordingId}.`);
  recordSystemEvent({
    action: 'started',
    entityType: 'transcription',
    entityId: recordingId,
    summary: 'The system started transcribing a class recording',
  });

  const job = (async () => {
    try {
      await db.meetingRecording
        .update({ where: { id: recordingId }, data: { transcriptionStatus: 'RUNNING' } })
        .catch(() => {});

      await run();
      await recordTranscriptionSuccess(recordingId);
      logger.info(`[TranscriptionJob] Transcription finished for ${recordingId}.`);
      recordSystemEvent({
        action: 'created',
        entityType: 'transcription',
        entityId: recordingId,
        summary: 'The system finished transcribing a class recording',
      });
    } catch (err: any) {
      // undici reports every network-level failure as a bare "fetch failed"
      // and puts the actual reason in `cause`. Keep both: the stored error is
      // the only diagnosis an operator gets, and twelve attempts' worth of
      // "fetch failed" diagnosed nothing.
      const cause = err?.cause?.message || err?.cause?.code;
      const message = [err?.message ?? String(err), cause].filter(Boolean).join(' — ');
      logger.error(`[TranscriptionJob] Transcription failed for ${recordingId}: ${message}`);
      await recordTranscriptionFailure(recordingId, message);
      recordSystemEvent({
        action: 'failed',
        entityType: 'transcription',
        entityId: recordingId,
        summary: `The system could not transcribe a recording: ${message.slice(0, 140)}`,
      });
    } finally {
      inFlight.delete(recordingId);
    }
  })();

  inFlight.set(recordingId, job);
  return { started: true, alreadyRunning: false };
};

export const isTranscriptionRunning = (recordingId: string): boolean => inFlight.has(recordingId);

/**
 * A progress line for the admin panel.
 *
 * Wording matters here: the panel is polled every few seconds and this is the
 * only thing telling an operator whether to keep waiting or go and fix
 * something. It says what is happening AND roughly how long it should take,
 * because "processing" with no horizon is indistinguishable from "hung".
 */
export const describeJobState = (state: TranscriptionJobState, running: boolean): string => {
  if (running || state.status === 'RUNNING') {
    return (
      'Transcribing and analysing this class.\n\n' +
      'The audio is transcribed in chunks, then the class is analysed against the session ' +
      'material. Most classes finish in a couple of minutes.\n\n' +
      'You can close this window — it keeps running, and the summary will be here when it finishes.'
    );
  }

  if (state.status === 'FAILED') {
    return (
      `Transcription failed after ${state.attempts} attempt${state.attempts === 1 ? '' : 's'}.\n\n` +
      `${state.error ?? 'No further detail was recorded.'}`
    );
  }

  if (state.attempts > 0 && state.retryAt) {
    const minutes = Math.max(1, Math.round((state.retryAt.getTime() - Date.now()) / 60_000));
    return (
      `Waiting to retry (attempt ${state.attempts} did not succeed).\n\n` +
      `${state.error ?? ''}\n\nNext attempt in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
    );
  }

  return 'Queued for transcription.';
};

/** Read the stored lifecycle for a recording. */
export const getTranscriptionState = async (recordingId: string): Promise<TranscriptionJobState> => {
  const row = await db.meetingRecording.findUnique({
    where: { id: recordingId },
    select: {
      transcriptionStatus: true,
      transcriptionAttempts: true,
      transcriptionError: true,
      transcriptionRetryAt: true,
    },
  });

  return {
    status: (row?.transcriptionStatus as TranscriptionJobState['status']) ?? 'PENDING',
    attempts: row?.transcriptionAttempts ?? 0,
    error: row?.transcriptionError,
    retryAt: row?.transcriptionRetryAt,
  };
};
