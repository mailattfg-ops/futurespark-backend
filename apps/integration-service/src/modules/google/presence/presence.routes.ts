import { Router, Request, Response } from 'express';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';
import { MeetPresenceService } from './presence.service';

const router = Router();

/** Live presence for every meeting whose join window is currently open. */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const snapshot = await MeetPresenceService.getPresenceSnapshot();
    return res.status(HTTP_STATUS.OK).json(successResponse(snapshot, 'Presence snapshot loaded.'));
  } catch (err: any) {
    logger.error(`[MeetPresence] Snapshot failed: ${err.message}`);
    // Degrade to an empty list — the dashboard should still render without presence.
    return res.status(HTTP_STATUS.OK).json(successResponse([], 'Presence unavailable.'));
  }
});

/** Force an immediate poll (useful for testing without waiting for the interval). */
router.post('/refresh', async (_req: Request, res: Response) => {
  try {
    const result = await MeetPresenceService.pollOnce();
    const snapshot = await MeetPresenceService.getPresenceSnapshot();
    return res
      .status(HTTP_STATUS.OK)
      .json(successResponse({ ...result, snapshot }, 'Presence refreshed.'));
  } catch (err: any) {
    logger.error(`[MeetPresence] Manual refresh failed: ${err.message}`);
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message));
  }
});

export default router;
