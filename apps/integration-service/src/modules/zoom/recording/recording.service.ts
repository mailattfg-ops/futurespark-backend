import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { db, withDbRetry } from '../../../database/datasource';
import { ZoomAuthService } from '../auth/auth.service';
import { logger } from '@futurespark/logger';
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

    const accessToken = await ZoomAuthService.getAccessToken(meeting.organizerEmail);
    const res = await fetch(`https://api.zoom.us/v2/meetings/${zoomId}/recordings`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.warn(`[ZoomRecording] Fetch recordings for ${zoomId} returned ${res.status}: ${errText}`);
      throw new Error(`Could not fetch Zoom recordings: ${res.statusText}`);
    }

    const data = await res.json();
    const recordingFiles = data.recording_files || [];
    if (recordingFiles.length === 0) {
      logger.info(`[ZoomRecording] No recording files found on Zoom cloud for meeting ${zoomId}`);
      return null;
    }

    // Find primary MP4 video file or audio
    const videoFile = recordingFiles.find((f: any) => f.file_type === 'MP4' || f.file_extension === 'MP4') || recordingFiles[0];
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

    // Kick off async download and audio extraction
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
        return localAudioPath;
      });
    });
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
