import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ZoomRecordingService } from './recording.service';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';

export class ZoomRecordingController {
  static async list(_req: Request, res: Response) {
    try {
      const recordings = await ZoomRecordingService.listRecordings();
      return res.status(HTTP_STATUS.OK).json(successResponse(recordings, 'Zoom recordings fetched successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomRecordingController] list error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to list Zoom recordings.')
      );
    }
  }

  static async get(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const recording = await ZoomRecordingService.getRecordingById(id);
      if (!recording) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Zoom recording not found.'));
      }
      return res.status(HTTP_STATUS.OK).json(successResponse(recording, 'Zoom recording fetched successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomRecordingController] get error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to get Zoom recording.')
      );
    }
  }

  static async sync(req: Request, res: Response) {
    try {
      const { meetingId } = req.body;
      if (meetingId) {
        const recording = await ZoomRecordingService.syncMeetingRecording(meetingId);
        return res.status(HTTP_STATUS.OK).json(successResponse(recording, 'Zoom meeting recording synced successfully.'));
      }

      await ZoomRecordingService.syncAllEndedRecordings();
      return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Zoom recordings auto-sync executed.'));
    } catch (err: any) {
      logger.error(`[ZoomRecordingController] sync error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to sync Zoom recordings.')
      );
    }
  }

  static async download(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const localPath = await ZoomRecordingService.downloadRecording(id);
      return res.status(HTTP_STATUS.OK).json(successResponse({ localPath }, 'Zoom recording download complete.'));
    } catch (err: any) {
      logger.error(`[ZoomRecordingController] download error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to download Zoom recording.')
      );
    }
  }

  static async extractAudio(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const audioPath = await ZoomRecordingService.extractAudio(id);
      return res.status(HTTP_STATUS.OK).json(successResponse({ audioPath }, 'Audio extracted successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomRecordingController] extractAudio error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to extract audio from Zoom recording.')
      );
    }
  }

  static async stream(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const recording = await ZoomRecordingService.getRecordingById(id);

      if (!recording || !recording.videoPath || !fs.existsSync(recording.videoPath)) {
        // Fallback: If not yet downloaded, redirect to playUrl
        if (recording?.playUrl) {
          return res.redirect(recording.playUrl);
        }
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Video file not available on disk yet.'));
      }

      const filePath = recording.videoPath;
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = end - start + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp4',
        };
        res.writeHead(206, head);
        file.pipe(res);
      } else {
        const head = {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4',
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err: any) {
      logger.error(`[ZoomRecordingController] stream error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to stream Zoom recording.')
      );
    }
  }
}
