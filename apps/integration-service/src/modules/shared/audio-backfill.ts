import fs from 'fs';
import { logger } from '@futurespark/logger';
import { db } from '../../database/datasource';
import { probeDurationSeconds } from './audio';

/**
 * Give already-extracted audio the timestamp it never got.
 *
 * `audioExtractedAt` was added after these recordings were processed, so every
 * existing row has `extractedAudioStatus: COMPLETED` and no time — which read
 * on the dashboard as "audio has never been extracted", the opposite of the
 * truth.
 *
 * The file's own mtime is used, and only that: it is the moment ffmpeg
 * finished writing the track, recorded by the filesystem rather than guessed
 * by us. A row whose audio lives in S3, or whose file is gone, is left null —
 * an absent timestamp is honest, and a fabricated one would quietly corrupt
 * the "audio ready" timings the System Health page measures.
 *
 * Runs once at boot, fills only nulls, and is safe to run repeatedly.
 */
export const backfillAudioExtractedAt = async (): Promise<void> => {
  try {
    const candidates = await db.meetingRecording.findMany({
      // NOT filtered on audioExtractedAt: a track dated by an earlier pass
      // still has to be checked, and the corrupt one this catches was dated
      // before the check existed. A quarantined row becomes FAILED, so it
      // drops out of this set and is never re-probed.
      where: { extractedAudioStatus: 'COMPLETED', audioPath: { not: null } },
      select: { id: true, audioPath: true, videoPath: true, createdAt: true, duration: true, audioExtractedAt: true },
      // Header-only probes, but still one subprocess each — capped so a large
      // archive cannot turn boot into a batch job.
      take: 500,
    });
    if (candidates.length === 0) return;

    let filled = 0;
    let skipped = 0;
    let quarantined = 0;

    for (const row of candidates) {
      const path = row.audioPath as string;
      let mtime: Date | null = null;
      try {
        if (fs.existsSync(path)) mtime = fs.statSync(path).mtime;
      } catch {
        mtime = null;
      }

      // No local file (S3, or cleaned up) — nothing trustworthy to write.
      if (!mtime) { skipped += 1; continue; }

      // A file written BEFORE its own recording row is a copied or restored
      // file, not evidence of when extraction ran. Left null rather than
      // producing a negative "audio ready" lag downstream.
      if (mtime.getTime() < row.createdAt.getTime()) { skipped += 1; continue; }

      /* Is the track actually usable?
       *
       * A stretched or header-broken file plays as gibberish, transcribes as
       * gibberish, and reports a nonsense duration to the player — the
       * "0:00 / 14092:51:41" case. Marking it FAILED and clearing the path is
       * what puts it back in the pipeline's queue to be extracted again, this
       * time through the verifying path. */
      /* Compared against the SOURCE VIDEO, not the provider's duration.
       *
       * Zoom rounds its duration to whole minutes, so a 4:46 class is reported
       * as 240s — and comparing a correctly-extracted 286s track against that
       * makes it look 46s wrong. The video file on disk is the real length;
       * the provider figure is only a fallback, and then only with enough
       * slack to survive that rounding.
       *
       * A track is condemned only when it is UNREADABLE or wildly off — the
       * 3x-stretched, 14092-hour case this exists for — never for the minute
       * or two that ordinary rounding explains. */
      const audioSeconds = await probeDurationSeconds(path);
      const videoSeconds = row.videoPath ? await probeDurationSeconds(row.videoPath) : null;
      const reference = videoSeconds ?? (typeof row.duration === 'number' && row.duration > 0 ? row.duration : null);

      if (reference !== null) {
        // Generous on purpose: 90s or 25%. The failure this catches is a
        // multiple, not a discrepancy.
        const tolerance = Math.max(90, reference * 0.25);
        if (audioSeconds === null || Math.abs(audioSeconds - reference) > tolerance) {
          await db.meetingRecording.update({
            where: { id: row.id },
            data: { extractedAudioStatus: 'FAILED', audioExtractedAt: null },
          });
          // The file is deliberately LEFT ON DISK. Re-extraction overwrites it
          // (-y), disk is cheap, and deleting the only copy of something on a
          // hunch is not a trade worth making — this check has already had one
          // false positive.
          quarantined += 1;
          logger.error(
            `[AudioBackfill] Audio for recording ${row.id} reads as ${audioSeconds === null ? 'unreadable' : Math.round(audioSeconds) + 's'} ` +
              `against a ${Math.round(reference)}s ${videoSeconds !== null ? 'video' : 'recording'} — marked for re-extraction. ` +
              `The file was left at ${path} in case it is wanted.`
          );
          continue;
        }
      }

      if (row.audioExtractedAt) continue; // already dated, and just verified
      await db.meetingRecording.update({ where: { id: row.id }, data: { audioExtractedAt: mtime } });
      filled += 1;
    }

    if (filled > 0 || skipped > 0 || quarantined > 0) {
      logger.info(
        `[AudioBackfill] Dated ${filled} already-extracted audio track(s) from the file's own write time` +
          (skipped > 0 ? `; left ${skipped} undated (no local file, or the file predates its recording)` : '') +
          (quarantined > 0 ? `; discarded ${quarantined} unusable track(s) for re-extraction` : '') +
          '.'
      );
    }
  } catch (err: any) {
    // Never fatal — this only improves a dashboard, and a missing column here
    // means the schema push has not run yet, which the feed already reports.
    logger.warn(`[AudioBackfill] Skipped: ${err.message}`);
  }
};
