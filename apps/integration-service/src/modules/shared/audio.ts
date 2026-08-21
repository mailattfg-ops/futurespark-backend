import fs from 'fs';
import pathModule from 'path';
import { execFile } from 'child_process';
import { logger } from '@futurespark/logger';

/**
 * Audio extraction, verified.
 *
 * A class recording's audio is the only evidence the AI ever sees, so a bad
 * extraction does not fail loudly — it produces a confident, wrong report about
 * a real child's lesson. Two such failures were found in production:
 *
 *   - A stored track that decoded to 2h50m of audio for a 57-minute video: the
 *     speech was stretched to a third of its speed, which is unintelligible to
 *     a transcription model and produced a garbled transcript that still looked
 *     like a transcript.
 *   - A failure path that wrote 1 KB of silence and marked the extraction
 *     COMPLETE, so the pipeline transcribed nothing at all.
 *
 * Everything here exists to make both impossible: extract, then MEASURE what
 * was produced and refuse it if it does not match the source.
 */

/** The bundled binary — never bare "ffmpeg", which may be absent or a different build. */
export const resolveFfmpegPath = (): string => {
  try {
    return require('@ffmpeg-installer/ffmpeg').path || require('ffmpeg-static') || 'ffmpeg';
  } catch {
    try {
      return require('ffmpeg-static') || 'ffmpeg';
    } catch {
      return 'ffmpeg';
    }
  }
};

const run = (file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? ` :: ${String(stderr).slice(-500)}` : ''}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * The media's real length in seconds, or null when it cannot be determined.
 *
 * Read from the CONTAINER header, which is what a browser and every downstream
 * tool trusts. A file whose header says one thing and whose frames say another
 * is exactly the corruption this module guards against, so `decode` re-reads it
 * the slow way — by decoding every frame — when the two need comparing.
 */
export const probeDurationSeconds = async (
  filePath: string,
  opts: { decode?: boolean } = {}
): Promise<number | null> => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ffmpeg = resolveFfmpegPath();

  try {
    if (opts.decode) {
      // -f null discards the output and reports the true decoded length.
      const { stderr } = await run(ffmpeg, ['-i', filePath, '-f', 'null', '-'], 15 * 60_000);
      const times = [...String(stderr).matchAll(/time=(\d+):(\d{2}):(\d{2})\.(\d{1,2})/g)];
      const last = times[times.length - 1];
      if (!last) return null;
      return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) + Number(`0.${last[4]}`);
    }

    // `-i` with no output is an error exit by design; the header is on stderr.
    await run(ffmpeg, ['-i', filePath], 60_000).catch((err) => ({ stdout: '', stderr: err.message }));
    const { stderr } = await run(ffmpeg, ['-i', filePath, '-f', 'null', '-t', '0', '-'], 60_000).catch(
      (err: Error) => ({ stdout: '', stderr: err.message })
    );
    const match = /Duration: (\d+):(\d{2}):(\d{2})\.(\d{1,2})/.exec(String(stderr));
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`);
  } catch (err: any) {
    logger.warn(`[Audio] Could not probe "${filePath}": ${err.message}`);
    return null;
  }
};

export class AudioExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioExtractionError';
  }
}

/**
 * Extract a mono 16 kHz track and prove it matches the source.
 *
 * 16 kHz mono is what speech models want and keeps the upload inside the
 * provider's size limit. The `-ar` resample is also where a mismatched sample
 * rate would stretch the audio, so the length check immediately after is not
 * ceremony — it is the check for the exact failure that produced a
 * three-times-too-long track in production.
 */
let extractionCounter = 0;

export const extractVerifiedAudio = async (
  videoPath: string,
  audioPath: string,
  options: { label?: string } = {}
): Promise<{ audioPath: string; durationSeconds: number }> => {
  const label = options.label ? `[${options.label}] ` : '';
  const ffmpeg = resolveFfmpegPath();

  if (!fs.existsSync(videoPath)) {
    throw new AudioExtractionError(`${label}The source video is missing: ${videoPath}`);
  }

  const sourceSeconds = await probeDurationSeconds(videoPath);
  if (sourceSeconds === null) {
    // An unreadable container is usually a half-finished download. Extracting
    // from it yields a plausible-looking short file, which is worse than
    // stopping — the sweep will retry once the file is whole.
    throw new AudioExtractionError(
      `${label}The source video's duration could not be read, so it is probably still downloading or ` +
        'truncated. Not extracting audio from it.'
    );
  }

  // A stale output from a previous crashed run must never be reused.
  if (fs.existsSync(audioPath)) {
    try { fs.unlinkSync(audioPath); } catch { /* overwritten by -y anyway */ }
  }

  /* Extract to a private temp file, then rename into place.
   *
   * The in-process lock stops two triggers inside ONE service from colliding,
   * but it cannot see another process. Two backends were briefly running
   * against this same downloads directory, and ffmpeg writing the final path
   * directly means two of them interleave their output into one file — which
   * is how a track ended up with frames that disagreed with its header.
   *
   * A rename is atomic on both NTFS and ext4, so the destination only ever
   * holds a file that was written start-to-finish by a single process and then
   * measured. A loser in that race overwrites with its own complete, verified
   * track rather than corrupting the winner's. */
  const ext = pathModule.extname(audioPath) || '.mp3';
  const tempPath = `${audioPath.slice(0, audioPath.length - ext.length)}.${process.pid}.${extractionCounter++}.tmp${ext}`;

  try {
    await run(
      ffmpeg,
      ['-y', '-i', videoPath, '-vn', '-map', '0:a:0', '-ar', '16000', '-ac', '1', '-b:a', '32k', '-write_xing', '1', tempPath],
      30 * 60_000
    );
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* nothing to clean */ }
    throw err;
  }

  if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size < 4096) {
    throw new AudioExtractionError(
      `${label}Audio extraction produced no usable file. Nothing was written — a silent placeholder ` +
        'would be transcribed as an empty class.'
    );
  }

  const audioSeconds = await probeDurationSeconds(tempPath);
  if (audioSeconds === null) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    throw new AudioExtractionError(
      `${label}The extracted audio has no readable duration, which means a malformed file. Discarded.`
    );
  }

  // 2% or 5s of slack: container rounding and a trailing partial frame are
  // normal; a 3x stretch or a truncated file is not.
  const tolerance = Math.max(5, sourceSeconds * 0.02);
  if (Math.abs(audioSeconds - sourceSeconds) > tolerance) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    throw new AudioExtractionError(
      `${label}Extracted audio is ${audioSeconds.toFixed(0)}s but the video is ${sourceSeconds.toFixed(0)}s ` +
        `(${(audioSeconds / sourceSeconds).toFixed(2)}x). A stretched or truncated track transcribes into ` +
        'nonsense, so it has been discarded rather than sent to the AI.'
    );
  }

  const sizeBytes = fs.statSync(tempPath).size;

  /* Verified — promote it. Until this line the destination either does not
   * exist or still holds the previous good track; nothing downstream can ever
   * observe a half-written file. */
  fs.renameSync(tempPath, audioPath);

  logger.info(
    `${label}Audio extracted and verified: ${Math.round(audioSeconds)}s, ` +
      `${(sizeBytes / 1048576).toFixed(1)} MB (video ${Math.round(sourceSeconds)}s).`
  );

  return { audioPath, durationSeconds: audioSeconds };
};
