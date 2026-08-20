import { Request, Response } from 'express';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import db from '../../database/datasource';
import { GroqTranscriptionService } from './groq-transcription.service';
import { GroqError, failureToPayload } from './groq-errors';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const groqService = new GroqTranscriptionService();

/** ±2h around the meeting's start — see `findClassForRecording`. */
const SLOT_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/** Flatten the mind-map tree to a list of topic titles for the prompt. */
const flattenTopicTitles = (topics: unknown, depth = 0): string[] => {
  if (!Array.isArray(topics) || depth > 3) return [];
  const out: string[] = [];
  for (const node of topics) {
    if (!node || typeof node !== 'object') continue;
    const title = typeof (node as any).title === 'string' ? (node as any).title.trim() : '';
    if (title) out.push(title);
    out.push(...flattenTopicTitles((node as any).children, depth + 1));
  }
  return out.slice(0, 40);
};

/**
 * Assemble what the analysis needs to know about the lesson itself.
 *
 * Everything here is best-effort: a session that has no slide text yet still
 * produces a report, just a more cautious one. A missing session must never
 * fail the transcription — the recording is the expensive part and it has
 * already been paid for by the time this runs.
 */
async function buildAnalysisContext(input: {
  sessionId?: string;
  programId?: string;
  startTime?: string;
  endTime?: string;
}) {
  const context: any = {
    classDate: input.startTime ? new Date(input.startTime).toISOString().slice(0, 10) : null,
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
  };

  if (!input.sessionId) {
    logger.warn(
      '[Transcription Controller] No sessionId supplied — the report will be built from the recording ' +
        'alone, with no session material to check it against.'
    );
    return context;
  }

  try {
    const session = await db.session.findUnique({
      where: { id: input.sessionId },
      select: { title: true, order: true, topics: true, slideContent: true, programId: true },
    });

    if (!session) {
      logger.warn(`[Transcription Controller] Session ${input.sessionId} not found — no material to analyse against.`);
      return context;
    }

    context.sessionTitle = session.title;
    context.sessionOrder = session.order;
    context.slideContent = session.slideContent;
    context.plannedTopics = flattenTopicTitles(session.topics);

    // "Week 3 of 52" — the total comes from how many sessions the programme has.
    const programId = session.programId ?? input.programId;
    if (programId) {
      context.sessionTotal = await db.session.count({ where: { programId } });
    }

    if (!session.slideContent || session.slideContent.trim().length === 0) {
      logger.warn(
        `[Transcription Controller] Session "${session.title}" has no slideContent. The report will be ` +
          'less precise — add the presentation text so concepts can be named and unreached topics flagged.'
      );
    } else {
      logger.info(
        `[Transcription Controller] Analysing against "${session.title}" ` +
          `(${session.slideContent.length} chars of material, ${context.plannedTopics.length} planned topic(s)).`
      );
    }
  } catch (err: any) {
    logger.error(`[Transcription Controller] Could not load session material: ${err.message}. Continuing without it.`);
  }

  return context;
}

/**
 * Find the ONE class a finished recording belongs to.
 *
 * This used to be `findFirst({ where: { meetingLink: { contains: meetUrl } } })`,
 * which is wrong in the ordinary case rather than an edge case: a programme
 * reuses a single Meet link for all 40 of its sessions, so that query returned an
 * arbitrary row and week 12's summary could be written onto week 3's class. The
 * parent then gets a report about a lesson their child sat two months ago.
 *
 * Identity comes from who sat which lesson — (studentId, sessionId) — with the
 * slot time as the tie-breaker for a session taught twice after a reschedule.
 * The link is the last resort, and even then it is time-boxed. A query that
 * cannot narrow to a single row returns nothing: writing a real summary onto the
 * wrong child's class is worse than writing none at all.
 */
