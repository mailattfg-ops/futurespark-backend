import { Request, Response } from 'express';
import { ZoomWebhooksService } from './webhooks.service';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';

export class ZoomWebhooksController {
  static async handleWebhook(req: Request, res: Response) {
    try {
      const { event, payload } = req.body;

      // Handle Zoom CRC URL validation challenge
      if (event === 'endpoint.url_validation') {
        const plainToken = payload?.plainToken;
        if (!plainToken) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Missing plainToken in URL validation request' });
        }
        const validationResponse = ZoomWebhooksService.validateUrl(plainToken);
        logger.info('[ZoomWebhook] Successfully responded to Zoom URL validation challenge');
        return res.status(HTTP_STATUS.OK).json(validationResponse);
      }

      // Process asynchronous webhook event
      if (event && payload) {
        ZoomWebhooksService.handleEvent(event, payload).catch((err) => {
          logger.error(`[ZoomWebhook] Event processing error: ${err.message}`);
        });
      }

      // Zoom expects HTTP 200 within 3 seconds
      return res.status(HTTP_STATUS.OK).json({ success: true });
    } catch (err: any) {
      logger.error(`[ZoomWebhooksController] error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: err.message || 'Webhook processing failed' });
    }
  }
}
