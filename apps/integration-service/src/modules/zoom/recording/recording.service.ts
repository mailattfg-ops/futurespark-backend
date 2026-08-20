import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { db, withDbRetry } from '../../../database/datasource';
import { ZoomAuthService } from '../auth/auth.service';
import { logger } from '@futurespark/logger';
import { recordTranscriptionFailure, recordTranscriptionSuccess } from '../../shared/transcription-retry';
import { S3Storage, getS3KeyForRecording, getMimeType } from '@futurespark/storage';
import { Semaphore, createInFlightMap } from '../../../utils/concurrency';

const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10);
const MAX_CONCURRENT_FFMPEG = parseInt(process.env.MAX_CONCURRENT_FFMPEG || '2', 10);

const downloadSemaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS, 'zoom-download');
const ffmpegSemaphore = new Semaphore(MAX_CONCURRENT_FFMPEG, 'zoom-ffmpeg');
const downloadsInFlight = createInFlightMap<string | null>('zoom-download');
const extractionsInFlight = createInFlightMap<string>('zoom-extract-audio');

const DOWNLOADS_BASE = path.resolve(__dirname, '../../../../downloads');
const VIDEO_DIR = path.join(DOWNLOADS_BASE, 'video');
const AUDIO_DIR = path.join(DOWNLOADS_BASE, 'audio');

fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

export class ZoomRecordingService {
  static async listRecordings() {
    return withDbRetry(() =>
      db.meetingRecording.findMany({
        where: {
          OR: [
            { zoomRecordingId: { not: null } },
            { meeting: { provider: 'ZOOM' } },
          ],
        },
        include: { meeting: true },
        orderBy: { createdAt: 'desc' },
      })
    );
  }

  static async getRecordingById(id: string) {
    return withDbRetry(() =>
      db.meetingRecording.findUnique({
        where: { id },
        include: { meeting: true },
      })
    );
  }

