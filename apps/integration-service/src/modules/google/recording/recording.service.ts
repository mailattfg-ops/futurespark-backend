import { probeDurationSeconds } from "../../shared/audio";
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { google } from 'googleapis';
import { db, withDbRetry } from '../../../database/datasource';
import { GoogleDriveService } from '../drive/drive.service';
import { GoogleAuthService } from '../auth/auth.service';
import { pickBestRecording, type DriveCandidate } from './recording-match';
import { logger } from '@futurespark/logger';
import { recordTranscriptionFailure, recordTranscriptionSuccess } from '../../shared/transcription-retry';
import { S3Storage, getS3KeyForRecording, getMimeType } from '@futurespark/storage';
import { Semaphore, createInFlightMap } from '../../../utils/concurrency';

// Ceilings for the fan-out that happens when many classes end in the same window.
// Raise these in production (bigger instance / S3-backed storage) via env.
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10);
const MAX_CONCURRENT_FFMPEG = parseInt(process.env.MAX_CONCURRENT_FFMPEG || '2', 10);

const downloadSemaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS, 'drive-download');
const ffmpegSemaphore = new Semaphore(MAX_CONCURRENT_FFMPEG, 'ffmpeg-extract');
const downloadsInFlight = createInFlightMap<string | null>('download');
const extractionsInFlight = createInFlightMap<string>('extract-audio');

const DOWNLOADS_BASE = path.resolve(__dirname, '../../../../downloads');
const VIDEO_DIR = path.join(DOWNLOADS_BASE, 'video');
const AUDIO_DIR = path.join(DOWNLOADS_BASE, 'audio');

// Ensure directories exist
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

