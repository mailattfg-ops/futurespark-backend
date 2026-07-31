import { Request, Response } from 'express';
import { GoogleRecordingService } from './recording.service';
import { HTTP_STATUS } from '@futurespark/constants';
import { successResponse, errorResponse } from '@futurespark/response';
import { logger } from '@futurespark/logger';
import * as fs from 'fs';

export class GoogleRecordingController {
  static async list(req: Request, res: Response) {
    try {
      const recordings = await GoogleRecordingService.listRecordings();
      return res.status(HTTP_STATUS.OK).json(successResponse(recordings, 'Recordings retrieved successfully.'));
    } catch (err: any) {
      logger.error(`Error listing recordings: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to list recordings'));
    }
  }

  static async sync(req: Request, res: Response) {
    try {
      const { meetingId } = req.body;
      const recordings = await GoogleRecordingService.syncMeetingRecording(meetingId);
      return res.status(HTTP_STATUS.OK).json(successResponse(recordings, 'Meeting recordings synced successfully.'));
    } catch (err: any) {
      logger.error(`Error syncing recording: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Sync failed'));
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
      logger.error(`Error fetching recording: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to fetch recording'));
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
        
        res.status(206);
        res.set({
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize.toString(),
          'Content-Type': contentType,
        });
        file.pipe(res);
      } else {
        res.status(200);
        res.set({
          'Content-Length': fileSize.toString(),
          'Content-Type': contentType,
        });
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
      const audioPath = await GoogleRecordingService.extractAudioFromRecording(id, audioFormat);

      return res.status(HTTP_STATUS.OK).json(successResponse({ audioPath }, 'Audio extraction completed successfully.'));
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

      let transcriptPath = recording.videoPath;
      if (recording.videoPath && !recording.fileName.toLowerCase().includes('transcript')) {
        // Custom transcript text is saved alongside the video file
        transcriptPath = recording.videoPath + '.transcript.txt';
      }

      // 1. Check if transcript file exists on disk
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        const content = fs.readFileSync(transcriptPath, 'utf-8');
        return res.status(HTTP_STATUS.OK).json(successResponse({ content }, 'Transcript loaded successfully.'));
      }

      // 2. Fallback: Query ScheduledClass from auth-service
      if (recording.meeting) {
        const authDbUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
        try {
          const meetCode = recording.meeting.meetUrl.split('/').pop() || '';
          const classRes = await fetch(`${authDbUrl}/schedules?programId=${recording.meeting.programId}`);
          if (classRes.ok) {
            const classData = await classRes.json() as any;
            const schedules = classData?.data || [];
            const matchedClass = schedules.find((s: any) => s.meetingLink && s.meetingLink.includes(meetCode));
            if (matchedClass && matchedClass.transcript) {
              if (transcriptPath) {
                try { fs.writeFileSync(transcriptPath, matchedClass.transcript, 'utf-8'); } catch (_) {}
              }
              return res.status(HTTP_STATUS.OK).json(successResponse({ content: matchedClass.transcript }, 'Transcript loaded successfully.'));
            }
          }
        } catch (e: any) {
          logger.warn(`Failed to fetch transcript from auth service: ${e.message}`);
        }
      }

      // 3. Fallback: If video file exists on disk, generate transcription on-the-fly!
      if (recording.videoPath && fs.existsSync(recording.videoPath)) {
        logger.info(`[GoogleRecordingController] Generating transcript on-the-fly for file: ${recording.fileName}...`);
        const learningUrl = process.env.LEARNING_SERVICE_URL || 'http://localhost:3003';
        const transRes = await fetch(`${learningUrl}/transcription/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioFilePath: recording.videoPath,
            meetUrl: recording.meeting?.meetUrl,
            studentId: recording.meeting?.studentId,
            teacherId: recording.meeting?.teacherId,
          })
        });
        if (transRes.ok) {
          const transData = await transRes.json() as any;
          const content = transData?.data?.transcript;
          if (content) {
            if (transcriptPath) {
              try { fs.writeFileSync(transcriptPath, content, 'utf-8'); } catch (_) {}
            }
            return res.status(HTTP_STATUS.OK).json(successResponse({ content }, 'Transcript generated and loaded successfully.'));
          }
        }
      }

      return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Transcript file not generated yet.'));
    } catch (err: any) {
      logger.error(`Error retrieving transcript content: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to retrieve transcript content'));
    }
  }
}
