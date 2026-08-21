import { Router, Request, Response } from 'express';
import { HTTP_STATUS } from '@futurespark/constants';
import { asyncHandler } from '@futurespark/middleware';
import { successResponse, errorResponse } from '@futurespark/response';
import { logger } from '@futurespark/logger';
import { clampDays, getRecordingsMetrics, getZoomMetrics } from './metrics.service';
import { getIntegrationFeed } from './feed.service';

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


/**
 * GET /metrics/feed — recent recordings events for the Technical Dashboard.
 *
 * `since` is an ISO instant; omitted means no lower bound. `limit` is PER
 * EVENT TYPE, because the gateway merges three services and re-slices — a
 * global limit here would let one chatty type crowd the others out before the
 * merge ever saw them.
 */
router.get('/feed', asyncHandler(async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res.status(HTTP_STATUS.FORBIDDEN).json(errorResponse('Only an admin can read the technical feed.'));
  }
  const rawSince = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
  const since = rawSince && !Number.isNaN(rawSince.getTime()) ? rawSince : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200);

  const data = await getIntegrationFeed(since, limit);
  res.status(HTTP_STATUS.OK).json(successResponse(data, 'Feed loaded.'));
}));

export default router;
