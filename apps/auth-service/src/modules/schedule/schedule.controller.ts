import { Request, Response } from 'express';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS, ReflectionResponse, ReflectionMentorMark } from '@futurespark/constants';
import { scheduleService } from './schedule.service';
import { reportService } from '../report/report.service';
import { validateCreateSchedule, validateUpdateSchedule } from './schedule.schema';

export const scheduleController = {
  async listMentors(req: Request, res: Response) {
    const { groupId } = req.query;
    const list = await scheduleService.getMentorsWithSchedules(typeof groupId === 'string' ? groupId : undefined);
    return res.status(HTTP_STATUS.OK).json(successResponse(list, 'Mentors availability fetched successfully'));
  },

  async list(req: Request, res: Response) {
    const { studentId, mentorId, status, groupId } = req.query;
    // The query string only ever narrows; the service decides the scope from
    // the caller's identity.
    const list = await scheduleService.listSchedules(
      {
        studentId: typeof studentId === 'string' ? studentId : undefined,
        mentorId: typeof mentorId === 'string' ? mentorId : undefined,
        status: typeof status === 'string' ? status : undefined,
        groupId: typeof groupId === 'string' ? groupId : undefined,
      },
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(list, 'Schedules fetched successfully'));
  },

  async getById(req: Request, res: Response) {
    // Both halves of the identity travel: the service needs the role to pick a
    // payload tier and the id to test the relationship to this one class.
    const classSession = await scheduleService.getScheduleById(
      req.params.id,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(classSession, 'Schedule fetched successfully'));
  },

  async create(req: Request, res: Response) {
    const input = validateCreateSchedule(req.body);
    const scheduledById = req.headers['x-user-id'] as string | undefined;
    const classSession = await scheduleService.createSchedule(
      input,
      scheduledById,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.CREATED).json(successResponse(classSession, 'Class scheduled successfully'));
  },

  async update(req: Request, res: Response) {
    const input = validateUpdateSchedule(req.body);
    // Which fields of `input` actually get written is decided in the service
    // from these two headers — the body never says who is asking.
    const classSession = await scheduleService.updateSchedule(
      req.params.id,
      input,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(classSession, 'Schedule updated successfully'));
  },

  async delete(req: Request, res: Response) {
    const { deleteAll, includeCompleted } = req.query;
    const result = await scheduleService.deleteSchedule(
      req.params.id,
      deleteAll === 'true',
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined,
      includeCompleted === 'true'
    );

    /* The message states the real outcome. "Deleted successfully" was returned
     * even when nothing had been deleted, which is how a programme could be
     * reported gone and still be sitting on the page. */
    const message =
      result.keptCompleted > 0
        ? `Deleted ${result.count} class(es). ${result.keptCompleted} completed class(es) were kept — ` +
          'delete those individually, or repeat with "include completed".'
        : result.count === 0
          ? 'Nothing was deleted — there were no matching classes.'
          : `Deleted ${result.count} class(es).`;

    return res.status(HTTP_STATUS.OK).json(successResponse(result, message));
  },

  async createReport(req: Request, res: Response) {
    const { classId, issueType, description } = req.body;
    const reporterId = req.headers['x-user-id'] as string;
    const reporterRole = req.headers['x-user-role'] as string;

    if (!classId || !issueType || !description) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: 'Missing required parameters: classId, issueType, and description are required.',
      });
    }

    // The report is stored under this identity and shown to QA as the person who
    // raised it, so an unidentifiable caller is refused here rather than filed
    // as "Unknown User".
    if (!reporterId || !reporterRole) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: 'Unable to identify the caller.',
      });
    }

    const report = await scheduleService.createReport({
      classId,
      reporterId,
      reporterRole,
      issueType,
      description,
    });

    return res.status(HTTP_STATUS.CREATED).json(successResponse(report, 'Issue report submitted successfully'));
  },

  async listReports(req: Request, res: Response) {
    const reporterId = typeof req.query.reporterId === 'string' ? req.query.reporterId : undefined;
    // `reporterId` is a filter, not a scope. The service decides what the caller
    // is entitled to and treats this as a further narrowing of it.
    const reports = await scheduleService.listReports(
      reporterId,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(reports, 'Session reports fetched successfully'));
  },

  async updateReport(req: Request, res: Response) {
    const { status, qaFeedback } = req.body;
    const report = await scheduleService.updateReport(
      req.params.id,
      { status, qaFeedback },
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(report, 'Session report updated successfully'));
  },

  /**
   * Marks the class complete. Takes no body.
   *
   * It used to read `credits` from the request and award them. Points are the
   * mentor's judgement on the quiz now, awarded per answer through
   * `reviewReflection`, so a `credits` field here is ignored rather than
   * honoured — an older client still posting one gets a completed class and no
   * award, which is the intended outcome.
   */
  async completeClass(req: Request, res: Response) {
    const classSession = await scheduleService.completeClass(
      req.params.id,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(classSession, 'Class session marked complete'));
  },

  /**
   * Build and send the parent's session report on demand.
   *
   * The cron does this automatically once the recording has been transcribed;
   * this is the manual handle for the two cases it cannot cover — a report that
   * failed its five attempts, and a recording that was linked by hand long after
   * the class. ADMIN only: it messages a real family, and `force` re-sends one
   * they may already have.
   */
  async sendClassReport(req: Request, res: Response) {
    const role = req.headers['x-user-role'] as string | undefined;
    if (role !== 'ADMIN') {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, message: 'Only an admin can send a session report.' });
    }

    const force = String(req.query.force ?? req.body?.force ?? '') === 'true';
    const customPhone = typeof req.body?.phone === 'string'
      ? req.body.phone.trim()
      : typeof req.query?.phone === 'string'
        ? req.query.phone.trim()
        : undefined;

    const outcome = await reportService.sendClassReport(req.params.id, { force, customPhone });

    if (!outcome.sent) {
      return res.status(HTTP_STATUS.OK).json(
        successResponse(
          outcome,
          outcome.skippedReason ?? outcome.error ?? 'The report was not delivered.'
        )
      );
    }

    return res
      .status(HTTP_STATUS.OK)
      .json(
        successResponse(
          outcome,
          outcome.documentDelivered
            ? 'Session report sent to the parent with the PDF attached.'
            : 'Session report sent, but the PDF could not be attached.'
        )
      );
  },

  /**
   * Return the parent's report PDF without sending anything.
   *
   * The point is that it sends nothing. Before this existed, the only way to see
   * what a family would receive was to WhatsApp it to them — a bad way to find
   * out a name is wrong or a summary came out empty. ADMIN only: the document
   * contains a named child's class transcript summary.
   */
  async classReportChecklist(req: Request, res: Response) {
    const role = req.headers['x-user-role'] as string | undefined;
    if (role !== 'ADMIN') {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, message: 'Only an admin can review a report checklist.' });
    }
    const checklist = await reportService.classReportChecklist(req.params.id);
    if (!checklist) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, message: 'Class not found.' });
    }
    return res.status(HTTP_STATUS.OK).json({ success: true, data: checklist });
  },

  async previewClassReport(req: Request, res: Response) {
    const role = req.headers['x-user-role'] as string | undefined;
    if (role !== 'ADMIN') {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, message: 'Only an admin can preview a session report.' });
    }

    const result = await reportService.renderClassReport(req.params.id);

    if (!result.ok) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: result.reason });
    }

    // `inline` so it opens in the browser tab rather than downloading — the
    // whole point is to look at it.
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${result.fileName}"`);
    res.setHeader('Content-Length', String(result.buffer.length));
    // The exact template variables this class would send, so the {{1}}..{{n}}
    // mapping can be checked against Meta without sending a message.
    res.setHeader('X-Report-Variables', Buffer.from(JSON.stringify(result.variables)).toString('base64'));
    return res.status(HTTP_STATUS.OK).end(result.buffer);
  },

  async rateClass(req: Request, res: Response) {
    const { rating, feedback } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: 'Rating must be a number between 1 and 5.',
      });
    }
    const classSession = await scheduleService.rateClass(
      req.params.id,
      Number(rating),
      feedback,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(classSession, 'Class rating submitted successfully'));
  },

  async getRawTranscript(req: Request, res: Response) {
    const result = await scheduleService.getRawTranscript(
      req.params.id,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Raw transcript fetched'));
  },

  async launchQuiz(req: Request, res: Response) {
    const result = await scheduleService.launchQuiz(
      req.params.id,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res
      .status(HTTP_STATUS.OK)
      .json(successResponse(result, 'Quiz launched — it will pop up on the student portal within a few seconds.'));
  },

  async getQuizStatus(req: Request, res: Response) {
    const result = await scheduleService.getQuizStatus(
      req.params.id,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Quiz status fetched'));
  },

  async getReflection(req: Request, res: Response) {
    const result = await scheduleService.getReflection(
      req.params.id,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Reflection fetched successfully'));
  },

  /**
   * Accepts either shape:
   *   { responses: [{ questionId, answer?, selectedOptionId? }] }  — the quiz
   *   { answers: ["...", "..."] }                                  — legacy text
   * The legacy form is mapped positionally, which is how the grader falls back
   * when a questionId is missing.
   */
  async submitReflection(req: Request, res: Response) {
    const { responses, answers } = req.body;

    let normalized: ReflectionResponse[];
    if (Array.isArray(responses)) {
      normalized = responses.map((r: any) => ({
        questionId: typeof r?.questionId === 'string' ? r.questionId : '',
        answer: typeof r?.answer === 'string' ? r.answer : undefined,
        selectedOptionId: typeof r?.selectedOptionId === 'string' ? r.selectedOptionId : null,
      }));
    } else if (Array.isArray(answers)) {
      normalized = answers.map((a: any) => ({
        questionId: '',
        answer: typeof a === 'string' ? a : '',
      }));
    } else {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: 'Body must contain a "responses" array, one entry per question.',
      });
    }

    const result = await scheduleService.submitReflection(
      req.params.id,
      normalized,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Reflection submitted successfully'));
  },

  /**
   * The mentor's evaluation of a submitted quiz:
   *   { note?: string, marks?: [{ questionId, points, comment? }] }
   *
   * Both halves are optional and independent. `{ note }` alone is the original
   * sign-off and still behaves exactly as it did — no score, no credits — so
   * the existing mentor drawer keeps working untouched. Send `marks` and the
   * quiz is scored from them, badged from the total, and the student's balance
   * moves by the difference.
   *
   * Only the shape is checked here, in the same hand-rolled style as the rest of
   * this controller. The rules that matter — a mark per question that was
   * actually asked, points inside that question's own ceiling — are enforced in
   * the service against the stored answers, because those are the only copy the
   * client cannot edit.
   */
  async reviewReflection(req: Request, res: Response) {
    const { note, marks } = req.body;
    if (note !== undefined && note !== null && typeof note !== 'string') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: '"note" must be text.',
      });
    }

    let normalizedMarks: ReflectionMentorMark[] | undefined;
    if (marks !== undefined && marks !== null) {
      if (!Array.isArray(marks)) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: '"marks" must be an array, one entry per answer you are marking.',
        });
      }
      for (const mark of marks) {
        if (!mark || typeof mark !== 'object') {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            message: 'Each mark must be an object of { questionId, points, comment? }.',
          });
        }
        if (typeof mark.questionId !== 'string' || !mark.questionId.trim()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            message: 'Each mark needs the "questionId" of the answer it applies to.',
          });
        }
        // Rejected here rather than coerced: `Number(undefined)` is NaN and
        // `Number(null)` is 0, so a missing field would otherwise silently
        // become a real mark of zero on a real answer.
        if (typeof mark.points !== 'number' || !Number.isInteger(mark.points) || mark.points < 0) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            message: `"points" for ${mark.questionId} must be a whole number of 0 or more.`,
          });
        }
        if (mark.comment !== undefined && mark.comment !== null && typeof mark.comment !== 'string') {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            message: `"comment" for ${mark.questionId} must be text.`,
          });
        }
        if (mark.correction !== undefined && mark.correction !== null && typeof mark.correction !== 'string') {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            message: `"correction" for ${mark.questionId} must be text.`,
          });
        }
      }
      normalizedMarks = marks.map((m: any) => ({
        questionId: m.questionId,
        points: m.points,
        comment: typeof m.comment === 'string' ? m.comment : null,
        // The answer the mentor was looking for, in their own words. Carried
        // explicitly — an allowlist here means a client cannot smuggle extra
        // fields into the stored entry.
        correction: typeof m.correction === 'string' ? m.correction : null,
      }));
    }

    const result = await scheduleService.reviewReflection(
      req.params.id,
      typeof note === 'string' ? note : undefined,
      normalizedMarks,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(
      successResponse(result, normalizedMarks?.length ? 'Reflection marked successfully' : 'Reflection reviewed successfully')
    );
  },

  async createDoubt(req: Request, res: Response) {
    const { question } = req.body;
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: 'Body must contain a non-empty "question".',
      });
    }
    const doubt = await scheduleService.createDoubt(
      req.params.id,
      question,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.CREATED).json(successResponse(doubt, 'Question submitted successfully'));
  },

  async listDoubts(req: Request, res: Response) {
    const doubts = await scheduleService.listDoubts(
      req.params.id,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(doubts, 'Class questions fetched successfully'));
  },

  async listDoubtInbox(req: Request, res: Response) {
    const doubts = await scheduleService.listDoubtInbox(
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(doubts, 'Open questions fetched successfully'));
  },

  async answerDoubt(req: Request, res: Response) {
    const { answer } = req.body;
    if (typeof answer !== 'string' || !answer.trim()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: 'Body must contain a non-empty "answer".',
      });
    }
    const doubt = await scheduleService.answerDoubt(
      req.params.doubtId,
      answer,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(doubt, 'Question answered successfully'));
  },

  /** Internal: integration-service reporting that a Meet room emptied. */
  async classInRoomAt(req: Request, res: Response) {
    // Service-to-service only, by the same tell as the siblings below.
    if (req.headers['x-user-id'] || req.headers['x-user-role']) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        message: 'This endpoint is service-to-service only.',
      });
    }
    const link = typeof req.query.link === 'string' ? req.query.link : '';
    const atRaw = typeof req.query.at === 'string' ? req.query.at : '';
    const found = await scheduleService.classInRoomAt(link, new Date(atRaw));
    return res.status(HTTP_STATUS.OK).json(successResponse(found, 'Class lookup complete'));
  },

  async staffNotifyNumbers(req: Request, res: Response) {
    if (req.headers['x-user-id'] || req.headers['x-user-role']) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        message: 'This endpoint is service-to-service only.',
      });
    }
    const numbers = await scheduleService.staffNotifyNumbers();
    return res.status(HTTP_STATUS.OK).json(successResponse(numbers, 'Staff numbers fetched'));
  },

  async activeMeetingLinks(req: Request, res: Response) {
    // Service-to-service only, by the same tell as markRoomEnded below: a real
    // internal call never carries the gateway's identity headers.
    if (req.headers['x-user-id'] || req.headers['x-user-role']) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        message: 'This endpoint is service-to-service only.',
      });
    }
    const links = await scheduleService.activeMeetingLinks();
    return res.status(HTTP_STATUS.OK).json(successResponse(links, 'Active meeting links fetched'));
  },

  async markRoomEnded(req: Request, res: Response) {
    // "Internal" was a naming convention, not a control. The gateway proxies the
    // whole `/api/schedules/*` prefix, so any logged-in user could POST a
    // meetingLink here and stamp `actualEndedAt` on someone else's class —
    // enough to make `deriveAttendance` report ATTENDED and so unlock
    // `rateClass` against a mentor for a lesson that never happened.
    //
    // The three genuine callers — the Meet poller, the Zoom poller and the Zoom
    // webhook — reach auth-service directly and send `Content-Type` and nothing
    // else. Anything arriving through the gateway carries the HMAC-signed
    // identity headers `authenticate` injects, which is exactly what a real
    // internal call never has, so their presence is the tell.
    if (req.headers['x-user-id'] || req.headers['x-user-role']) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        message: 'This endpoint is service-to-service only.',
      });
    }

    const { meetingLink, endedAt } = req.body;
    if (!meetingLink || typeof meetingLink !== 'string') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: 'Body must contain a "meetingLink".',
      });
    }
    const when = endedAt ? new Date(endedAt) : new Date();
    if (Number.isNaN(when.getTime())) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: '"endedAt" is not a valid timestamp.',
      });
    }
    const result = await scheduleService.markRoomEnded(meetingLink, when);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Room end recorded'));
  },

  async listSubmissions(req: Request, res: Response) {
    const items = await scheduleService.listSubmissions(
      req.params.id,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(items, 'Submissions fetched successfully'));
  },

  async addSubmission(req: Request, res: Response) {
    const created = await scheduleService.addSubmission(
      req.params.id,
      req.body ?? {},
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.CREATED).json(successResponse(created, 'Submission saved'));
  },

  async commentOnSubmission(req: Request, res: Response) {
    const updated = await scheduleService.commentOnSubmission(
      req.params.id,
      req.params.submissionId,
      req.body?.comment,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(updated, 'Feedback saved'));
  },

  async deleteSubmission(req: Request, res: Response) {
    const result = await scheduleService.deleteSubmission(
      req.params.id,
      req.params.submissionId,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Submission removed'));
  },

  async getStudentOverview(req: Request, res: Response) {
    const overview = await scheduleService.getStudentOverview(
      req.params.studentId,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(overview, 'Student overview fetched successfully'));
  },
};
