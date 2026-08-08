import { Request, Response } from 'express';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS, defaultReflectionQuiz, stripAnswerKey, canSeeAnswerKey } from '@futurespark/constants';
import { courseService } from './course.service';
import {
  validateCreateProgram,
  validateUpsertPaymentPlan,
  validateCreateSession,
  validateUpdateSession,
  DEFAULT_REFLECTION_QUESTIONS,
} from './course.schema';

/**
 * The session catalogue is readable by every signed-in role, students included,
 * so the quiz answer key has to come off before it leaves the service. Only
 * admins and instructors — the people who build the quiz — see which option is
 * correct.
 */
const redactForCaller = <T extends { reflectionQuiz?: any }>(session: T, role: string | undefined): T =>
  canSeeAnswerKey(role) || !Array.isArray(session.reflectionQuiz)
    ? session
    : { ...session, reflectionQuiz: stripAnswerKey(session.reflectionQuiz) };

const callerRole = (req: Request): string | undefined => req.headers['x-user-role'] as string | undefined;

export const courseController = {
  // ── Program ──────────────────────────────────────────────────

  async createProgram(req: Request, res: Response) {
    const input = validateCreateProgram(req.body);
    const result = await courseService.createProgram(input);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(result, 'Program created'));
  },

  async getAllPrograms(req: Request, res: Response) {
    const result = await courseService.getAllPrograms();
    const role = callerRole(req);
    return res.status(HTTP_STATUS.OK).json(
      successResponse(
        result.map((p) => ({ ...p, sessions: p.sessions.map((s) => redactForCaller(s, role)) })),
        'Programs fetched'
      )
    );
  },

  async getAllSessions(req: Request, res: Response) {
    const result = await courseService.getAllSessions();
    const role = callerRole(req);
    return res
      .status(HTTP_STATUS.OK)
      .json(successResponse(result.map((s) => redactForCaller(s, role)), 'Sessions fetched'));
  },

  async getProgramById(req: Request, res: Response) {
    const result = await courseService.getProgramById(req.params.id);
    const role = callerRole(req);
    return res.status(HTTP_STATUS.OK).json(
      successResponse(
        { ...result, sessions: result.sessions.map((s) => redactForCaller(s, role)) },
        'Program fetched'
      )
    );
  },

  async updateProgram(req: Request, res: Response) {
    const result = await courseService.updateProgram(req.params.id, req.body);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Program updated'));
  },

  async deleteProgram(req: Request, res: Response) {
    await courseService.deleteProgram(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Program deleted'));
  },

  // ── PaymentPlan ───────────────────────────────────────────────

  async upsertPaymentPlan(req: Request, res: Response) {
    const input = validateUpsertPaymentPlan(req.body);
    const result = await courseService.upsertPaymentPlan(req.params.programId, input);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Payment plan saved'));
  },

  async deletePaymentPlan(req: Request, res: Response) {
    const { programId, type } = req.params;
    if (!['FULL', 'INSTALLMENT'].includes(type)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'Invalid plan type' });
    }
    await courseService.deletePaymentPlan(programId, type as 'FULL' | 'INSTALLMENT');
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Payment plan removed'));
  },

  // ── Session ───────────────────────────────────────────────────

  async createSession(req: Request, res: Response) {
    const input = validateCreateSession(req.body);
    const result = await courseService.createSession(req.params.programId, input);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(result, 'Session created'));
  },

  async updateSession(req: Request, res: Response) {
    const input = validateUpdateSession(req.body);
    const result = await courseService.updateSession(req.params.id, input);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Session updated'));
  },

  /** Lets the admin UI offer "reset to defaults" without hardcoding the list. */
  /**
   * Powers "Reset to defaults" in the admin editors. `data` stays the bare
   * string array the original text editor consumes; the quiz builder reads
   * `quiz` off the same response, so one endpoint serves both.
   */
  async getDefaultReflectionQuestions(_req: Request, res: Response) {
    return res.status(HTTP_STATUS.OK).json({
      ...successResponse(DEFAULT_REFLECTION_QUESTIONS, 'Default reflection questions fetched'),
      quiz: defaultReflectionQuiz(),
    });
  },

  async deleteSession(req: Request, res: Response) {
    await courseService.deleteSession(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Session deleted'));
  },
};
