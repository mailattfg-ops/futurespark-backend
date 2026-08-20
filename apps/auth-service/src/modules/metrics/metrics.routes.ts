import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { getClassRefs, getPipelineMetrics } from './metrics.service';

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

export const metricsRoutes = router;
