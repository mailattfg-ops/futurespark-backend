import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { db, withDbRetry } from '../../../database/datasource';
import { GoogleDriveService } from '../drive/drive.service';
import { logger } from '@futurespark/logger';
import { S3Storage, getS3KeyForRecording, getMimeType } from '@futurespark/storage';

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
      meetCode
    );

    // Only select video recording files
    const selectedFile = files.find(f => f.mimeType && f.mimeType.startsWith('video/')) || files[0];

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
        return await withDbRetry(() => db.meetingRecording.update({
          where: { id: existingForMeeting.id },
          data: {
            driveFileId: selectedFile.id,
            fileName: selectedFile.name,
            fileSize: selectedFile.size,
            downloadStatus: 'READY',
          },
          include: { meeting: true },
        }));
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
      logger.warn(`[GoogleRecordingService] DB update failed for recording ${selectedFile.id}: ${err.message}. Returning fallback...`);
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

  static async downloadRecordingFile(recordingId: string) {
    const recording = await db.meetingRecording.findUnique({
      where: { id: recordingId },
      include: { meeting: true },
    });

    if (!recording) {
      throw new Error(`Recording metadata with ID ${recordingId} not found.`);
    }

    if (recording.driveFileId.startsWith('pending_')) {
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

  static async extractAudioFromRecording(recordingId: string, format: 'mp3' | 'wav' = 'mp3') {
    const recording = await db.meetingRecording.findUnique({
      where: { id: recordingId },
    });

    if (!recording || !recording.videoPath) {
      throw new Error(`Recording file must be downloaded before extracting audio.`);
    }

    let localVideoPath = recording.videoPath;
    let isVideoOnS3 = false;

    if (S3Storage.isS3Enabled() && !fs.existsSync(recording.videoPath)) {
      const tempBase = path.basename(recording.videoPath);
      localVideoPath = path.join(VIDEO_DIR, `temp-${Date.now()}-${tempBase}`);
      logger.info(`[GoogleRecordingService] Video is on S3. Downloading S3 key ${recording.videoPath} to local temp path: ${localVideoPath}`);
      await S3Storage.downloadFile(recording.videoPath, localVideoPath);
      isVideoOnS3 = true;
    }

    if (!fs.existsSync(localVideoPath)) {
      throw new Error(`Local file is missing from path: ${localVideoPath}`);
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

      const command = `"${ffmpegPath}" -y -i "${localVideoPath}" -q:a 0 -map a "${destinationPath}"`;

      exec(command, async (error, stdout, stderr) => {
        if (isVideoOnS3 && fs.existsSync(localVideoPath)) {
          try { fs.unlinkSync(localVideoPath); } catch (_) {}
        }

        if (error) {
          logger.error(`FFmpeg audio extraction failed: ${error.message}`);
          await db.meetingRecording.update({
            where: { id: recordingId },
            data: { extractedAudioStatus: 'FAILED' },
          });
          return reject(new Error(`FFmpeg failed: ${error.message}`));
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
      } else {
        throw new Error('No transcript text returned in the learning-service response data.');
      }
    } catch (err: any) {
      logger.error(`[GoogleRecordingService] Transcription background job failed: ${err.message}`);
      throw err;
    }
  }
}
