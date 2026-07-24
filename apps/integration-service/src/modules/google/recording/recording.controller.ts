import { Request, Response } from 'express';
import { GoogleRecordingService } from './recording.service';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';
import fs from 'fs';
import path from 'path';

export class GoogleRecordingController {
  static async list(req: Request, res: Response) {
    try {
      const recordings = await GoogleRecordingService.listRecordings();
      return res.status(HTTP_STATUS.OK).json(successResponse(recordings, 'Recordings listed successfully.'));
    } catch (err: any) {
      logger.error(`Error listing recordings: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to list recordings'));
    }
  }

  static async get(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const recording = await GoogleRecordingService.getRecordingById(id);
      if (!recording) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Recording not found.'));
      }
      return res.status(HTTP_STATUS.OK).json(successResponse(recording, 'Recording retrieved successfully.'));
    } catch (err: any) {
      logger.error(`Error retrieving recording: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to retrieve recording'));
    }
  }

  static async sync(req: Request, res: Response) {
    try {
      const { meetingId } = req.body;
      if (!meetingId) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Parameter "meetingId" is required.'));
      }

      const result = await GoogleRecordingService.syncMeetingRecording(meetingId);
      if (!result) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('No recording found on Drive for this meeting yet.'));
      }

      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Meeting recording metadata synchronized successfully.'));
    } catch (err: any) {
      logger.error(`Error synchronizing recording: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Sync failed'));
    }
  }

  static async download(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const path = await GoogleRecordingService.downloadRecordingFile(id);
      return res.status(HTTP_STATUS.OK).json(successResponse({ localPath: path }, 'Recording download completed.'));
    } catch (err: any) {
      logger.error(`Error downloading recording: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Download failed'));
    }
  }

  static async stream(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const recording = await GoogleRecordingService.getRecordingById(id);
      if (!recording) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Recording not found.'));
      }
      
      const isAudio = req.query.type === 'audio';
      const filePath = (isAudio && recording.audioPath) ? recording.audioPath : recording.videoPath;

      if (!filePath || !fs.existsSync(filePath)) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(
          errorResponse(isAudio ? 'Recording audio file not extracted yet.' : 'Recording video file not downloaded locally yet.')
        );
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;
      const contentType = isAudio ? 'audio/mpeg' : 'video/mp4';

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': contentType,
        };
        res.writeHead(206, head);
        file.pipe(res);
      } else {
        const head = {
          'Content-Length': fileSize,
          'Content-Type': contentType,
        };
        res.writeHead(HTTP_STATUS.OK, head);
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err: any) {
      logger.error(`Error streaming recording: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Stream failed'));
    }
  }

  static async extractAudio(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { format } = req.body; // 'mp3' or 'wav'
      
      const audioFormat = format === 'wav' ? 'wav' : 'mp3';
      const path = await GoogleRecordingService.extractAudioFromRecording(id, audioFormat);

      return res.status(HTTP_STATUS.OK).json(successResponse({ audioPath: path }, 'Audio extraction completed successfully.'));
    } catch (err: any) {
      logger.error(`Error extracting audio: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Audio extraction failed'));
    }
  }

  static async getTranscriptContent(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const recording = await GoogleRecordingService.getRecordingById(id);
      
      if (!recording) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Transcript not found.'));
      }

      if (!recording.videoPath || !fs.existsSync(recording.videoPath)) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Transcript file not downloaded yet.'));
      }

      const content = fs.readFileSync(recording.videoPath, 'utf-8');
      return res.status(HTTP_STATUS.OK).json(successResponse({ content }, 'Transcript loaded successfully.'));
    } catch (err: any) {
      logger.error(`Error loading transcript text: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to read transcript file'));
    }
  }
}
