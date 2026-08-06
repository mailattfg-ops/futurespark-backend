import { Request, Response } from 'express';
import { GoogleRecordingService } from './recording.service';
import { HTTP_STATUS } from '@futurespark/constants';
import { successResponse, errorResponse } from '@futurespark/response';
import { logger } from '@futurespark/logger';
import * as fs from 'fs';
import { S3Storage, getS3KeyForRecording } from '@futurespark/storage';
import * as path from 'path';

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
      const recording = await GoogleRecordingService.syncMeetingRecording(meetingId);
      if (!recording || (recording as any).driveFileId?.startsWith('pending_')) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('No recording video file found on Google Drive for this meeting link.'));
      }
      return res.status(HTTP_STATUS.OK).json(successResponse(recording, 'Meeting recordings synced successfully.'));
    } catch (err: any) {
      logger.error(`Error syncing recording: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Sync failed'));
    }
  }

  static async linkDriveUrl(req: Request, res: Response) {
    try {
      const { meetingId, driveUrl } = req.body;
      if (!meetingId || !driveUrl) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('meetingId and driveUrl are required.'));
      }
      logger.info(`[GoogleRecordingController] Linking direct Drive URL ${driveUrl} to meeting ${meetingId}`);
      const recording = await GoogleRecordingService.linkDriveFileToMeeting(meetingId, driveUrl);
      return res.status(HTTP_STATUS.OK).json(successResponse(recording, 'Google Drive video linked successfully!'));
    } catch (err: any) {
      logger.error(`Error linking Drive URL: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to link Drive video.'));
    }
  }

  static async remove(req: Request, res: Response) {
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

      // 1. Prefer local disk file if present (Enables HTTP 206 Partial Content seeking!)
      const rawFilePath = (isAudio && recording.audioPath) ? recording.audioPath : recording.videoPath;
      let filePath = rawFilePath;

      if (S3Storage.isS3Enabled() && filePath && !fs.existsSync(filePath)) {
        const presignedUrl = await S3Storage.getPresignedUrl(filePath, 3600);
        logger.info(`[GoogleRecordingController] Redirecting stream request to S3 presigned URL: ${presignedUrl}`);
        return res.redirect(presignedUrl);
      }
      if (filePath && !path.isAbsolute(filePath)) {
        filePath = path.resolve(process.cwd(), 'apps/integration-service', filePath);
        if (!fs.existsSync(filePath)) {
          filePath = path.resolve(process.cwd(), rawFilePath!);
        }
      }

      if (filePath && fs.existsSync(filePath)) {
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
        return;
      }

      // 2. Direct Cloud Streaming from Google Drive if file is not local yet
      if (recording.driveFileId && !recording.driveFileId.startsWith('mock_') && !recording.driveFileId.startsWith('pending_')) {
        try {
          logger.info(`[GoogleRecordingController] Direct Live Cloud Streaming for file ID: ${recording.driveFileId} from Google Drive...`);
          const { GoogleDriveService } = await import('../drive/drive.service');
          const driveStream = await GoogleDriveService.downloadFileStream(
            recording.meeting?.organizerEmail || 'rec@meet.finquojunior.com',
            recording.driveFileId
          );

          res.status(200);
          res.set({
            'Content-Type': isAudio ? 'audio/mpeg' : 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600',
          });
          driveStream.pipe(res);
          return;
        } catch (e: any) {
          logger.warn(`Direct Google Drive cloud stream failed (${e.message}). Falling back...`);
        }
      }

      return res.status(HTTP_STATUS.NOT_FOUND).json(
        errorResponse(isAudio ? 'Recording audio file not available.' : 'Recording video file not available.')
      );
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

      // ?refresh=1 bypasses every cache layer and re-runs the Groq pipeline.
      // Without it the disk/S3/DB caches below short-circuit the handler, so the
      // "Re-run Live Groq AI Transcription" button could never actually re-run.
      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';

      let summaryPath = recording.videoPath ? recording.videoPath + '.summary.txt' : '';
      let transcriptPath = recording.videoPath ? recording.videoPath + '.transcript.txt' : '';

      if (forceRefresh) {
        logger.info(`[GoogleRecordingController] refresh=1 — bypassing cached summary for recording ${id}`);
        if (summaryPath && fs.existsSync(summaryPath)) {
          try {
            fs.unlinkSync(summaryPath);
            logger.info(`[GoogleRecordingController] Removed stale cached summary: ${summaryPath}`);
          } catch (unlinkErr: any) {
            logger.warn(`[GoogleRecordingController] Could not remove cached summary: ${unlinkErr.message}`);
          }
        }
      }

      // 1. Check if real Groq AI summary file or S3 is enabled and file is not local, then fetch from S3
      if (!forceRefresh && S3Storage.isS3Enabled() && transcriptPath && !fs.existsSync(transcriptPath)) {
        try {
          const s3Key = getS3KeyForRecording(recording.id, recording.fileName, 'transcript');
          logger.info(`[GoogleRecordingController] Fetching transcript from S3 key: ${s3Key}`);
          const content = await S3Storage.downloadBuffer(s3Key);
          return res.status(HTTP_STATUS.OK).json(successResponse({ content }, 'Transcript loaded successfully.'));
        } catch (s3Err: any) {
          logger.warn(`[GoogleRecordingController] S3 transcript fetch failed: ${s3Err.message}`);
        }
      }

      // Check if transcript file exists on disk
      if (!forceRefresh && summaryPath && fs.existsSync(summaryPath)) {
        let content = fs.readFileSync(summaryPath, 'utf-8');
        if (content.includes('UNIFIED MASTER CLASS SUMMARY') || content.includes('TRANSCRIPT') || content.length > 50) {
          return res.status(HTTP_STATUS.OK).json(successResponse({ content }, 'Master Groq AI Summary & Transcript loaded successfully.'));
        }
      }

      // 2. Fallback: Query ScheduledClass from auth-service
      if (!forceRefresh && recording.meeting) {
        const authDbUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
        try {
          const rawCode = recording.meeting.meetUrl.split('/').pop() || '';
          const meetCode = rawCode.split('?')[0].split('#')[0].trim();
          const classRes = await fetch(`${authDbUrl}/schedules?programId=${recording.meeting.programId}`);
          if (classRes.ok) {
            const classData = await classRes.json() as any;
            const schedules = classData?.data || [];
            const matchedClass = schedules.find((s: any) => s.meetingLink && s.meetingLink.includes(meetCode));
            if (matchedClass && (matchedClass.classSummary || matchedClass.transcript)) {
              let summaryContent = matchedClass.classSummary || matchedClass.transcript;
              if (summaryContent && summaryContent.includes('FULL TRANSCRIPT')) {
                summaryContent = summaryContent.split('FULL TRANSCRIPT')[0].replace(/=+\s*$/g, '').trim();
              }
              if (summaryPath) {
                try { fs.writeFileSync(summaryPath, summaryContent, 'utf-8'); } catch (_) { }
              }
              return res.status(HTTP_STATUS.OK).json(successResponse({ content: summaryContent }, 'Master AI Summary & Transcript loaded successfully.'));
            }
          }
        } catch (e: any) {
          logger.warn(`Failed to fetch transcript from auth service: ${e.message}`);
        }
      }

      // Extract dynamic session metadata (Student, Mentor, Topic Title)
      let title = recording.fileName ? recording.fileName.replace(/\.mp4$/i, '').replace(/_Recording.*$/i, '') : 'Class Session';
      let studentName = 'shihad Z';
      let mentorName = 'mentor 1';

      if (recording.meeting) {
        if (recording.meeting.title) title = recording.meeting.title;

        const rawStudent = (recording.meeting as any).student?.name || recording.meeting.studentId;
        if (rawStudent && !/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(rawStudent)) {
          studentName = rawStudent;
        } else if (title.includes('|')) {
          const parts = title.split('|');
          if (parts[1]) studentName = parts[1].split('-')[0].trim();
        }

        const rawMentor = (recording.meeting as any).teacher?.name || recording.meeting.teacherId;
        if (rawMentor && !/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(rawMentor)) {
          mentorName = rawMentor;
        }
      }

      // Auto-discover local downloaded video file if DB videoPath is empty
      if (!recording.videoPath || !fs.existsSync(recording.videoPath)) {
        const videoDir = path.resolve(__dirname, '../../../../downloads/video');
        if (fs.existsSync(videoDir)) {
          const files = fs.readdirSync(videoDir);
          const localFile = files.find(f => f.startsWith(recording.id) && f.endsWith('.mp4'));
          if (localFile) {
            recording.videoPath = path.join(videoDir, localFile);
            summaryPath = recording.videoPath + '.summary.txt';
            logger.info(`[GoogleRecordingController] Auto-discovered local video file: ${recording.videoPath}`);
            const { db: dbClient } = require('../../../database/datasource');
            dbClient.meetingRecording.update({
              where: { id: recording.id },
              data: { videoPath: recording.videoPath, downloadStatus: 'COMPLETED' },
            }).catch(() => {});
          }
        }
      }

      // If video is on Google Drive and missing or not on disk, trigger background download for Groq AI transcription
      if ((!recording.videoPath || !fs.existsSync(recording.videoPath)) && recording.driveFileId && !recording.driveFileId.startsWith('mock_') && !recording.driveFileId.startsWith('pending_')) {
        logger.info(`[GoogleRecordingController] Triggering background download from Google Drive for Groq AI transcription: ${recording.fileName}`);
        GoogleRecordingService.downloadRecordingFile(recording.id).catch((downloadErr: any) => {
          logger.warn(`[GoogleRecordingController] Background download failed: ${downloadErr.message}`);
        });
      }

      // If video exists locally on disk, invoke GroqTranscriptionService pipeline
      if (recording.videoPath && fs.existsSync(recording.videoPath)) {
        try {
          logger.info(`[GoogleRecordingController] Running GroqTranscriptionService pipeline for: ${recording.videoPath}`);
          const groqModulePath = '../../../../../learning-service/src/modules/transcription/groq-transcription.service';
          const { GroqTranscriptionService } = require(groqModulePath);
          const groqService = new GroqTranscriptionService();
          const result = await groqService.processClassAudio(recording.videoPath, studentName, mentorName);
          if (result && result.classSummary) {
            // Only cache genuine AI output. Caching the placeholder is what pinned
            // stale "mentor Instructor / student Student" summaries permanently.
            if (summaryPath && !result.usedFallback) {
              try { fs.writeFileSync(summaryPath, result.classSummary, 'utf-8'); } catch (_) { }
            } else if (result.usedFallback) {
              logger.error(`[GoogleRecordingController] Groq returned placeholder output for ${recording.id} — not caching to ${summaryPath}`);
            }
            return res.status(HTTP_STATUS.OK).json(successResponse({ content: result.classSummary }, 'Master Groq AI Summary loaded successfully.'));
          }
        } catch (groqErr: any) {
          logger.error(`[GoogleRecordingController] Groq processing error: ${groqErr?.message || groqErr}`);
          // Return a structured session summary fallback instead of 500 Internal Server Error
          const fallbackSummary = `================================================================================
                    UNIFIED MASTER CLASS SUMMARY & METRICS
================================================================================
📌 Class Topic: ${title}
👤 Student: ${studentName}
👨‍🏫 Mentor: ${mentorName}
📅 Session Date: ${new Date().toLocaleDateString('en-US', { dateStyle: 'medium' })}

--------------------------------------------------------------------------------
💡 AI SUMMARY STATUS
--------------------------------------------------------------------------------
• Video File: ${recording.fileName}
• Status: Audio processing / AI Transcription pending (${groqErr?.message || 'Awaiting Groq API key configuration'}).
• Video playback is fully available on the left player.

--------------------------------------------------------------------------------
📌 SESSION HIGHLIGHTS
--------------------------------------------------------------------------------
1. Live Interactive Discussion between ${studentName} and ${mentorName}.
2. Covered core principles & concepts for ${title}.
3. Hands-on exercises and Q&A session.`;

          return res.status(HTTP_STATUS.OK).json(
            successResponse({ content: fallbackSummary }, 'Session Summary loaded (fallback format).')
          );
        }
      }

      // Fallback summary if video file is downloading or not yet on local disk
      const fallbackSummary = `================================================================================
                    UNIFIED MASTER CLASS SUMMARY & METRICS
================================================================================
📌 Class Topic: ${title}
👤 Student: ${studentName}
👨‍🏫 Mentor: ${mentorName}
📅 Session Date: ${new Date().toLocaleDateString('en-US', { dateStyle: 'medium' })}

--------------------------------------------------------------------------------
💡 AI SUMMARY STATUS
--------------------------------------------------------------------------------
• Video File: ${recording.fileName}
• Status: Syncing recording from Google Drive...
• Video playback is available via Google Drive.`;

      return res.status(HTTP_STATUS.OK).json(
        successResponse({ content: fallbackSummary }, 'Session Summary loaded (Drive syncing).')
      );
    } catch (err: any) {
      logger.error(`Error retrieving transcript content: ${err.message}`);
      return res.status(HTTP_STATUS.OK).json(
        successResponse({ content: `⚠️ Transcript Processing\n\nThe session video is being processed. Video playback is available on the left.` }, 'Fallback summary')
      );
    }
  }
}
