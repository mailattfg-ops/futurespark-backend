import { Request, Response } from 'express';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import db from '../../database/datasource';
import { GroqTranscriptionService } from './groq-transcription.service';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const groqService = new GroqTranscriptionService();

export const transcriptionController = {
  async transcribe(req: Request, res: Response) {
    try {
      const { audioFilePath, meetUrl, studentId, teacherId } = req.body;

      if (!audioFilePath) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Parameter "audioFilePath" is required.'));
      }

      logger.info(`[Transcription Controller] Starting transcription for file: ${audioFilePath}`);

      // 1. Resolve student and mentor names via auth-service
      let studentName = 'Zoha';
      let mentorName = 'Bazena';

      try {
        if (studentId) {
          const studentRes = await fetch(`${AUTH_SERVICE_URL}/users/${studentId}`);
          if (studentRes.ok) {
            const body = await studentRes.json() as any;
            const u = body?.data;
            if (u?.firstName) studentName = u.firstName;
          }
        }
      } catch (err: any) {
        logger.warn(`[Transcription Controller] Failed to fetch student name: ${err.message}. Using default 'Zoha'.`);
      }

      try {
        if (teacherId) {
          const mentorRes = await fetch(`${AUTH_SERVICE_URL}/users/${teacherId}`);
          if (mentorRes.ok) {
            const body = await mentorRes.json() as any;
            const u = body?.data;
            if (u?.firstName) mentorName = u.firstName;
          }
        }
      } catch (err: any) {
        logger.warn(`[Transcription Controller] Failed to fetch mentor name: ${err.message}. Using default 'Bazena'.`);
      }

      // 2. Process transcription using Groq Pipeline
      const result = await groqService.processClassAudio(audioFilePath, studentName, mentorName);

      // 3. Find and update the ScheduledClass record in PostgreSQL (cross-schema).
      // Skipped when the pipeline produced placeholder output — persisting that
      // would permanently mask the real summary behind a cache hit.
      if (meetUrl && result.usedFallback) {
        logger.warn(
          `[Transcription Controller] Placeholder output — leaving ScheduledClass.classSummary untouched for meetUrl: ${meetUrl}`
        );
      }
      if (meetUrl && !result.usedFallback) {
        try {
          const cleanMeetUrl = meetUrl.replace('https://', '').replace('http://', '').trim();
          const scheduledClass = await db.scheduledClass.findFirst({
            where: {
              meetingLink: {
                contains: cleanMeetUrl,
              },
            },
          });

          if (scheduledClass) {
            logger.info(`[Transcription Controller] Matching ScheduledClass found (ID: ${scheduledClass.id}). Updating metrics...`);
            await db.scheduledClass.update({
              where: { id: scheduledClass.id },
              data: {
                transcript: result.transcript,
                classSummary: result.classSummary,
                interactionMetrics: result.metrics as any,
                transcriptionStatus: 'COMPLETED',
              },
            });
          } else {
            logger.warn(`[Transcription Controller] No matching ScheduledClass found for meetUrl: ${meetUrl}`);
          }
        } catch (dbErr: any) {
          logger.error(`[Transcription Controller] Failed to update ScheduledClass in DB: ${dbErr.message}`);
        }
      }

      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Transcription and summary generated successfully.'));
    } catch (err: any) {
      logger.error(`[Transcription Controller] Transcription job failed: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Transcription failed'));
    }
  },
};
