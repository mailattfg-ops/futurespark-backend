import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { db } from '../../../database/datasource';
import { GoogleDriveService } from '../drive/drive.service';
import { logger } from '@futurespark/logger';

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
    return db.meetingRecording.findUnique({
      where: { id },
      include: { meeting: true },
    });
  }

  static async syncMeetingRecording(meetingId: string) {
    const meeting = await db.meeting.findUnique({ where: { id: meetingId } });
    if (!meeting) {
      throw new Error(`Meeting with ID ${meetingId} not found in database.`);
    }

    let meetCode = '';
    if (meeting.meetUrl) {
      const urlParts = meeting.meetUrl.split('/');
      meetCode = urlParts[urlParts.length - 1].trim();
    }

    logger.info(`Searching Google Drive for files matching meeting: ${meeting.title} (Code: ${meetCode})`);
    const files = await GoogleDriveService.searchMeetFiles(
      meeting.organizerEmail,
      meeting.title,
      meetCode
    );

    // Only select the video recording file (mp4)
    const selectedFile = files.find(f => f.mimeType === 'video/mp4');

    // Case 1: No file found on Drive
    if (!selectedFile) {
      logger.warn(`No video recording (.mp4) found on Google Drive for meeting title: ${meeting.title}`);
      
      // Check if we already have a recording record for this meeting
      const existing = await db.meetingRecording.findFirst({
        where: { meetingId },
        include: { meeting: true },
      });

      if (existing) {
        return existing;
      }

      // Create a placeholder "PENDING" recording so the UI shows it as pending
      logger.info(`[GoogleRecordingService] Creating placeholder pending recording for meeting: ${meeting.title}`);
      const placeholder = await db.meetingRecording.create({
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
      });

      return placeholder;
    }

    // Case 2: File is found on Drive
    logger.info(`Found video recording "${selectedFile.name}" on Google Drive. Syncing metadata...`);

    // Check if we already have a real recording synced
    const existingReal = await db.meetingRecording.findUnique({
      where: { driveFileId: selectedFile.id },
      include: { meeting: true },
    });

    if (existingReal) {
      return existingReal;
    }

    // Check if we have a placeholder recording for this meeting
    const placeholder = await db.meetingRecording.findFirst({
      where: { 
        meetingId,
        driveFileId: { startsWith: 'pending_' }
      },
    });

    let recording;
    if (placeholder) {
      logger.info(`[GoogleRecordingService] Upgrading placeholder recording to real file ID ${selectedFile.id}`);
      recording = await db.meetingRecording.update({
        where: { id: placeholder.id },
        data: {
          driveFileId: selectedFile.id,
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
          downloadStatus: 'PENDING',
          extractedAudioStatus: 'PENDING',
        },
        include: {
          meeting: true,
        },
      });
    } else {
      recording = await db.meetingRecording.create({
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
      });
    }

    // Auto-trigger background download!
    logger.info(`[GoogleRecordingService] Auto-triggering background download for: ${recording.fileName}`);
    GoogleRecordingService.downloadRecordingFile(recording.id).catch(err => {
      logger.error(`[GoogleRecordingService] Auto background download failed for ${recording.id}: ${err.message}`);
    });

    return recording;
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

      await db.meetingRecording.update({
        where: { id: recordingId },
        data: {
          videoPath: destinationPath,
          downloadStatus: 'COMPLETED',
        },
      });

      logger.info(`Successfully downloaded video recording file: ${recording.fileName}`);

      // Auto-trigger audio extraction!
      logger.info(`[GoogleRecordingService] Auto-triggering audio extraction for: ${recording.fileName}`);
      GoogleRecordingService.extractAudioFromRecording(recordingId).catch(err => {
        logger.error(`[GoogleRecordingService] Auto audio extraction failed for ${recordingId}: ${err.message}`);
      });

      return destinationPath;
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

    if (!fs.existsSync(recording.videoPath)) {
      throw new Error(`Local file is missing from path: ${recording.videoPath}`);
    }

    const audioFileName = `${path.basename(recording.videoPath, '.mp4')}.${format}`;
    const destinationPath = path.join(AUDIO_DIR, audioFileName);

    logger.info(`Extracting audio in ${format.toUpperCase()} format to ${destinationPath}`);

    return new Promise<string>(async (resolve, reject) => {
      // Dev fallback: Skip running ffmpeg on mock files and return a mock audio file
      if (
        recording.id.startsWith('mock') ||
        recording.driveFileId === 'mock_drive_file_id_mp4' ||
        (fs.existsSync(recording.videoPath!) && fs.statSync(recording.videoPath!).size < 100)
      ) {
        logger.info(`[GoogleRecordingService] Dev fallback: Creating mock audio file instead of running ffmpeg.`);
        fs.writeFileSync(destinationPath, 'Mock MP3 audio content');

        await db.meetingRecording.update({
          where: { id: recordingId },
          data: {
            audioPath: destinationPath,
            extractedAudioStatus: 'COMPLETED',
          },
        });

        logger.info(`Successfully created mock audio track: ${destinationPath}`);
        
        // Auto-trigger transcription!
        logger.info(`[GoogleRecordingService] Auto-triggering transcription for recording ID: ${recordingId}`);
        GoogleRecordingService.transcribeRecording(recordingId).catch(err => {
          logger.error(`[GoogleRecordingService] Auto transcription failed for ${recordingId}: ${err.message}`);
        });

        return resolve(destinationPath);
      }

      let ffmpegPath = 'ffmpeg';
      try {
        ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
      } catch (e) {
        // Fallback to system PATH ffmpeg
      }

      const command = `"${ffmpegPath}" -y -i "${recording.videoPath}" -q:a 0 -map a "${destinationPath}"`;

      exec(command, async (error, stdout, stderr) => {
        if (error) {
          logger.error(`FFmpeg audio extraction failed: ${error.message}`);
          await db.meetingRecording.update({
            where: { id: recordingId },
            data: { extractedAudioStatus: 'FAILED' },
          });
          return reject(new Error(`FFmpeg failed: ${error.message}`));
        }

        await db.meetingRecording.update({
          where: { id: recordingId },
          data: {
            audioPath: destinationPath,
            extractedAudioStatus: 'COMPLETED',
          },
        });

        logger.info(`Successfully extracted audio track: ${destinationPath}`);

        // Auto-trigger transcription!
        logger.info(`[GoogleRecordingService] Auto-triggering transcription for recording ID: ${recordingId}`);
        GoogleRecordingService.transcribeRecording(recordingId).catch(err => {
          logger.error(`[GoogleRecordingService] Auto transcription failed for ${recordingId}: ${err.message}`);
        });

        resolve(destinationPath);
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
      
      const transcribeRes = await fetch(`${learnServiceUrl}/transcription/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioFilePath: recording.audioPath,
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
        logger.info(`[GoogleRecordingService] Transcription completed. Writing local transcript text file...`);
        if (!recording.videoPath) {
          throw new Error('No videoPath found on meetingRecording to write the transcript alongside.');
        }
        const transcriptPath = recording.videoPath + '.transcript.txt';

        fs.writeFileSync(transcriptPath, result.transcript);
        logger.info(`[GoogleRecordingService] Successfully saved transcript at: ${transcriptPath}`);
      } else {
        throw new Error('No transcript text returned in the learning-service response data.');
      }
    } catch (err: any) {
      logger.error(`[GoogleRecordingService] Transcription background job failed: ${err.message}`);
      throw err;
    }
  }
}