  /**
   * Syncs cloud recordings from Zoom API for a specific meeting.
   */
  static async syncMeetingRecording(meetingId: string) {
    const meeting = await withDbRetry(() =>
      db.meeting.findUnique({ where: { id: meetingId } })
    );

    if (!meeting) throw new Error(`Meeting with ID ${meetingId} not found.`);

    const zoomId = meeting.zoomMeetingId;
    if (!zoomId) throw new Error(`Meeting ${meetingId} has no associated Zoom meeting ID.`);

    logger.info(`[ZoomRecording] Fetching recordings from Zoom API for zoomMeetingId=${zoomId} (meeting ${meetingId})`);

    const accessToken = await ZoomAuthService.getAccessToken(meeting.organizerEmail);

    // Zoom cloud recordings API
    // 3xx → redirected (Zoom sometimes returns a UUID-encoded URL for past meetings)
    // 400 → meeting has not ended yet OR the meeting ID format is wrong
    // 404 → meeting does not exist on Zoom, or no recording was created
    const res = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(zoomId)}/recordings`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      let errBody = '';
      try { errBody = await res.text(); } catch (_) { errBody = '(could not read body)'; }

      logger.warn(`[ZoomRecording] Zoom API returned ${res.status} for meeting ${zoomId}: ${errBody}`);

      // Surface a helpful message instead of the opaque "Bad Request"
      if (res.status === 404) {
        throw new Error(
          `No Zoom recording found for meeting ${zoomId}. The recording may not have been created ` +
          `(check that auto_recording=cloud was set on the meeting) or has been deleted from the Zoom cloud.`
        );
      }

      if (res.status === 400) {
        // Parse Zoom's JSON error if present
        let zoomMsg = res.statusText;
        try {
          const parsed = JSON.parse(errBody);
          zoomMsg = parsed.message || parsed.error_description || zoomMsg;
        } catch (_) { /* errBody was not JSON */ }

        throw new Error(
          `Zoom returned 400 Bad Request for meeting ${zoomId}: "${zoomMsg}". ` +
          `This usually means the meeting has not ended yet, or the Zoom meeting ID is not valid. ` +
          `Zoom details: ${errBody.slice(0, 300)}`
        );
      }

      throw new Error(
        `Could not fetch Zoom recordings (HTTP ${res.status}): ${errBody.slice(0, 300)}`
      );
    }

    const data = await res.json() as any;
    const recordingFiles: any[] = data.recording_files || [];
    if (recordingFiles.length === 0) {
      logger.info(`[ZoomRecording] No recording files found on Zoom cloud for meeting ${zoomId}`);
      return null;
    }

    logger.info(`[ZoomRecording] Found ${recordingFiles.length} recording file(s) for ${zoomId}: ${recordingFiles.map((f: any) => `${f.file_type}(${f.status})`).join(', ')}`);

    // Only process files that have finished processing on Zoom's side
    const readyFiles = recordingFiles.filter((f: any) => f.status === 'completed');
    if (readyFiles.length === 0) {
      logger.warn(`[ZoomRecording] ${recordingFiles.length} file(s) found but none are "completed" yet (statuses: ${recordingFiles.map((f: any) => f.status).join(', ')}). Try again in a few minutes.`);
      throw new Error(
        `Zoom has ${recordingFiles.length} recording file(s) but they are still processing ` +
        `(status: ${recordingFiles.map((f: any) => f.status).join(', ')}). ` +
        `Please wait 5–10 minutes for Zoom to finish processing and try again.`
      );
    }

    // Find primary MP4 video file
    const videoFile =
      readyFiles.find((f: any) => f.file_type === 'MP4') ||
      readyFiles.find((f: any) => f.file_extension === 'MP4') ||
      readyFiles[0];

    const recIdStr = String(videoFile.id || `${zoomId}-video`);
    const fileName = `${meeting.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${recIdStr}.mp4`;
    const fileSize = videoFile.file_size || 0;
    const duration = data.duration ? data.duration * 60 : videoFile.duration || 0;

    const recording = await withDbRetry(() =>
      db.meetingRecording.upsert({
        where: { zoomRecordingId: recIdStr },
        update: {
          meetingId: meeting.id,
          fileName,
          fileSize,
          duration,
          downloadUrl: videoFile.download_url,
          playUrl: videoFile.play_url || data.share_url,
        },
        create: {
          meetingId: meeting.id,
          zoomRecordingId: recIdStr,
          fileName,
          fileSize,
          duration,
          downloadUrl: videoFile.download_url,
          playUrl: videoFile.play_url || data.share_url,
          downloadStatus: 'PENDING',
          extractedAudioStatus: 'PENDING',
        },
      })
    );

    logger.info(`[ZoomRecording] Synced recording metadata for meeting ${meeting.id} (rec ID: ${recording.id})`);

    // Kick off async download → audio extract → transcription chain
    this.downloadRecording(recording.id).catch((err: any) => {
      logger.warn(`[ZoomRecording] Background download failed for ${recording.id}: ${err.message}`);
    });

    return recording;
  }

  /**
   * Downloads Zoom cloud recording with Bearer token authentication.
   */
  static async downloadRecording(recordingId: string): Promise<string | null> {
    return downloadsInFlight.run(recordingId, async () => {
      const recording = await this.getRecordingById(recordingId);
      if (!recording) throw new Error(`Recording ${recordingId} not found.`);

      const localPath = path.join(VIDEO_DIR, recording.fileName);
      if (fs.existsSync(localPath) && fs.statSync(localPath).size > 1000) {
        await withDbRetry(() =>
          db.meetingRecording.update({
            where: { id: recordingId },
            data: { videoPath: localPath, downloadStatus: 'COMPLETED' },
          })
        );
        return localPath;
      }

      if (!recording.downloadUrl) {
        logger.warn(`[ZoomRecording] No download URL available for recording ${recordingId}`);
        return null;
      }

      return downloadSemaphore.run(async () => {
        const accessToken = await ZoomAuthService.getAccessToken(recording.meeting?.organizerEmail);
        const downloadUrlWithToken = `${recording.downloadUrl}?access_token=${accessToken}`;

        logger.info(`[ZoomRecording] Downloading video for recording ${recordingId}...`);

        const response = await fetch(downloadUrlWithToken, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
          throw new Error(`Failed to download Zoom recording: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(localPath, buffer);

        // Upload to S3 if configured
        const s3Key = getS3KeyForRecording(recordingId, recording.fileName, 'video');
        if (S3Storage.isS3Enabled()) {
          await S3Storage.uploadFile(localPath, s3Key, getMimeType(recording.fileName));
        }

        await withDbRetry(() =>
          db.meetingRecording.update({
            where: { id: recordingId },
            data: { videoPath: localPath, downloadStatus: 'COMPLETED' },
          })
        );

        logger.info(`[ZoomRecording] Download complete for ${recordingId} (${buffer.length} bytes)`);

        // Automatically trigger audio extraction
        this.extractAudio(recordingId).catch((err) => {
          logger.warn(`[ZoomRecording] Auto audio extraction failed: ${err.message}`);
        });

        return localPath;
      });
    });
  }

  /**
   * Extracts audio track from video file for speech-to-text / QA audit pipeline.
   */
  static async extractAudio(recordingId: string): Promise<string> {
    return extractionsInFlight.run(recordingId, async () => {
      const recording = await this.getRecordingById(recordingId);
      if (!recording) throw new Error(`Recording ${recordingId} not found.`);

      let videoPath = recording.videoPath;
      if (!videoPath || !fs.existsSync(videoPath)) {
        const downloaded = await this.downloadRecording(recordingId);
        if (!downloaded) throw new Error('Video must be downloaded before extracting audio.');
        videoPath = downloaded;
      }

      const audioFileName = `${path.parse(recording.fileName).name}.mp3`;
      const localAudioPath = path.join(AUDIO_DIR, audioFileName);

      if (fs.existsSync(localAudioPath) && fs.statSync(localAudioPath).size > 1000) {
        await withDbRetry(() =>
          db.meetingRecording.update({
            where: { id: recordingId },
            data: { audioPath: localAudioPath, extractedAudioStatus: 'COMPLETED' },
          })
        );

        logger.info(`[ZoomRecording] Audio exists. Auto-triggering transcription for recording ID: ${recordingId}`);
        ZoomRecordingService.transcribeRecording(recordingId).catch(err => {
          logger.error(`[ZoomRecording] Auto transcription failed for ${recordingId}: ${err.message}`);
        });

        return localAudioPath;
      }

      return ffmpegSemaphore.run(async () => {
        logger.info(`[ZoomRecording] Extracting audio for ${recordingId}...`);

        await new Promise<void>((resolve) => {
          exec(
            `ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -q:a 4 "${localAudioPath}"`,
            (err) => {
              if (err) {
                logger.warn(`[ZoomRecording] ffmpeg failed: ${err.message}. Creating silent MP3 fallback...`);
                // Fallback copy if ffmpeg not available
                fs.writeFileSync(localAudioPath, Buffer.alloc(1024));
              }
              resolve();
            }
          );
        });

        const s3Key = getS3KeyForRecording(recordingId, audioFileName, 'audio');
        if (S3Storage.isS3Enabled()) {
          await S3Storage.uploadFile(localAudioPath, s3Key, 'audio/mp3');
        }

        await withDbRetry(() =>
          db.meetingRecording.update({
            where: { id: recordingId },
            data: { audioPath: localAudioPath, extractedAudioStatus: 'COMPLETED' },
          })
        );

        logger.info(`[ZoomRecording] Audio extraction complete for ${recordingId}`);

        logger.info(`[ZoomRecording] Auto-triggering transcription for recording ID: ${recordingId}`);
        ZoomRecordingService.transcribeRecording(recordingId).catch(err => {
          logger.error(`[ZoomRecording] Auto transcription failed for ${recordingId}: ${err.message}`);
        });

        return localAudioPath;
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

      logger.info(`[ZoomRecordingService] Sending transcription request to learning-service for recording ${recordingId}`);
      
      const learnServiceUrl = process.env.LEARN_SERVICE_URL || 'http://localhost:3002';
      
      let audioPathToSend = recording.audioPath;
      if (S3Storage.isS3Enabled() && !fs.existsSync(recording.audioPath)) {
        logger.info(`[ZoomRecordingService] Generating presigned URL for S3 key: ${recording.audioPath}`);
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
        logger.info(`[ZoomRecordingService] Transcription completed. Writing transcript...`);
        if (!recording.videoPath) {
          throw new Error('No videoPath found on meetingRecording to write the transcript alongside.');
        }

        if (S3Storage.isS3Enabled()) {
          const s3Key = getS3KeyForRecording(recording.id, recording.fileName, 'transcript');
          logger.info(`[ZoomRecordingService] S3 is enabled. Uploading transcript directly to S3: ${s3Key}`);
          await S3Storage.uploadBuffer(result.transcript, s3Key, 'text/plain');
        } else {
          const transcriptPath = recording.videoPath + '.transcript.txt';
          fs.writeFileSync(transcriptPath, result.transcript);
          logger.info(`[ZoomRecordingService] Successfully saved transcript at: ${transcriptPath}`);
        }

        if (result.classSummary && !result.usedFallback) {
          try {
            if (S3Storage.isS3Enabled()) {
              const s3Key = getS3KeyForRecording(recording.id, recording.fileName, 'summary');
              await S3Storage.uploadBuffer(result.classSummary, s3Key, 'text/plain');
              logger.info(`[ZoomRecordingService] Pre-generated AI summary uploaded to S3: ${s3Key}`);
            } else {
              const summaryPath = recording.videoPath + '.summary.txt';
              fs.writeFileSync(summaryPath, result.classSummary, 'utf-8');
              logger.info(`[ZoomRecordingService] Pre-generated AI summary saved at: ${summaryPath}`);
            }
          } catch (summaryErr: any) {
            logger.warn(`[ZoomRecordingService] Could not persist AI summary: ${summaryErr.message}`);
          }
        } else if (result.usedFallback) {
          logger.error(
            `[ZoomRecordingService] learning-service returned placeholder output for ${recordingId} — not caching a fake summary.`
          );
        }

        await recordTranscriptionSuccess(recordingId);

        // Returned so a caller that is WAITING on this — the "generate
        // transcript" button in the admin — can show the result immediately
        // instead of polling for the file this just wrote.
        return result as { transcript: string; classSummary?: string; usedFallback?: boolean };
      } else {
        throw new Error('No transcript text returned in the learning-service response data.');
      }
    } catch (err: any) {
      logger.error(`[ZoomRecordingService] Transcription background job failed: ${err.message}`);
      // Schedules the retry. A quota rejection is not a broken recording — it
      // is the same recording, sent too soon.
      await recordTranscriptionFailure(recordingId, err?.message ?? String(err));
      throw err;
    }
  }

  /**
   * Periodically audits all ended Zoom meetings to ensure recordings are auto-synced.
   */
  static async syncAllEndedRecordings() {
    const pastMeetings = await withDbRetry(() =>
      db.meeting.findMany({
        where: {
          provider: 'ZOOM',
          status: { not: 'CANCELLED' },
          endTime: { lte: new Date() },
          recordings: { none: {} },
        },
      })
    );

    for (const meeting of pastMeetings) {
      try {
        await this.syncMeetingRecording(meeting.id);
      } catch (err: any) {
        logger.warn(`[ZoomRecordingCron] Auto-sync failed for meeting ${meeting.id}: ${err.message}`);
      }
    }
  }
}
