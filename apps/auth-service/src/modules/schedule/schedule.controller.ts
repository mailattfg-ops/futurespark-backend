import { Request, Response } from 'express';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS, ReflectionResponse, ReflectionMentorMark } from '@futurespark/constants';
import { scheduleService } from './schedule.service';
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
    const { deleteAll } = req.query;
    await scheduleService.deleteSchedule(
      req.params.id,
      deleteAll === 'true',
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Schedule deleted successfully'));
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
      }
      normalizedMarks = marks.map((m: any) => ({
        questionId: m.questionId,
        points: m.points,
        comment: typeof m.comment === 'string' ? m.comment : null,
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

  async getStudentOverview(req: Request, res: Response) {
    const overview = await scheduleService.getStudentOverview(
      req.params.studentId,
      req.headers['x-user-id'] as string | undefined,
      req.headers['x-user-role'] as string | undefined
    );
    return res.status(HTTP_STATUS.OK).json(successResponse(overview, 'Student overview fetched successfully'));
  },
};