async function findClassForRecording(input: {
  meetUrl?: string;
  studentId?: string;
  sessionId?: string;
  programId?: string;
  startTime?: string;
  endTime?: string;
}) {
  const start = input.startTime ? new Date(input.startTime) : null;
  const validStart = start && !Number.isNaN(start.getTime()) ? start : null;

  const slotWindow = validStart
    ? {
        startTime: {
          gte: new Date(validStart.getTime() - SLOT_TOLERANCE_MS),
          lte: new Date(validStart.getTime() + SLOT_TOLERANCE_MS),
        },
      }
    : {};

  const cleanMeetUrl = input.meetUrl
    ? input.meetUrl.replace(/^https?:\/\//, '').split('?')[0].split('#')[0].trim()
    : null;

  const strategies: Array<{ label: string; where: any }> = [];

  if (input.studentId && input.sessionId) {
    strategies.push({
      label: 'studentId+sessionId+slot',
      where: { studentId: input.studentId, sessionId: input.sessionId, ...slotWindow },
    });
  }
  if (input.studentId && input.programId && validStart) {
    strategies.push({
      label: 'studentId+programId+slot',
      where: { studentId: input.studentId, programId: input.programId, ...slotWindow },
    });
  }
  if (cleanMeetUrl && validStart) {
    strategies.push({
      label: 'meetingLink+slot',
      where: { meetingLink: { contains: cleanMeetUrl }, ...slotWindow },
    });
  }
  if (cleanMeetUrl && !validStart) {
    // No time to narrow with. Kept only so a caller that sends nothing but a
    // link still works, and it refuses when the link is ambiguous.
    strategies.push({ label: 'meetingLink (unbounded)', where: { meetingLink: { contains: cleanMeetUrl } } });
  }

  for (const strategy of strategies) {
    const matches = await db.scheduledClass.findMany({
      where: { status: { not: 'CANCELLED' }, ...strategy.where },
      orderBy: { startTime: 'desc' },
      take: 5,
    });

    if (matches.length === 0) continue;
    if (matches.length > 1) {
      logger.warn(
        `[Transcription Controller] "${strategy.label}" matched ${matches.length} classes — too ` +
          'ambiguous to attribute a summary to. Trying the next strategy.'
      );
      continue;
    }

    logger.info(`[Transcription Controller] Attributed recording to class ${matches[0].id} via ${strategy.label}.`);
    return matches[0];
  }

  return null;
}

export const transcriptionController = {
  async transcribe(req: Request, res: Response) {
    try {
      const { audioFilePath, meetUrl, studentId, teacherId, sessionId, programId, startTime, endTime, recordingId, audioSeconds } = req.body;

      if (!audioFilePath) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Parameter "audioFilePath" is required.'));
      }

      logger.info(`[Transcription Controller] Starting transcription for file: ${audioFilePath}`);

      // 1. Resolve student and mentor names via auth-service.
      //
      // Defaults are deliberately generic. They used to be real-looking names
      // ('Zoha', 'Bazena'), and because a studentId cannot be resolved through
      // /users/:id — students live in their own table — the fallback fired every
      // single time and printed a stranger's name into real class summaries.
      let studentName = 'Student';
      let mentorName = 'Mentor';

      const fetchName = async (url: string, label: string): Promise<string | null> => {
        try {
          const res = await fetch(url);
          if (!res.ok) return null;
          const body = (await res.json()) as any;
          const person = body?.data;
          if (!person?.firstName) return null;
          return [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
        } catch (err: any) {
          logger.warn(`[Transcription Controller] Could not resolve ${label} name: ${err.message}`);
          return null;
        }
      };

      if (studentId) {
        // Students are in the Student table; fall back to User for legacy rows
        // where a student was created as a staff user.
        const resolved =
          (await fetchName(`${AUTH_SERVICE_URL}/users/customers/students/${studentId}`, 'student')) ??
          (await fetchName(`${AUTH_SERVICE_URL}/users/${studentId}`, 'student (legacy user)'));
        if (resolved) studentName = resolved;
        else logger.warn(`[Transcription Controller] Student ${studentId} not found — summary will say "Student".`);
      }

      if (teacherId) {
        const resolved = await fetchName(`${AUTH_SERVICE_URL}/users/${teacherId}`, 'mentor');
        if (resolved) mentorName = resolved;
        else logger.warn(`[Transcription Controller] Mentor ${teacherId} not found — summary will say "Mentor".`);
      }

      logger.info(`[Transcription Controller] Resolved participants — student: "${studentName}", mentor: "${mentorName}"`);

      // 2. Load the session material — the slides, key terms and activities the
      //    class was built around. This is INPUT 1 to the analysis; without it
      //    the model can only describe what it heard, and financial vocabulary
      //    spoken by a child over a phone mic is exactly what Whisper garbles.
      const analysisContext = await buildAnalysisContext({ sessionId, programId, startTime, endTime });
      analysisContext.recordingId = recordingId ?? null;
      analysisContext.audioSeconds =
        typeof audioSeconds === 'number' && audioSeconds > 0 ? audioSeconds : null;

      // Attribute the class BEFORE the pipeline runs. The match uses only
      // scheduling facts (ids + time window), never the transcript — and the
      // usage ledger writes its cost rows DURING the run, so matching
      // afterwards left every AiUsage.classId null and "Classes Analysed"
      // permanently at zero.
      let matchedClass: Awaited<ReturnType<typeof findClassForRecording>> = null;
      try {
        matchedClass = await findClassForRecording({ meetUrl, studentId, sessionId, programId, startTime, endTime });
      } catch (matchErr: any) {
        logger.warn(`[Transcription Controller] Pre-run class match failed: ${matchErr.message}`);
      }
      analysisContext.classId = matchedClass?.id ?? null;

      // 3. Process transcription using Groq Pipeline
      const result = await groqService.processClassAudio(
        audioFilePath,
        studentName,
        mentorName,
        analysisContext
      );

      // 3. Find and update the ScheduledClass record in PostgreSQL (cross-schema).
      // Skipped when the pipeline produced placeholder output — persisting that
      // would permanently mask the real summary behind a cache hit.
      if (meetUrl && result.usedFallback) {
        logger.warn(
          `[Transcription Controller] Placeholder output — leaving ScheduledClass.classSummary untouched for meetUrl: ${meetUrl}`
        );
      }
      if (!result.usedFallback) {
        try {
          // Reuse the pre-run match; retry once in case the class row appeared
          // while the pipeline was running.
          const scheduledClass =
            matchedClass ??
            (await findClassForRecording({
              meetUrl,
              studentId,
              sessionId,
              programId,
              startTime,
              endTime,
            }));

          if (scheduledClass) {
            logger.info(`[Transcription Controller] Matching ScheduledClass found (ID: ${scheduledClass.id}). Updating metrics...`);
            await db.scheduledClass.update({
              where: { id: scheduledClass.id },
              data: {
                transcript: result.transcript,
                // Readable prose, for the admin recording modal and the student
                // portal — both of which display this column as text, and every
                // row written before the structured report holds prose.
                classSummary: result.classSummary,
                // The structured report lives alongside the old word-count
                // metrics rather than replacing them, so nothing that already
                // reads `interactionMetrics` breaks. The PDF renderer looks for
                // `.report`; if it is absent it falls back to parsing the text.
                interactionMetrics: {
                  ...(result.metrics as any),
                  report: result.report ?? null,
                } as any,
                transcriptionStatus: 'COMPLETED',
              },
            });

            // Activity Log: the system finished its biggest background job.
            const { recordAudit } = await import('../shared/audit');
            void recordAudit({
              actorRole: 'SYSTEM',
              action: 'created',
              entityType: 'ai-summary',
              entityId: scheduledClass.id,
              entityName: studentName,
              summary: `The AI pipeline generated ${studentName}'s class summary` +
                (analysisContext.sessionTitle ? ` for "${analysisContext.sessionTitle}"` : ''),
            });
          } else {
            logger.warn(
              `[Transcription Controller] No matching ScheduledClass found (meetUrl: ${meetUrl ?? '-'}, ` +
                `student: ${studentId ?? '-'}, session: ${sessionId ?? '-'}). The summary was generated ` +
                'but has nowhere to live, so no parent report will go out for it.'
            );
            // Activity Log: the "summary not syncing" case — generated but unattached.
            const { recordAudit } = await import('../shared/audit');
            void recordAudit({
              actorRole: 'SYSTEM',
              action: 'failed',
              entityType: 'ai-summary',
              entityName: studentName,
              summary:
                `The AI pipeline generated ${studentName}'s summary but found NO matching class to attach it to` +
                ` — no parent report can go out until the class is matched`,
            });
          }
        } catch (dbErr: any) {
          logger.error(`[Transcription Controller] Failed to update ScheduledClass in DB: ${dbErr.message}`);
        }
      }

      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Transcription and summary generated successfully.'));
    } catch (err: any) {
      /* ── Report the actual problem ───────────────────────────────────────
       * A GroqError already knows what failed and how to fix it. Passing that
       * through instead of a generic 500 is the difference between an operator
       * reading "Request failed with status code 413" and reading "the free
       * tier only allows 8,000 tokens per minute; upgrade or set
       * GROQ_MAX_REQUEST_TOKENS".
       * ────────────────────────────────────────────────────────────────── */
      if (err instanceof GroqError) {
        const f = err.failure;
        logger.error(
          `[Transcription Controller] GROQ_${f.kind} (http ${f.httpStatus ?? '-'}) :: ${f.detail} :: ${f.remedy}`
        );
        // 502: the upstream AI failed, not this service. A 500 tells the caller
        // to look here, and the last hour of debugging went to exactly that.
        return res.status(HTTP_STATUS.BAD_GATEWAY ?? 502).json({
          success: false,
          message: f.summary,
          error: failureToPayload(f),
          timestamp: new Date().toISOString(),
        });
      }

      logger.error(`[Transcription Controller] Transcription job failed: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Transcription failed'));
    }
  },
};
