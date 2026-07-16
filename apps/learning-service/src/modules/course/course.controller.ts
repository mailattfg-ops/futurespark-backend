import { Request, Response } from 'express';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { courseService } from './course.service';
import {
  validateCreateProgram,
  validateUpsertPaymentPlan,
  validateCreateSession,
} from './course.schema';

export const courseController = {
  // ── Program ──────────────────────────────────────────────────

  async createProgram(req: Request, res: Response) {
    const input = validateCreateProgram(req.body);
    const result = await courseService.createProgram(input);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(result, 'Program created'));
  },

  async getAllPrograms(req: Request, res: Response) {
    const result = await courseService.getAllPrograms();
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Programs fetched'));
  },

  async getAllSessions(req: Request, res: Response) {
    const result = await courseService.getAllSessions();
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Sessions fetched'));
  },

  async getProgramById(req: Request, res: Response) {
    const result = await courseService.getProgramById(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Program fetched'));
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
    const result = await courseService.updateSession(req.params.id, req.body);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Session updated'));
  },

  async deleteSession(req: Request, res: Response) {
    await courseService.deleteSession(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Session deleted'));
  },
};
