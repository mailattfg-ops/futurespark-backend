import { Request, Response } from 'express';
import { logger } from '@futurespark/logger';
import db from '../../database/datasource';
import { whatsappService } from './whatsapp.service';

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
  async handleEvent(req: Request, res: Response) {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') {
      return res.sendStatus(404);
    }

    // Acknowledge receipt to Meta immediately (as required by Meta within 20 seconds)
    res.sendStatus(200);

    // Process event asynchronously so we don't hold up Meta's connection
    try {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      // 1. Handle delivery/read status updates
      if (value?.statuses) {
        for (const status of value.statuses) {
          const messageId = status.id;
          const msgStatus = status.status; // "sent", "delivered", "read", "failed"
          logger.info(`[WhatsApp Webhook] Message status update — ID: ${messageId}, Status: ${msgStatus}`);

          try {
            await db.whatsAppMessage.update({
              where: { messageId },
              data: {
                status: msgStatus,
                ...(status.errors && { error: JSON.stringify(status.errors) }),
              },
            });
          } catch (err: any) {
            // It might be status update for a message we didn't track, or database update failed
            logger.debug(`[WhatsApp Webhook] Could not update message status in DB (might be untracked message): ${err.message}`);
          }
        }
      }

      // 2. Handle incoming messages from users
      if (value?.messages) {
        for (const message of value.messages) {
          const from = message.from;
          const name = value.contacts?.[0]?.profile?.name || 'User';
          const msgType = message.type;
          const messageId = message.id;

          let bodyContent = '';
          let userText = '';

          if (msgType === 'text') {
            userText = message.text?.body || '';
            bodyContent = userText;
          } else if (msgType === 'button') {
            userText = message.button?.text || '';
            bodyContent = message.button?.payload || '';
          } else {
            bodyContent = `[Non-text type: ${msgType}]`;
          }

          logger.info(`[WhatsApp Webhook] Inbound message from ${name} (${from}) type: ${msgType}: "${bodyContent}"`);

          // Log inbound message to DB
          await db.whatsAppMessage.create({
            data: {
              messageId,
              from,
              to: 'SYSTEM',
              direction: 'INBOUND',
              type: msgType,
              body: bodyContent,
              status: 'received',
            },
          });

          // Trigger Auto-Replies
          if (msgType === 'text') {
            const cleanText = userText.trim().toLowerCase();

            if (cleanText.includes('schedule')) {
              await whatsappService.sendTextMessage(
                from,
                '📅 FutureSpark Schedule:\n• Mon-Fri: 9:00 AM - 5:00 PM\n• Saturday: 10:00 AM - 2:00 PM\n• Sunday: Closed\n\nTo see list of operations, reply "options".'
              );
            } else if (cleanText.includes('options')) {
              await whatsappService.sendInteractiveButtons(
                from,
                'Choose one of the options below:',
                [
                  { id: 'Schedule', title: '📅 Schedule' },
                  { id: 'Contact', title: '📞 Contact Us' },
                  { id: 'Location', title: '📍 Our Location' },
                ]
              );
            } else if (cleanText.includes('help')) {
              await whatsappService.sendTextMessage(
                from,
                '💡 FutureSpark Help Menu:\n• Reply "schedule" to see hours of operation.\n• Reply "options" to show our quick menu.\n• Reply "help" to show this message.'
              );
            } else {
              // Default Welcome message
              await whatsappService.sendTextMessage(
                from,
                `Hi ${name}! Welcome to FutureSpark. ✨\n\nHow can we help you today? Reply "options" to view our menu, or "help" for a list of commands.`
              );
            }
          } else if (msgType === 'button') {
            const payload = message.button?.payload; // e.g. "Schedule", "Contact", "Location"

            if (payload === 'Schedule') {
              await whatsappService.sendTextMessage(
                from,
                '📅 FutureSpark Schedule:\n• Mon-Fri: 9:00 AM - 5:00 PM\n• Saturday: 10:00 AM - 2:00 PM\n• Sunday: Closed'
              );
            } else if (payload === 'Contact') {
              await whatsappService.sendTextMessage(
                from,
                '📞 Contact FutureSpark:\n• Phone: +1234567890\n• Email: info@futurespark.com\n• Website: https://futurespark.com'
              );
            } else if (payload === 'Location') {
              await whatsappService.sendTextMessage(
                from,
                '📍 FutureSpark Headquarters:\n123 Future St, Tech City, TC 94016\n\nMap: https://maps.google.com/?q=FutureSpark'
              );
            } else {
              await whatsappService.sendTextMessage(
                from,
                `You clicked button: "${payload}". Reply "options" to show the main menu again.`
              );
            }
          }
        }
      }
    } catch (error: any) {
      logger.error(`[WhatsApp Webhook] Error processing webhook event: ${error.message}`);
    }
  },
};

