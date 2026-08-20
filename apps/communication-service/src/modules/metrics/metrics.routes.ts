import { Router, Request, Response } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { clampWindowDays, getClassSends, getWhatsAppMetrics } from './metrics.service';

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

export const metricsRoutes = router;
