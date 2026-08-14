import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ZoomRecordingService } from './recording.service';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS, verifyClassMediaGrant, extractMeetCode } from '@futurespark/constants';
import { logger } from '@futurespark/logger';
import { S3Storage, getS3KeyForRecording } from '@futurespark/storage';
import { createStreamToken, verifyStreamToken } from './stream-token';

export class ZoomRecordingController {
  private static readonly ARCHIVE_ROLES = new Set(['ADMIN', 'INSTRUCTOR', 'TEACHER', 'QA_AUDITOR', 'SCHEDULER']);

  private static canBrowseArchive(req: Request): boolean {
    return ZoomRecordingController.ARCHIVE_ROLES.has((req.headers['x-user-role'] as string) || '');
  }

  static async list(req: Request, res: Response) {
    if (!ZoomRecordingController.canBrowseArchive(req)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json(errorResponse('You can only access recordings for your own classes.'));
    }
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
      const { meetingId, zoomMeetingId } = req.body;

      // meetingId = our internal DB UUID
      // zoomMeetingId = Zoom's numeric meeting ID (from zoom.us/recording page)
      if (meetingId) {
        const recording = await ZoomRecordingService.syncMeetingRecording(meetingId);
        return res.status(HTTP_STATUS.OK).json(successResponse(recording, 'Zoom meeting recording synced successfully.'));
      }

      if (zoomMeetingId) {
        // Look up our DB meeting by the Zoom meeting numeric ID
        const { db } = await import('../../../database/datasource');
        const zoomIdStr = String(zoomMeetingId).trim();
        const meeting = await db.meeting.findFirst({
          where: {
            provider: 'ZOOM',
            zoomMeetingId: zoomIdStr,
          },
        });
        if (!meeting) {
          return res.status(HTTP_STATUS.NOT_FOUND).json(
            errorResponse(`No meeting found with Zoom meeting ID ${zoomIdStr}. Make sure the class was booked via Zoom in this system.`)
          );
        }
        const recording = await ZoomRecordingService.syncMeetingRecording(meeting.id);
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

  static async mediaToken(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const recording = await ZoomRecordingService.getRecordingById(id);
      if (!recording) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Zoom recording not found.'));
      }
      const { token, expiresAt } = createStreamToken(id);
      return res.status(HTTP_STATUS.OK).json(
        successResponse({ token, expiresAt }, 'Stream token issued.')
      );
    } catch (err: any) {
      logger.error(`[ZoomRecordingController] Error issuing stream token: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse('Could not issue a stream token.'));
    }
  }

  static async remove(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const recording = await ZoomRecordingService.getRecordingById(id);
      if (!recording) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Zoom recording not found.'));
      }
      return res.status(HTTP_STATUS.OK).json(successResponse(recording, 'Zoom recording retrieved successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomRecordingController] Error fetching Zoom recording: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to fetch recording'));
    }
  }

  static async forClass(req: Request, res: Response) {
    try {
      const grant = verifyClassMediaGrant(req.query.grant);
      if (!grant) {
        return res
          .status(HTTP_STATUS.UNAUTHORIZED)
          .json(errorResponse('This media link is missing, invalid, or has expired.'));
      }

      const all = await ZoomRecordingService.listRecordings();
      const matches = all.filter((r: any) => extractMeetCode(r.meeting?.meetUrl) === grant.meetCode);

      const payload = matches.map((r: any) => {
        const { token, expiresAt } = createStreamToken(r.id);
        return {
          id: r.id,
          fileName: r.fileName,
          fileSize: r.fileSize,
          duration: r.duration,
          downloadStatus: r.downloadStatus,
          createdAt: r.createdAt,
          streamToken: token,
          streamTokenExpiresAt: expiresAt,
          driveViewUrl: r.playUrl || null,
        };
      });

      return res
        .status(HTTP_STATUS.OK)
        .json(successResponse(payload, `Zoom recordings for class ${grant.classId}`));
    } catch (err: any) {
      logger.error(`[ZoomRecordingController] Error listing Zoom class recordings: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse('Could not load Zoom recordings.'));
    }
  }

  static async getTranscriptContent(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const recording = await ZoomRecordingService.getRecordingById(id);

      if (!recording) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Zoom transcript not found.'));
      }

      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';

      let summaryPath = recording.videoPath ? recording.videoPath + '.summary.txt' : '';
      let transcriptPath = recording.videoPath ? recording.videoPath + '.transcript.txt' : '';

      if (forceRefresh) {
        logger.info(`[ZoomRecordingController] refresh=1 — bypassing cached summary for recording ${id}`);
        if (summaryPath && fs.existsSync(summaryPath)) {
          try {
            fs.unlinkSync(summaryPath);
            logger.info(`[ZoomRecordingController] Removed stale cached summary: ${summaryPath}`);
          } catch (unlinkErr: any) {
            logger.warn(`[ZoomRecordingController] Could not remove cached summary: ${unlinkErr.message}`);
          }
        }
      }

      // 1. S3 mode
      if (!forceRefresh && S3Storage.isS3Enabled() && transcriptPath && !fs.existsSync(transcriptPath)) {
        try {
          const summaryKey = getS3KeyForRecording(recording.id, recording.fileName, 'summary');
          const content = await S3Storage.downloadBuffer(summaryKey);
          if (content) {
            logger.info(`[ZoomRecordingController] Serving pre-generated summary from S3: ${summaryKey}`);
            return res.status(HTTP_STATUS.OK).json(successResponse({ content }, 'Master Groq AI Summary loaded successfully.'));
          }
        } catch (s3Err: any) {
          logger.info(`[ZoomRecordingController] No pre-generated summary on S3 yet: ${s3Err.message}`);
        }
        try {
          const s3Key = getS3KeyForRecording(recording.id, recording.fileName, 'transcript');
          logger.info(`[ZoomRecordingController] Fetching transcript from S3 key: ${s3Key}`);
          const content = await S3Storage.downloadBuffer(s3Key);
          return res.status(HTTP_STATUS.OK).json(successResponse({ content }, 'Transcript loaded successfully.'));
        } catch (s3Err: any) {
          logger.warn(`[ZoomRecordingController] S3 transcript fetch failed: ${s3Err.message}`);
        }
      }

