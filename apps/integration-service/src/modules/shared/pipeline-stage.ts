import { semaphoreNamed } from '../../utils/concurrency';

/**
 * Where one recording is in the post-class pipeline, in words an operator can
 * act on — or, more often, in words that tell them there is nothing to do.
 *
 * Built from two sources: the row (what has finished) and the in-process
 * semaphores (what is running or waiting right now, and where in the line).
 * The database alone cannot say "3rd in the queue"; the semaphores alone
 * forget everything on restart. Together they are the truth at this moment.
 */
export type PipelineStageCode =
  | 'WAITING_FOR_RECORDING'
  | 'DOWNLOAD_QUEUED'
  | 'DOWNLOADING'
  | 'DOWNLOAD_FAILED'
  | 'AUDIO_QUEUED'
  | 'EXTRACTING_AUDIO'
  | 'AUDIO_FAILED'
  | 'TRANSCRIPTION_QUEUED'
  | 'TRANSCRIBING'
  | 'RETRY_SCHEDULED'
  | 'FAILED'
  | 'READY'
  | 'PENDING';

export interface PipelineStage {
  stage: PipelineStageCode;
  /** Short, badge-sized. */
  label: string;
  /** One sentence for the line under the badge. */
  detail?: string;
  /** How many recordings are ahead of this one in the same queue. */
  queuedAhead?: number;
  retryAt?: string | null;
  attempts?: number;
  /** True when the next step happens on its own — no button needed. */
  automatic: boolean;
}

interface RecordingLike {
  id: string;
  driveFileId?: string | null;
  downloadStatus?: string | null;
  extractedAudioStatus?: string | null;
  transcriptionStatus?: string | null;
  transcriptionAttempts?: number | null;
  transcriptionError?: string | null;
  transcriptionRetryAt?: Date | string | null;
  meeting?: { provider?: string | null } | null;
}

const when = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const t = typeof d === 'string' ? new Date(d) : d;
  return isNaN(t.getTime()) ? null : t.toISOString();
};

export const describePipeline = (rec: RecordingLike): PipelineStage => {
  const zoom = (rec.meeting?.provider ?? 'GOOGLE_MEET') === 'ZOOM';
  const dl = semaphoreNamed(zoom ? 'zoom-download' : 'drive-download')?.whereIs(rec.id) ?? null;
  const ff = semaphoreNamed(zoom ? 'zoom-ffmpeg' : 'ffmpeg-extract')?.whereIs(rec.id) ?? null;
  const tr = semaphoreNamed('transcribe')?.whereIs(rec.id) ?? null;
  const attempts = rec.transcriptionAttempts ?? 0;

  // A Meet placeholder row: the class ended, Drive has not published yet.
  if (rec.driveFileId?.startsWith('pending_')) {
    return {
      stage: 'WAITING_FOR_RECORDING',
      label: 'Waiting for recording',
      detail: 'Google usually publishes a Meet recording 10–30 minutes after the call. Drive is searched automatically.',
      automatic: true,
    };
  }

  if (rec.transcriptionStatus === 'COMPLETED') {
    return { stage: 'READY', label: 'Summary ready', automatic: false };
  }

  // In-memory truth first: a job the semaphores know about is what is happening now.
  if (tr?.state === 'active' || rec.transcriptionStatus === 'RUNNING') {
    return {
      stage: 'TRANSCRIBING',
      label: 'Transcribing & analysing',
      detail: 'A 90-minute class takes about 5–10 minutes. The summary appears here when it is done.',
      automatic: true,
    };
  }
  if (tr?.state === 'queued') {
    return {
      stage: 'TRANSCRIPTION_QUEUED',
      label: `In queue · ${tr.position} of ${tr.queued}`,
      detail: `${tr.position - 1} recording${tr.position - 1 === 1 ? '' : 's'} ahead of this one for a transcription slot.`,
      queuedAhead: tr.position - 1,
      automatic: true,
    };
  }
  if (rec.transcriptionStatus === 'FAILED') {
    return {
      stage: 'FAILED',
      label: 'Transcription failed',
      detail: rec.transcriptionError ?? 'No detail was recorded.',
      attempts,
      automatic: false,
    };
  }
  if (rec.transcriptionStatus === 'PENDING' && attempts > 0 && rec.transcriptionRetryAt) {
    return {
      stage: 'RETRY_SCHEDULED',
      label: `Retry scheduled · attempt ${attempts + 1}`,
      detail: rec.transcriptionError ?? undefined,
      retryAt: when(rec.transcriptionRetryAt),
      attempts,
      automatic: true,
    };
  }

  if (ff?.state === 'active' || rec.extractedAudioStatus === 'PROCESSING') {
    return { stage: 'EXTRACTING_AUDIO', label: 'Extracting audio', detail: 'Pulling the audio track out of the video.', automatic: true };
  }
  if (ff?.state === 'queued') {
    return {
      stage: 'AUDIO_QUEUED',
      label: `Audio queue · ${ff.position} of ${ff.queued}`,
      detail: `${ff.position - 1} recording${ff.position - 1 === 1 ? '' : 's'} ahead of this one for audio extraction.`,
      queuedAhead: ff.position - 1,
      automatic: true,
    };
  }
  if (rec.extractedAudioStatus === 'FAILED') {
    return { stage: 'AUDIO_FAILED', label: 'Audio extraction failed', detail: 'Press Re-extract to try again.', automatic: false };
  }
  if (rec.extractedAudioStatus === 'COMPLETED') {
    // Audio exists, nothing in memory owns it: after a restart, or before the
    // auto-trigger fired. The retry daemon only revisits rows with attempts.
    return attempts > 0
      ? { stage: 'PENDING', label: 'Waiting to retry', automatic: true, attempts }
      : { stage: 'PENDING', label: 'Audio ready', detail: 'Transcription starts on the next pass, or press Generate.', automatic: true };
  }

  if (dl?.state === 'active') {
    return { stage: 'DOWNLOADING', label: 'Downloading', detail: 'Fetching the recording from the cloud.', automatic: true };
  }
  if (dl?.state === 'queued') {
    return {
      stage: 'DOWNLOAD_QUEUED',
      label: `Download queue · ${dl.position} of ${dl.queued}`,
      queuedAhead: dl.position - 1,
      automatic: true,
    };
  }
  if (rec.downloadStatus === 'FAILED') {
    return { stage: 'DOWNLOAD_FAILED', label: 'Download failed', detail: 'Press Re-sync to try again.', automatic: false };
  }
  if (rec.downloadStatus === 'COMPLETED') {
    return { stage: 'PENDING', label: 'Downloaded', detail: 'Audio extraction is next and starts on its own.', automatic: true };
  }
  return { stage: 'PENDING', label: 'Recording found', detail: 'Download starts on its own.', automatic: true };
};
