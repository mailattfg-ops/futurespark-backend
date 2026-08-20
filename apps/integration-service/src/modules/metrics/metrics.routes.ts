import { Router, Request, Response } from 'express';
import { HTTP_STATUS } from '@futurespark/constants';
import { successResponse, errorResponse } from '@futurespark/response';
import { logger } from '@futurespark/logger';
import { clampDays, getRecordingsMetrics, getZoomMetrics } from './metrics.service';

/**
 * /metrics/* — read-only aggregates for the admin System Health page, called
 * by the gateway. ADMIN-only, judged from the gateway-injected x-user-role
 * header the same way the ai-admin endpoints do it.
 */

const router = Router();

const isAdmin = (req: Request): boolean =>
  String(req.headers['x-user-role'] ?? '').toUpperCase() === 'ADMIN';

router.get('/recordings', async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res.status(HTTP_STATUS.FORBIDDEN).json(errorResponse('Only an admin can read system metrics.'));
  }
  try {
    const data = await getRecordingsMetrics(clampDays(req.query.days), req.query.refresh === 'true');
    return res.status(HTTP_STATUS.OK).json(successResponse(data, 'Recording metrics loaded.'));
  } catch (err: any) {
    logger.error(`[Metrics] Recording metrics failed: ${err.message}`);
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json(errorResponse(err.message || 'Failed to load recording metrics'));
  }
});

router.get('/zoom', async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res.status(HTTP_STATUS.FORBIDDEN).json(errorResponse('Only an admin can read system metrics.'));
  }
  try {
    const data = await getZoomMetrics(String(req.query.refresh ?? '') === 'true');
    return res.status(HTTP_STATUS.OK).json(successResponse(data, 'Zoom metrics loaded.'));
  } catch (err: any) {
    // Zoom API failures degrade inside the service and still answer 200 —
    // landing here means the LOCAL database read failed, which really is a 500.
    logger.error(`[Metrics] Zoom metrics failed: ${err.message}`);
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json(errorResponse(err.message || 'Failed to load Zoom metrics'));
  }
});

export default router;
