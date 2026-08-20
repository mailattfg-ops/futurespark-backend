import { Router, type Request, type Response } from 'express';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { asyncHandler } from '@futurespark/middleware';
import { getAiMetrics } from './metrics.service';

/**
 * /metrics/* — System Health aggregates for the gateway dashboard. ADMIN-only,
 * judged from the gateway-injected x-user-role header the same way the
 * ai-admin endpoints do it.
 */

const router = Router();

const isAdmin = (req: Request): boolean =>
  String(req.headers['x-user-role'] ?? '').toUpperCase() === 'ADMIN';

router.get(
  '/ai',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json(errorResponse('Only an admin can view the AI metrics.'));
    }
    const data = await getAiMetrics(req.query.days, req.query.refresh === 'true');
    res.status(HTTP_STATUS.OK).json(successResponse(data, 'AI metrics loaded.'));
  })
);

export const metricsRoutes = router;
