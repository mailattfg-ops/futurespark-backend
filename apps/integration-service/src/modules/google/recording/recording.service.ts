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

    logger.info(`Searching Google Drive for files matching meeting: ${meeting.title}`);
    const files = await GoogleDriveService.searchMeetFiles(
      meeting.organizerEmail,
      meeting.title
    );

    if (files.length === 0) {
      logger.warn(`No recordings/transcripts found on Google Drive for meeting title: ${meeting.title}`);
      return null;
    }

    const synced = [];
    for (const file of files) {
      const isDoc = file.mimeType === 'application/vnd.google-apps.document';
      const recording = await db.meetingRecording.upsert({
        where: { driveFileId: file.id },
        update: {
          fileName: file.name,
          fileSize: file.size,
        },
        create: {
          meetingId: meeting.id,
          driveFileId: file.id,
          fileName: file.name,
          fileSize: file.size,
          downloadStatus: 'PENDING',
          extractedAudioStatus: isDoc ? 'COMPLETED' : 'PENDING',
        },
      });
      synced.push(recording);
    }

    return synced[0];
  }

  static async downloadRecordingFile(recordingId: string) {
    const recording = await db.meetingRecording.findUnique({
      where: { id: recordingId },
      include: { meeting: true },
    });

    if (!recording) {
      throw new Error(`Recording metadata with ID ${recordingId} not found.`);
    }

    const isTranscript = recording.fileName.toLowerCase().includes('transcript');
    const ext = isTranscript ? '.txt' : '.mp4';
    const videoFileName = `${recording.id}_${recording.fileName.replace(/[^a-zA-Z0-9_\-.]/g, '_')}${ext}`;
    const destinationPath = path.join(VIDEO_DIR, videoFileName);

    logger.info(`Starting download/export of file ID ${recording.driveFileId} to ${destinationPath}`);

    try {
      let stream;
      if (isTranscript) {
        try {
          stream = await GoogleDriveService.exportGoogleDocStream(
            recording.meeting.organizerEmail,
            recording.driveFileId,
            'text/plain'
          );
        } catch (err: any) {
          logger.warn(`Doc export failed: ${err.message}. Retrying media stream download.`);
          stream = await GoogleDriveService.downloadFileStream(
            recording.meeting.organizerEmail,
            recording.driveFileId
          );
        }
      } else {
        stream = await GoogleDriveService.downloadFileStream(
          recording.meeting.organizerEmail,
          recording.driveFileId
        );
      }

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

      logger.info(`Successfully completed file processing for: ${recording.fileName}`);
      return destinationPath;
    } catch (err: any) {
      logger.error(`Failed to process recording/transcript file: ${err.message}`);
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

    if (recording.fileName.toLowerCase().includes('transcript')) {
      throw new Error('Cannot extract audio from a transcript text file.');
    }

    if (!fs.existsSync(recording.videoPath)) {
      throw new Error(`Local file is missing from path: ${recording.videoPath}`);
    }

    const audioFileName = `${path.basename(recording.videoPath, '.mp4')}.${format}`;
    const destinationPath = path.join(AUDIO_DIR, audioFileName);

    logger.info(`Extracting audio in ${format.toUpperCase()} format to ${destinationPath}`);

    return new Promise<string>((resolve, reject) => {
      const command = `ffmpeg -y -i "${recording.videoPath}" -q:a 0 -map a "${destinationPath}"`;

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
        resolve(destinationPath);
      });
    });
  }
}
