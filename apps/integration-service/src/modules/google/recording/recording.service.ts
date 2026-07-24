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

    logger.info(`Searching Google Drive for recording matching meeting: ${meeting.title}`);
    // Search by title prefix or generic keywords
    const files = await GoogleDriveService.searchMeetRecordings(
      meeting.organizerEmail,
      meeting.title
    );

    if (files.length === 0) {
      logger.warn(`No recordings found on Google Drive for meeting title: ${meeting.title}`);
      return null;
    }

    // Map the most recent matching recording
    const driveFile = files[0];

    const recording = await db.meetingRecording.upsert({
      where: { driveFileId: driveFile.id },
      update: {
        fileName: driveFile.name,
        fileSize: driveFile.size,
      },
      create: {
        meetingId: meeting.id,
        driveFileId: driveFile.id,
        fileName: driveFile.name,
        fileSize: driveFile.size,
        downloadStatus: 'PENDING',
        extractedAudioStatus: 'PENDING',
      },
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

    const videoFileName = `${recording.id}_${recording.fileName}`;
    const destinationPath = path.join(VIDEO_DIR, videoFileName);

    logger.info(`Starting download of recording file ID ${recording.driveFileId} to ${destinationPath}`);

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

      logger.info(`Successfully downloaded recording for meeting: ${recording.meeting.title}`);
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
      throw new Error(`Recording video file must be downloaded before extracting audio.`);
    }

    if (!fs.existsSync(recording.videoPath)) {
      throw new Error(`Local video file is missing from path: ${recording.videoPath}`);
    }

    const audioFileName = `${path.basename(recording.videoPath, '.mp4')}.${format}`;
    const destinationPath = path.join(AUDIO_DIR, audioFileName);

    logger.info(`Extracting audio in ${format.toUpperCase()} format to ${destinationPath}`);

    return new Promise<string>((resolve, reject) => {
      // ffmpeg parameters:
      // -y: overwrite output file
      // -i: input file
      // -q:a 0 (for MP3 variable bitrate) or simple copy
      // -map a: extract audio streams only
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
