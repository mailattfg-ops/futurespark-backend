import { Router, Request, Response } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { clampWindowDays, getClassSends, getWhatsAppMetrics } from './metrics.service';
import { getCommFeed } from './feed.service';

const router = Router();

/**
 * /metrics/* — read-only aggregates for the admin system-health page. Every
 * route is ADMIN-only, judged from the gateway-injected x-user-role header the
 * same way learning-service's ai-admin routes do it: recentSends carries real
 * parent phone numbers, so these are not staff-readable.
 */
const isAdmin = (req: Request): boolean =>
  String(req.headers['x-user-role'] ?? '').toUpperCase() === 'ADMIN';

router.get(
  '/whatsapp',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json(errorResponse('Only an admin can read the WhatsApp metrics.'));
    }
    const data = await getWhatsAppMetrics(clampWindowDays(req.query.days), req.query.refresh === 'true');
    res.status(HTTP_STATUS.OK).json(successResponse(data, 'WhatsApp metrics loaded.'));
  })
);

router.get(
  '/whatsapp/class/:classId',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json(errorResponse('Only an admin can read the WhatsApp metrics.'));
    }
    const data = await getClassSends(req.params.classId);
    res.status(HTTP_STATUS.OK).json(successResponse(data, 'Class WhatsApp sends loaded.'));
  })
);


/**
 * GET /metrics/feed — recent messaging events for the Technical Dashboard.
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

  const data = await getCommFeed(since, limit);
  res.status(HTTP_STATUS.OK).json(successResponse(data, 'Feed loaded.'));
}));

export const metricsRoutes = router;
