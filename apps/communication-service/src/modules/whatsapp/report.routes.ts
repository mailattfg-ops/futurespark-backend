import { Router, Request, Response } from 'express';
import { HTTP_STATUS } from '@futurespark/constants';
import { successResponse, errorResponse } from '@futurespark/response';
import { logger } from '@futurespark/logger';
import { maskPhone, whatsappService } from './whatsapp.service';
import { sessionReportService } from './report.service';

const router = Router();

/**
 * POST /whatsapp/session-report
 *
 * Service-to-service only — the gateway proxies `/api/notifications` and
 * `/api/whatsapp/webhook` and nothing else on this service, so this route has no
 * public path. That is what makes it safe to return the delivery outcome in the
 * body: unlike `POST /notifications`, whose `recipientId` comes from an untrusted
 * caller and whose result would leak whether a given user has a phone on file,
 * the only caller here is auth-service's report cron, which needs to know
 * whether to stamp the class as reported or retry it.
 */
router.post('/session-report', async (req: Request, res: Response) => {
  try {
    const { to, recipientId, classId, variables, document, caption } = req.body ?? {};

    if (!to && !recipientId) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(errorResponse('Either "to" (phone number) or "recipientId" is required.'));
    }

    let phone: string | null = typeof to === 'string' && to.trim().length > 0 ? to.trim() : null;

    if (!phone && recipientId) {
      phone = await whatsappService.resolveUserPhoneNumber(recipientId);
      if (!phone) {
        // Not a server error: plenty of parents have no phone on file, and the
        // caller should record that rather than retry it forever.
        return res.status(HTTP_STATUS.OK).json(
          successResponse(
            {
              success: false,
              documentDelivered: false,
              failureKind: 'NO_PHONE_NUMBER',
              error: 'No phone number on record for this recipient.',
              retryable: false,
            },
            'No phone number on record for this recipient.'
          )
        );
      }
    }

    const result = await sessionReportService.sendSessionReport({
      to: phone as string,
      recipientId: typeof recipientId === 'string' ? recipientId : undefined,
      classId: typeof classId === 'string' ? classId : undefined,
      variables: variables && typeof variables === 'object' ? variables : {},
      document,
      caption: typeof caption === 'string' ? caption : undefined,
    });

    // Always 200. A refused send is a fact about the message, not a failure of
    // this endpoint, and the caller branches on `result.success`.
    return res
      .status(HTTP_STATUS.OK)
      .json(successResponse(result, result.success ? 'Session report sent.' : 'Session report was not delivered.'));
  } catch (err: any) {
    logger.error(`[Session Report] Unhandled error sending report to ${maskPhone(req.body?.to)}: ${err.message}`);
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json(errorResponse(err.message || 'Failed to send the session report'));
  }
});

export { router as whatsappReportRoutes };