      // Local disk check
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

      // Metadata extraction
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
            logger.info(`[ZoomRecordingController] Auto-discovered local video file: ${recording.videoPath}`);
            const { db: dbClient } = require('../../../database/datasource');
            dbClient.meetingRecording.update({
              where: { id: recording.id },
              data: { videoPath: recording.videoPath, downloadStatus: 'COMPLETED' },
            }).catch(() => {});
          }
        }
      }

      // If video is missing locally, trigger background download for Groq AI transcription
      if (!recording.videoPath || !fs.existsSync(recording.videoPath)) {
        logger.info(`[ZoomRecordingController] Triggering background download from Zoom for Groq AI transcription: ${recording.fileName}`);
        ZoomRecordingService.downloadRecording(recording.id).catch((downloadErr: any) => {
          logger.warn(`[ZoomRecordingController] Zoom background download failed: ${downloadErr.message}`);
        });
      }

      // If video exists locally, invoke GroqTranscriptionService pipeline
      if (recording.videoPath && fs.existsSync(recording.videoPath)) {
        try {
          logger.info(`[ZoomRecordingController] Running GroqTranscriptionService pipeline for Zoom: ${recording.videoPath}`);
          const groqModulePath = '../../../../../learning-service/src/modules/transcription/groq-transcription.service';
          const { GroqTranscriptionService } = require(groqModulePath);
          const groqService = new GroqTranscriptionService();
          const result = await groqService.processClassAudio(recording.videoPath, studentName, mentorName);
          if (result && result.classSummary) {
            if (summaryPath && !result.usedFallback) {
              try { fs.writeFileSync(summaryPath, result.classSummary, 'utf-8'); } catch (_) { }
            } else if (result.usedFallback) {
              logger.error(`[ZoomRecordingController] Groq returned placeholder output for Zoom ${recording.id} — not caching to ${summaryPath}`);
            }
            return res.status(HTTP_STATUS.OK).json(successResponse({ content: result.classSummary }, 'Master Groq AI Summary loaded successfully.'));
          }
        } catch (groqErr: any) {
          logger.error(`[ZoomRecordingController] Groq processing error: ${groqErr?.message || groqErr}`);
          const fallbackSummary = `================================================================================
                    UNIFIED MASTER CLASS SUMMARY & METRICS (ZOOM)
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
                    UNIFIED MASTER CLASS SUMMARY & METRICS (ZOOM)
================================================================================
📌 Class Topic: ${title}
👤 Student: ${studentName}
👨‍🏫 Mentor: ${mentorName}
📅 Session Date: ${new Date().toLocaleDateString('en-US', { dateStyle: 'medium' })}

--------------------------------------------------------------------------------
💡 AI SUMMARY STATUS
--------------------------------------------------------------------------------
• Video File: ${recording.fileName}
• Status: Syncing recording from Zoom...
• Video playback is available via Zoom.`;

      return res.status(HTTP_STATUS.OK).json(
        successResponse({ content: fallbackSummary }, 'Session Summary loaded (Zoom syncing).')
      );
    } catch (err: any) {
      logger.error(`Error retrieving transcript content: ${err.message}`);
      return res.status(HTTP_STATUS.OK).json(
        successResponse({ content: `⚠️ Transcript Processing\n\nThe session video is being processed. Video playback is available on the left.` }, 'Fallback summary')
      );
    }
  }

  static async stream(req: Request, res: Response) {
    try {
      const { id } = req.params;

      if (!verifyStreamToken(id, req.query.token)) {
        logger.warn(`[ZoomRecordingController] Rejected unsigned stream request for recording ${id}`);
        return res
          .status(HTTP_STATUS.UNAUTHORIZED)
          .json(errorResponse('This media link is missing, invalid, or has expired.'));
      }

      const recording = await ZoomRecordingService.getRecordingById(id);
      if (!recording) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Zoom recording not found.'));
      }

      const isAudio = req.query.type === 'audio';
      const range = req.headers.range;

      const rawFilePath = (isAudio && recording.audioPath) ? recording.audioPath : recording.videoPath;
      let filePath = rawFilePath;

      if (S3Storage.isS3Enabled() && filePath && !fs.existsSync(filePath)) {
        if (await S3Storage.objectExists(filePath)) {
          const presignedUrl = await S3Storage.getPresignedUrl(filePath, 3600);
          logger.info(`[ZoomRecordingController] Redirecting stream request to S3 presigned URL for ${filePath}`);
          return res.redirect(presignedUrl);
        }
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
        const contentType = isAudio ? 'audio/mpeg' : 'video/mp4';

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
            'Content-Type': contentType,
          };
          res.writeHead(206, head);
          file.pipe(res);
        } else {
          const head = {
            'Content-Length': fileSize,
            'Content-Type': contentType,
          };
          res.writeHead(200, head);
          fs.createReadStream(filePath).pipe(res);
        }
        return;
      }

      if (recording?.playUrl) {
        return res.redirect(recording.playUrl);
      }
      return res.status(HTTP_STATUS.NOT_FOUND).json(
        errorResponse(isAudio ? 'Recording audio file not available.' : 'Recording video file not available.')
      );
    } catch (err: any) {
      logger.error(`[ZoomRecordingController] stream error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to stream Zoom recording.')
      );
    }
  }
}
