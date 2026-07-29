import { Request, Response } from 'express';
import { logger } from '@futurespark/logger';

const WHATSAPP_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'futurespark-webhook-secret';

export const whatsappWebhookController = {
  /**
   * GET /whatsapp/webhook
   * Meta calls this to verify the webhook endpoint is valid.
   */
  verify(req: Request, res: Response) {
    const mode = req.query['hub.mode'] as string;
    const token = req.query['hub.verify_token'] as string;
    const challenge = req.query['hub.challenge'] as string;

    logger.info(`[WhatsApp Webhook] Verification request — mode: ${mode}, token: ${token}`);

    if (mode === 'subscribe' && token === WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      logger.info('[WhatsApp Webhook] ✅ Webhook verified successfully by Meta.');
      return res.status(200).send(challenge);
    }

    logger.error('[WhatsApp Webhook] ❌ Verification failed. Token mismatch.');
    return res.status(403).json({ error: 'Verification token mismatch' });
  },

  /**
   * POST /whatsapp/webhook
   * Meta sends incoming message events and delivery status updates here.
   */
  handleEvent(req: Request, res: Response) {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') {
      return res.sendStatus(404);
    }

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Handle delivery/read status updates
    if (value?.statuses) {
      for (const status of value.statuses) {
        logger.info(`[WhatsApp Webhook] Message ${status.id} status: ${status.status} → ${status.recipient_id}`);
      }
    }

    // Handle incoming messages from users
    if (value?.messages) {
      for (const message of value.messages) {
        const from = message.from;
        const name = value.contacts?.[0]?.profile?.name || 'User';
        const msgType = message.type;

        if (msgType === 'text') {
          const text = message.text?.body;
          logger.info(`[WhatsApp Webhook] 📩 Message from ${name} (${from}): "${text}"`);

          // TODO: Add auto-reply logic here based on message content
          // e.g. if text.toLowerCase() === 'schedule' → send class schedule
        } else if (msgType === 'button') {
          const payload = message.button?.payload;
          logger.info(`[WhatsApp Webhook] 🔘 Button reply from ${name} (${from}): "${payload}"`);

          // TODO: Handle quick reply button responses
        }
      }
    }

    // Always respond with 200 OK to acknowledge receipt to Meta
    return res.sendStatus(200);
  },
};
