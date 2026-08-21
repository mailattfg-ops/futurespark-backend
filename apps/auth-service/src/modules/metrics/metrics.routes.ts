import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { getClassRefs, getPipelineMetrics } from './metrics.service';
import { getAuthFeed } from './feed.service';

/**
 * /metrics — read-only aggregates for the admin's System Health page.
 *
 * ADMIN-only, judged from the gateway-injected x-user-role header the same
 * way the ai-admin endpoints do it — there is no role middleware in this
 * codebase, so the gate lives on each handler. Everything here is a GET, so
 * the audit middleware never records any of it.
 */

const router = Router();

const isAdmin = (req: Request): boolean =>
  String(req.headers['x-user-role'] ?? '').toUpperCase() === 'ADMIN';

router.get(
  '/pipeline',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json(errorResponse('Only an admin can read the pipeline metrics.'));
    }
    const data = await getPipelineMetrics(req.query.days, req.query.refresh === 'true');
    res.status(HTTP_STATUS.OK).json(successResponse(data, 'Pipeline metrics loaded.'));
  })
);

router.get(
  '/class-refs',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json(errorResponse('Only an admin can look up class references.'));
    }
    const data = await getClassRefs(req.query.ids);
    res.status(HTTP_STATUS.OK).json(successResponse(data, 'Class references loaded.'));
  })
);


/**
 * GET /metrics/feed — recent pipeline events for the Technical Dashboard.
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

  const data = await getAuthFeed(since, limit);
  res.status(HTTP_STATUS.OK).json(successResponse(data, 'Feed loaded.'));
}));

export const metricsRoutes = router;