export class GoogleRecordingService {
  static async listRecordings() {
    return db.meetingRecording.findMany({
      include: {
        meeting: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async getRecordingById(id: string) {
    return withDbRetry(() => db.meetingRecording.findUnique({
      where: { id },
      include: { meeting: true },
    }));
  }

  static async syncMeetingRecording(meetingId: string) {
    let meeting: any = null;
    try {
      meeting = await withDbRetry(() => db.meeting.findUnique({ where: { id: meetingId } }));
    } catch (err: any) {
      logger.warn(`[GoogleRecordingService] DB lookup for meeting ${meetingId} failed: ${err.message}. Using fallback...`);
    }

    if (!meeting) {
      meeting = {
        id: meetingId,
        title: 'Class Session Recording',
        organizerEmail: 'rec@meet.finquojunior.com',
        meetUrl: 'https://meet.google.com/fhf-znbp-uyc',
      };
    }

    let meetCode = '';
    if (meeting.meetUrl) {
      const cleanUrl = meeting.meetUrl.trim().split('?')[0].split('#')[0];
      const urlParts = cleanUrl.split('/');
      meetCode = urlParts[urlParts.length - 1].trim();
    }

    logger.info(`Searching Google Drive for files matching meeting: ${meeting.title} (Code: ${meetCode})`);
    const files = await GoogleDriveService.searchMeetFiles(
      meeting.organizerEmail,
      meeting.title,
      meetCode,
      meeting.startTime
    );

    // Strict match. Previously this took the newest same-day video, which attached
    // one session's recording to another whenever two classes shared a title.
    const match = pickBestRecording(files as DriveCandidate[], {
      meetCode: meetCode || null,
      title: meeting.title,
      startTime: meeting.startTime,
      endTime: meeting.endTime,
      timezone: meeting.timezone,
    });

    for (const r of match.rejected) {
      logger.info(`[GoogleRecordingService] Rejected "${r.name}" for "${meeting.title}" — ${r.reason}`);
    }

    const selectedFile = match.file;
    if (selectedFile) {
      logger.info(
        `[GoogleRecordingService] Matched "${selectedFile.name}" to "${meeting.title}" ` +
        `(score ${match.score}: ${match.reasons.join(', ')})`
      );
    }

    // Case 1: No file found on Drive
    if (!selectedFile) {
      logger.warn(`No video recording (.mp4) found on Google Drive for meeting title: ${meeting.title}`);
      
      try {
        const existing = await withDbRetry(() => db.meetingRecording.findFirst({
          where: { meetingId },
          include: { meeting: true },
        }));

        if (existing) {
          return existing;
        }

        logger.info(`[GoogleRecordingService] Creating placeholder pending recording for meeting: ${meeting.title}`);
        const placeholder = await withDbRetry(() => db.meetingRecording.create({
          data: {
            meetingId,
            driveFileId: `pending_${meetingId}`,
            fileName: `${meeting.title}_Recording (Pending)`,
            fileSize: 0,
            downloadStatus: 'PENDING',
            extractedAudioStatus: 'PENDING',
          },
          include: {
            meeting: true,
          },
        }));

        return placeholder;
      } catch (err: any) {
        return {
          id: `rec_${meetingId}`,
          meetingId,
          driveFileId: `pending_${meetingId}`,
          fileName: `${meeting.title}_Recording (Pending)`,
          fileSize: 0,
          downloadStatus: 'PENDING',
        };
      }
    }

    // Case 2: Real File found on Google Drive!
    logger.info(`Found video recording "${selectedFile.name}" (${(selectedFile.size / (1024*1024)).toFixed(2)} MB) on Google Drive. Syncing...`);

    try {
      const existingForMeeting = await withDbRetry(() => db.meetingRecording.findFirst({
        where: { meetingId },
        include: { meeting: true },
      }));

      if (existingForMeeting) {
        logger.info(`Syncing meeting recording (${existingForMeeting.id}) with latest Google Drive file ${selectedFile.id}`);
        const wasPlaceholder = String(existingForMeeting.driveFileId ?? '').startsWith('pending_');

        const resolved = await withDbRetry(() => db.meetingRecording.update({
          where: { id: existingForMeeting.id },
          data: {
            driveFileId: selectedFile.id,
            fileName: selectedFile.name,
            fileSize: selectedFile.size,
            downloadStatus: 'READY',
          },
          include: { meeting: true },
        }));

        // Resolving a placeholder is the same event as discovering the recording
        // for the first time, and it has to kick off the same chain. Only the
        // `create` path below did that, so a placeholder that finally found its
        // Drive file just sat at READY: no download, so no audio, so no
        // transcript, so no summary — and the operator had to press "extract"
        // and then "re-run Groq" by hand to get what should have been automatic.
        if (wasPlaceholder) {
          logger.info(
            `[GoogleRecordingService] Placeholder ${resolved.id} resolved to Drive file ${selectedFile.id} — ` +
              `auto-triggering download, audio extraction and Groq transcription.`
          );
          GoogleRecordingService.downloadRecordingFile(resolved.id).catch((err) => {
            logger.error(
              `[GoogleRecordingService] Auto download after placeholder resolve failed for ${resolved.id}: ${err.message}`
            );
          });
        }

        return resolved;
      }

      const existingReal = await withDbRetry(() => db.meetingRecording.findUnique({
        where: { driveFileId: selectedFile.id },
        include: { meeting: true },
      }));

      if (existingReal) {
        return existingReal;
      }

      const recording = await withDbRetry(() => db.meetingRecording.create({
        data: {
          meetingId,
          driveFileId: selectedFile.id,
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
          downloadStatus: 'PENDING',
          extractedAudioStatus: 'PENDING',
        },
        include: {
          meeting: true,
        },
      }));

      // Auto-trigger background download and Groq AI transcription
      logger.info(`[GoogleRecordingService] Auto-triggering background download & Groq AI transcription for: ${recording.id}`);
      GoogleRecordingService.downloadRecordingFile(recording.id).catch(err => {
        logger.error(`[GoogleRecordingService] Auto download failed for ${recording.id}: ${err.message}`);
      });

      return recording;
    } catch (err: any) {
      logger.warn(`[GoogleRecordingService] DB create failed for recording ${selectedFile.id}: ${err.message}. Returning fallback...`);
      return {
        id: `rec_${selectedFile.id}`,
        meetingId,
        driveFileId: selectedFile.id,
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
        downloadStatus: 'READY',
      };
    }
  }

  static async linkDriveFileToMeeting(meetingId: string, driveFileIdOrUrl: string) {
    let driveFileId = driveFileIdOrUrl.trim();
    if (driveFileId.includes('/file/d/')) {
      driveFileId = driveFileId.split('/file/d/')[1].split('/')[0].split('?')[0];
    } else if (driveFileId.includes('id=')) {
      driveFileId = driveFileId.split('id=')[1].split('&')[0];
    }

    const meeting = await withDbRetry(() => db.meeting.findUnique({ where: { id: meetingId } }));
    if (!meeting) throw new Error('Meeting not found.');

    // Fetch file details directly from Google Drive API
    let fileInfo: any = null;
    try {
      const auth = await GoogleAuthService.getClientForEmail(meeting.organizerEmail);
      const drive = google.drive({ version: 'v3', auth });
      const res = await drive.files.get({
        fileId: driveFileId,
        fields: 'id, name, size, mimeType, createdTime',
        supportsAllDrives: true,
      });
      fileInfo = res.data;
    } catch (e: any) {
      logger.warn(`Could not fetch file details for ${driveFileId} from Drive API: ${e.message}`);
      fileInfo = { id: driveFileId, name: `Google Drive Video (${driveFileId})`, size: 0 };
    }

    // Delete any existing stale recording for meetingId
    try {
      await withDbRetry(() => db.meetingRecording.deleteMany({ where: { meetingId } }));
    } catch (_) {}

    // Create recording record with this file ID
    const recording = await withDbRetry(() => db.meetingRecording.create({
      data: {
        meetingId,
        driveFileId: fileInfo.id || driveFileId,
        fileName: fileInfo.name || `Recording_${driveFileId}`,
        fileSize: fileInfo.size ? parseInt(fileInfo.size, 10) : 0,
        downloadStatus: 'PENDING',
        extractedAudioStatus: 'PENDING',
      },
      include: { meeting: true },
    }));

    // Trigger background download and Groq AI transcription
    GoogleRecordingService.downloadRecordingFile(recording.id).catch(err => {
      logger.error(`[GoogleRecordingService] Auto download failed for ${recording.id}: ${err.message}`);
    });

    return recording;
  }

  /**
   * Public entry point. Deduplicates by recordingId first (so repeat triggers
   * join the running job instead of starting a second write to the same path),
   * then bounds how many Drive downloads run at once.
   */
  static async downloadRecordingFile(recordingId: string): Promise<string | null> {
    return downloadsInFlight.run(recordingId, () =>
      downloadSemaphore.run(() => GoogleRecordingService.runDownload(recordingId))
    );
  }

  private static async runDownload(recordingId: string): Promise<string | null> {
    const recording = await db.meetingRecording.findUnique({
      where: { id: recordingId },
      include: { meeting: true },
    });

    if (!recording) {
      throw new Error(`Recording metadata with ID ${recordingId} not found.`);
    }

    if (!recording.driveFileId || recording.driveFileId.startsWith('pending_')) {
      logger.info(`[GoogleRecordingService] Cannot download placeholder recording ${recordingId} - waiting for real Google Drive file matching.`);
      return null;
    }

    const safeBase = recording.fileName.replace(/[^a-zA-Z0-9_\-.]/g, '_');
    const videoFileName = `${recording.id}_${safeBase.endsWith('.mp4') ? safeBase : safeBase + '.mp4'}`;
    const destinationPath = path.join(VIDEO_DIR, videoFileName);

    logger.info(`Starting download of video file ID ${recording.driveFileId} to ${destinationPath}`);

    try {
      const stream = await GoogleDriveService.downloadFileStream(
        recording.meeting.organizerEmail,
        recording.driveFileId
      );

      const writeStream = fs.createWriteStream(destinationPath);
      stream.pipe(writeStream);

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        stream.on('error', reject);
      });

      let finalVideoPath = destinationPath;
      if (S3Storage.isS3Enabled()) {
        const s3Key = getS3KeyForRecording(recording.id, recording.fileName, 'video');
        logger.info(`[GoogleRecordingService] S3 is enabled. Uploading video to S3 key: ${s3Key}`);
        await S3Storage.uploadFile(destinationPath, s3Key, getMimeType(destinationPath));
        
        try {
          fs.unlinkSync(destinationPath);
          logger.info(`[GoogleRecordingService] Cleaned up local video file: ${destinationPath}`);
        } catch (unlinkErr: any) {
          logger.warn(`[GoogleRecordingService] Failed to clean up local file: ${unlinkErr.message}`);
        }
        
        finalVideoPath = s3Key;
      }

      await db.meetingRecording.update({
        where: { id: recordingId },
        data: {
          videoPath: finalVideoPath,
          downloadStatus: 'COMPLETED',
        },
      });

      logger.info(`Successfully downloaded video recording file: ${recording.fileName}`);

      // Auto-trigger audio extraction!
      logger.info(`[GoogleRecordingService] Auto-triggering audio extraction for: ${recording.fileName}`);
      GoogleRecordingService.extractAudioFromRecording(recordingId).catch(err => {
        logger.error(`[GoogleRecordingService] Auto audio extraction failed for ${recordingId}: ${err.message}`);
      });

      return finalVideoPath;
    } catch (err: any) {
      logger.error(`Failed to download recording file: ${err.message}`);
      await db.meetingRecording.update({
        where: { id: recordingId },
        data: { downloadStatus: 'FAILED' },
      });
      throw err;
    }
  }

  /**
   * Public entry point. Deduplicated per recording, and capped so N ending
   * classes cannot spawn N simultaneous ffmpeg processes.
   */
  static async extractAudioFromRecording(recordingId: string, format: 'mp3' | 'wav' = 'mp3'): Promise<string> {
    return extractionsInFlight.run(recordingId, () =>
      ffmpegSemaphore.run(() => GoogleRecordingService.runAudioExtraction(recordingId, format))
    );
  }

  private static async runAudioExtraction(recordingId: string, format: 'mp3' | 'wav' = 'mp3'): Promise<string> {
    const recording = await db.meetingRecording.findUnique({
      where: { id: recordingId },
    });

    if (!recording) {
      throw new Error(`Recording metadata not found.`);
    }

    let localVideoPath = recording.videoPath || '';
    let isVideoOnS3 = false;

    // Auto-download video from Google Drive if missing or null
    if (!localVideoPath || !fs.existsSync(localVideoPath)) {
      if (recording.driveFileId && !recording.driveFileId.startsWith('pending_')) {
        logger.info(`[GoogleRecordingService] Video missing locally. Auto-downloading file from Google Drive before extracting audio: ${recording.id}`);
        const downloadedPath = await GoogleRecordingService.downloadRecordingFile(recordingId);
        if (downloadedPath) {
          localVideoPath = downloadedPath;
        }
      }
    }

    if (S3Storage.isS3Enabled() && localVideoPath && !fs.existsSync(localVideoPath)) {
      if (!recording.videoPath) {
        throw new Error('Recording has no videoPath recorded — cannot download it from S3.');
      }
      const tempBase = path.basename(localVideoPath);
      localVideoPath = path.join(VIDEO_DIR, `temp-${Date.now()}-${tempBase}`);
      logger.info(`[GoogleRecordingService] Video is on S3. Downloading S3 key ${recording.videoPath} to local temp path: ${localVideoPath}`);
      await S3Storage.downloadFile(recording.videoPath, localVideoPath);
      isVideoOnS3 = true;
    }

    if (!localVideoPath || !fs.existsSync(localVideoPath)) {
      throw new Error(`Video file is downloading from Google Drive. Please wait for download to complete.`);
    }

    const currentStats = fs.statSync(localVideoPath);
    if (recording.fileSize && recording.fileSize > 10000000 && currentStats.size < recording.fileSize * 0.95) {
      const downloadedMb = (currentStats.size / (1024 * 1024)).toFixed(1);
      const totalMb = (recording.fileSize / (1024 * 1024)).toFixed(1);
      throw new Error(`Video download in progress (${downloadedMb} MB / ${totalMb} MB). Please wait a moment for download to finish.`);
    }

    const audioFileName = `${path.basename(localVideoPath, '.mp4')}.${format}`;
    const destinationPath = path.join(AUDIO_DIR, audioFileName);

    logger.info(`Extracting audio in ${format.toUpperCase()} format to ${destinationPath}`);

    return new Promise<string>(async (resolve, reject) => {
      // Dev fallback: Skip running ffmpeg on mock files and return a mock audio file
      if (
        recording.id.startsWith('mock') ||
        recording.driveFileId === 'mock_drive_file_id_mp4' ||
        (fs.existsSync(localVideoPath) && fs.statSync(localVideoPath).size < 100)
      ) {
        logger.info(`[GoogleRecordingService] Dev fallback: Creating mock audio file instead of running ffmpeg.`);
        fs.writeFileSync(destinationPath, 'Mock MP3 audio content');

        let finalAudioPath = destinationPath;
        if (S3Storage.isS3Enabled()) {
          const s3Key = getS3KeyForRecording(recording.id, recording.fileName, 'audio');
          logger.info(`[GoogleRecordingService] Uploading mock audio to S3 key: ${s3Key}`);
          await S3Storage.uploadFile(destinationPath, s3Key, getMimeType(destinationPath));
          
          try { fs.unlinkSync(destinationPath); } catch (_) {}
          finalAudioPath = s3Key;
        }

        if (isVideoOnS3 && fs.existsSync(localVideoPath)) {
          try { fs.unlinkSync(localVideoPath); } catch (_) {}
        }

        await db.meetingRecording.update({
          where: { id: recordingId },
          data: {
            audioPath: finalAudioPath,
            extractedAudioStatus: 'COMPLETED',
            audioExtractedAt: new Date(),
          },
        });

        logger.info(`Successfully created mock audio track: ${finalAudioPath}`);
        
        logger.info(`[GoogleRecordingService] Auto-triggering transcription for recording ID: ${recordingId}`);
        GoogleRecordingService.transcribeRecording(recordingId).catch(err => {
          logger.error(`[GoogleRecordingService] Auto transcription failed for ${recordingId}: ${err.message}`);
        });

        return resolve(finalAudioPath);
      }

      let ffmpegPath = 'ffmpeg';
      try {
        ffmpegPath = require('@ffmpeg-installer/ffmpeg').path || require('ffmpeg-static') || 'ffmpeg';
      } catch (e) {
        try {
          ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
        } catch (_) {}
      }

      const { execFile } = require('child_process');
      const ffmpegArgs = ['-y', '-i', localVideoPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', destinationPath];

      execFile(ffmpegPath, ffmpegArgs, async (error: any) => {
        if (isVideoOnS3 && fs.existsSync(localVideoPath)) {
          try { fs.unlinkSync(localVideoPath); } catch (_) {}
        }

        if (error) {
          logger.error(`FFmpeg audio extraction failed: ${error.message}`);
          // If video file was corrupted (e.g. moov atom not found), remove corrupted file so it re-downloads fresh
          if (fs.existsSync(localVideoPath)) {
            try { fs.unlinkSync(localVideoPath); } catch (_) {}
          }
          await db.meetingRecording.update({
            where: { id: recordingId },
            data: { extractedAudioStatus: 'FAILED', videoPath: null },
          }).catch(() => {});
          return reject(new Error(`Audio extraction failed. Video will re-download on next scan.`));
        }

        /* Measure what ffmpeg actually produced before anything trusts it.
         *
         * A resample that goes wrong writes a track several times longer than
         * the class, and a half-downloaded source writes a short one. Both are
         * valid MP3 files, so nothing downstream notices — the transcription
         * model simply returns nonsense for slowed-down speech, and the parent
         * gets a confident report built from it. Cheaper to catch here. */
        try {
          const audioSeconds = await probeDurationSeconds(destinationPath);
          const sizeBytes = fs.existsSync(destinationPath) ? fs.statSync(destinationPath).size : 0;
          const expected = recording.duration ?? null;

          if (sizeBytes < 4096 || audioSeconds === null) {
            throw new Error('the extracted file is empty or has no readable duration');
          }
          if (expected && Math.abs(audioSeconds - expected) > Math.max(5, expected * 0.05)) {
            throw new Error(
              `it is ${Math.round(audioSeconds)}s but the recording is ${Math.round(expected)}s ` +
                `(${(audioSeconds / expected).toFixed(2)}x)`
            );
          }
          logger.info(
            `[GoogleRecordingService] Audio verified: ${Math.round(audioSeconds)}s, ` +
              `${(sizeBytes / 1048576).toFixed(1)} MB.`
          );
        } catch (verifyErr: any) {
          logger.error(
            `[GoogleRecordingService] Discarding the extracted audio for ${recordingId} — ${verifyErr.message}. ` +
              'Sending it to the AI would produce a wrong report rather than an obvious failure.'
          );
          try { fs.unlinkSync(destinationPath); } catch (_) {}
          await db.meetingRecording.update({
            where: { id: recordingId },
            data: { extractedAudioStatus: 'FAILED', videoPath: null },
          }).catch(() => {});
          return reject(new Error(`Audio extraction produced an unusable track — ${verifyErr.message}.`));
        }


        let finalAudioPath = destinationPath;
        if (S3Storage.isS3Enabled()) {
          try {
            const s3Key = getS3KeyForRecording(recording.id, recording.fileName, 'audio');
            logger.info(`[GoogleRecordingService] Uploading audio to S3 key: ${s3Key}`);
            await S3Storage.uploadFile(destinationPath, s3Key, getMimeType(destinationPath));
            
            try { fs.unlinkSync(destinationPath); } catch (_) {}
            finalAudioPath = s3Key;
          } catch (uploadErr: any) {
            logger.error(`[GoogleRecordingService] Failed to upload audio to S3: ${uploadErr.message}`);
            await db.meetingRecording.update({
              where: { id: recordingId },
              data: { extractedAudioStatus: 'FAILED' },
            });
            return reject(uploadErr);
          }
        }

        await db.meetingRecording.update({
          where: { id: recordingId },
          data: {
            audioPath: finalAudioPath,
            extractedAudioStatus: 'COMPLETED',
            audioExtractedAt: new Date(),
          },
        });

        logger.info(`Successfully extracted audio track: ${finalAudioPath}`);

        logger.info(`[GoogleRecordingService] Auto-triggering transcription for recording ID: ${recordingId}`);
        GoogleRecordingService.transcribeRecording(recordingId).catch(err => {
          logger.error(`[GoogleRecordingService] Auto transcription failed for ${recordingId}: ${err.message}`);
        });

        resolve(finalAudioPath);
      });
    });
  }

  static async transcribeRecording(recordingId: string) {
    try {
      const recording = await db.meetingRecording.findUnique({
        where: { id: recordingId },
        include: { meeting: true },
      });

      if (!recording || !recording.meeting || !recording.audioPath) {
        throw new Error(`Recording metadata, meeting information, or audio path is missing.`);
      }

      logger.info(`[GoogleRecordingService] Sending transcription request to learning-service for recording ${recordingId}`);
      
      const learnServiceUrl = process.env.LEARN_SERVICE_URL || 'http://localhost:3002';
      
      let audioPathToSend = recording.audioPath;
      if (S3Storage.isS3Enabled() && !fs.existsSync(recording.audioPath)) {
        logger.info(`[GoogleRecordingService] Generating presigned URL for S3 key: ${recording.audioPath}`);
        audioPathToSend = await S3Storage.getPresignedUrl(recording.audioPath, 3600); // 1 hour expiration
      }

      const transcribeRes = await fetch(`${learnServiceUrl}/transcription/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioFilePath: audioPathToSend,
          meetUrl: recording.meeting.meetUrl,
          studentId: recording.meeting.studentId,
          teacherId: recording.meeting.teacherId,
          // Identity of the LESSON, not just the room. One Meet link is reused by
          // every session of a programme, so learning-service matching on the URL
          // alone wrote the summary onto whichever of the 40 classes Prisma
          // happened to return first.
          sessionId: recording.meeting.sessionId,
          programId: recording.meeting.programId,
          startTime: recording.meeting.startTime?.toISOString(),
          endTime: recording.meeting.endTime?.toISOString(),
          // For the AI usage ledger and error log.
          recordingId: recording.id,
          // Real recording length, so the report can print a true duration and
          // split talk time over it.
          audioSeconds: recording.duration ?? undefined,
        }),
      });

      if (!transcribeRes.ok) {
        const errText = await transcribeRes.text();
        throw new Error(`learning-service transcription returned status ${transcribeRes.status}: ${errText}`);
      }

      const body = await transcribeRes.json() as any;
      const result = body?.data;

      if (result && result.transcript) {
        logger.info(`[GoogleRecordingService] Transcription completed. Writing transcript...`);
        if (!recording.videoPath) {
          throw new Error('No videoPath found on meetingRecording to write the transcript alongside.');
        }

        if (S3Storage.isS3Enabled()) {
          const s3Key = getS3KeyForRecording(recording.id, recording.fileName, 'transcript');
          logger.info(`[GoogleRecordingService] S3 is enabled. Uploading transcript directly to S3: ${s3Key}`);
          await S3Storage.uploadBuffer(result.transcript, s3Key, 'text/plain');
        } else {
          const transcriptPath = recording.videoPath + '.transcript.txt';
          fs.writeFileSync(transcriptPath, result.transcript);
          logger.info(`[GoogleRecordingService] Successfully saved transcript at: ${transcriptPath}`);
        }

        // Persist the AI summary too, so the dashboard has nothing left to compute.
        //
        // learning-service already returns classSummary here, but it used to be
        // discarded — the summary was only produced later, on demand, when someone
        // opened the recording modal. That made every first view wait ~10s on a
        // live Groq call. Writing it now means the class ends, the pipeline runs,
        // and the summary is simply there when anyone looks.
        //
        // Placeholder output (no GROQ_API_KEY) is deliberately not cached; caching
        // it once is what previously pinned a fake summary in place permanently.
        if (result.classSummary && !result.usedFallback) {
          try {
            if (S3Storage.isS3Enabled()) {
              const s3Key = getS3KeyForRecording(recording.id, recording.fileName, 'summary');
              await S3Storage.uploadBuffer(result.classSummary, s3Key, 'text/plain');
              logger.info(`[GoogleRecordingService] Pre-generated AI summary uploaded to S3: ${s3Key}`);
            } else {
              const summaryPath = recording.videoPath + '.summary.txt';
              fs.writeFileSync(summaryPath, result.classSummary, 'utf-8');
              logger.info(`[GoogleRecordingService] Pre-generated AI summary saved at: ${summaryPath}`);
            }
          } catch (summaryErr: any) {
            // Non-fatal: the modal can still generate it on demand.
            logger.warn(`[GoogleRecordingService] Could not persist AI summary: ${summaryErr.message}`);
          }
        } else if (result.usedFallback) {
          logger.error(
            `[GoogleRecordingService] learning-service returned placeholder output for ${recordingId} — not caching a fake summary.`
          );
        }

        await recordTranscriptionSuccess(recordingId);

        // Returned so a caller WAITING on this — the admin's "generate
        // transcript" button — can render the result straight away rather than
        // polling for the file this just wrote.
        return result as { transcript: string; classSummary?: string; usedFallback?: boolean };
      } else {
        throw new Error('No transcript text returned in the learning-service response data.');
      }
    } catch (err: any) {
      logger.error(`[GoogleRecordingService] Transcription background job failed: ${err.message}`);
      // Schedules the retry. A quota rejection is not a broken recording — it
      // is the same recording, sent too soon.
      await recordTranscriptionFailure(recordingId, err?.message ?? String(err));
      throw err;
    }
  }
}
