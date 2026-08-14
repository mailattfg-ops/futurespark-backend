import { Router, Request, Response } from 'express';
import { HTTP_STATUS } from '@futurespark/constants';
import { successResponse, errorResponse } from '@futurespark/response';
import { logger } from '@futurespark/logger';
import { ClassLifecycleService } from './lifecycle.service';

const router = Router();

/**
 * POST /classes/completed
 *
 * Called by auth-service when a mentor marks a class complete. Provider-neutral
 * on purpose: the caller knows the class, not whether it was taught in Meet or
 * Zoom, and the meeting row is found by who sat the lesson rather than by URL.
 */
router.post('/completed', async (req: Request, res: Response) => {
  try {
    const { meetingLink, studentId, sessionId, programId, startTime, completedAt } = req.body ?? {};

    if (!meetingLink && !(studentId && sessionId)) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(errorResponse('Either meetingLink, or studentId together with sessionId, is required.'));
    }

    const result = await ClassLifecycleService.markClassCompleted({
      meetingLink,
      studentId,
      sessionId,
      programId,
      startTime,
      completedAt,
    });

    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Class completion recorded.'));
  } catch (err: any) {
    logger.error(`[ClassLifecycle] Failed to record class completion: ${err.message}`);
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json(errorResponse(err.message || 'Failed to record class completion'));
  }
});

export default router;
