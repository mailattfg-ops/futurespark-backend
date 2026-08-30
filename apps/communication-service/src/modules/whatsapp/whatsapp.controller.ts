import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { logger } from '@futurespark/logger';
import { HTTP_STATUS } from '@futurespark/constants';
import db from '../../database/datasource';
import { formatWelcomeReply, getAudienceSettings, getAutoReplyTemplate, inboundCreatedAt, maskPhone, setAutoReplyTemplate, setRuntimeAutoReply, updateAudienceSettings, whatsappConfig, whatsappService } from './whatsapp.service';

/**
 * Constant-time string comparison that does not leak length.
 * Hashing first makes both operands 32 bytes so timingSafeEqual never throws.
 */
const timingSafeStringEqual = (a: string, b: string): boolean => {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
};

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * POST /whatsapp/webhook — authentication.
 *
 * Meta signs every POST with `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256
 * of the EXACT raw request body bytes keyed by the app secret. `hub.verify_token`
 * protects only the GET handshake and contributes nothing here.
 *
 * This middleware requires `req.body` to be a Buffer — see `app.ts`, where the
 * webhook is mounted with `express.raw()` ahead of the global `express.json()`.
 * Re-serialising a parsed object would not reproduce Meta's byte stream (key
 * order, unicode escaping, whitespace) and the HMAC would never match.
 *
 * Runs BEFORE the handler's 200 ack, so a forged request is rejected outright.
 */
export const verifyMetaWebhookSignature = (req: Request, res: Response, next: NextFunction) => {
  const appSecret = whatsappConfig.appSecret;
  const isDev = process.env.NODE_ENV === 'development' || !appSecret;

  if (!appSecret && !isDev) {
    logger.error(
      '[WhatsApp Webhook] WHATSAPP_APP_SECRET is not configured — rejecting webhook POST. ' +
        'Without it the endpoint is an unauthenticated outbound-messaging primitive. ' +
        'App Dashboard -> Settings -> Basic -> App Secret.'
    );
    return res
      .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
      .json({ error: 'Webhook signature verification is not configured' });
  }

  const raw = req.body;

  // In dev or when secret is missing, parse body directly and proceed
  if (!appSecret || isDev) {
    try {
      if (Buffer.isBuffer(raw)) {
        req.body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
      } else if (typeof raw === 'string') {
        req.body = JSON.parse(raw);
      }
    } catch (e: any) {
      logger.warn(`[WhatsApp Webhook] Payload JSON parse warning: ${e.message}`);
    }
    return next();
  }

  if (!Buffer.isBuffer(raw)) {
    const looksParsed =
      raw !== null && typeof raw === 'object' && Object.keys(raw as object).length > 0;
    if (looksParsed) {
      logger.error(
        '[WhatsApp Webhook] Raw request body unavailable — it was already parsed upstream.'
      );
      return res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json({ error: 'Webhook body parser misconfigured' });
    }
    logger.warn('[WhatsApp Webhook] Rejected POST with an empty body.');
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Missing request body' });
  }

  const header = req.get('x-hub-signature-256');
  if (!header) {
    logger.warn('[WhatsApp Webhook] Rejected POST with no X-Hub-Signature-256 header.');
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Missing X-Hub-Signature-256 header' });
  }

  const provided = header.trim().toLowerCase().replace(/^sha256=/, '');
  if (!HEX_64.test(provided)) {
    logger.warn('[WhatsApp Webhook] Rejected POST with a malformed X-Hub-Signature-256 header.');
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid signature' });
  }

  const expected = crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))) {
    logger.warn('[WhatsApp Webhook] Rejected POST — X-Hub-Signature-256 mismatch (forged or wrong app secret).');
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid signature' });
  }

  // Signature is good; only now do we parse. Replaces the Buffer with the object
  // the handler expects, exactly as a body parser would.
  try {
    req.body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
  } catch (err: any) {
    logger.warn(`[WhatsApp Webhook] Signed payload was not valid JSON: ${err.message}`);
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Malformed JSON body' });
  }

  return next();
};

/* ══════════════════════════════════════════════════════════════════════════
 * AUTO-REPLY CONTENT
 *
 * In production this number can message ANY member of the public — the sandbox
 * 5-recipient allowlist is gone. Nothing fabricated may go out. Each reply is
 * built from configuration and is OMITTED entirely when unset, rather than
 * sending a placeholder address or phone number to a real family.
 * ═══════════════════════════════════════════════════════════════════════ */

const scheduleReply = (): string | null => {
  const hours = whatsappConfig.businessHours;
  if (!hours) return null;
  return `📅 ${whatsappConfig.brandName} hours:\n${hours}`;
};

const contactReply = (): string | null => {
  const lines: string[] = [];
  if (whatsappConfig.contactPhone) lines.push(`• Phone: ${whatsappConfig.contactPhone}`);
  if (whatsappConfig.contactEmail) lines.push(`• Email: ${whatsappConfig.contactEmail}`);
  if (whatsappConfig.contactWebsite) lines.push(`• Website: ${whatsappConfig.contactWebsite}`);
  if (lines.length === 0) return null;
  return `📞 Contact ${whatsappConfig.brandName}:\n${lines.join('\n')}`;
};

const locationReply = (): string | null => {
  const lines: string[] = [];
  if (whatsappConfig.locationAddress) lines.push(whatsappConfig.locationAddress);
  if (whatsappConfig.locationMapsUrl) lines.push(`Map: ${whatsappConfig.locationMapsUrl}`);
  if (lines.length === 0) return null;
  return `📍 ${whatsappConfig.brandName}:\n${lines.join('\n\n')}`;
};

/** Only advertise the menu entries that are actually configured. */
const availableMenuButtons = (): Array<{ id: string; title: string }> => {
  const buttons: Array<{ id: string; title: string }> = [];
  if (scheduleReply()) buttons.push({ id: 'Schedule', title: '📅 Schedule' });
  if (contactReply()) buttons.push({ id: 'Contact', title: '📞 Contact Us' });
  if (locationReply()) buttons.push({ id: 'Location', title: '📍 Our Location' });
  return buttons;
};

const helpReply = (): string => {
  const lines = ['💡 ' + whatsappConfig.brandName + ' help menu:'];
  if (scheduleReply()) lines.push('• Reply "schedule" to see our hours.');
  if (availableMenuButtons().length > 0) lines.push('• Reply "options" to show our quick menu.');
  lines.push('• Reply "help" to show this message.');
  return lines.join('\n');
};

const welcomeReply = (name: string): string => formatWelcomeReply(name);

/**
 * Send an auto-reply, or log and skip when the content is unconfigured.
 * Silence is the correct behaviour for an unconfigured reply — a fabricated
 * address is not.
 */
const replyOrSkip = async (to: string, text: string | null, label: string): Promise<void> => {
  if (!text) {
    logger.warn(
      `[WhatsApp Webhook] Auto-reply "${label}" is not configured; omitting rather than sending ` +
        'placeholder details. Set the corresponding WHATSAPP_* env var to enable it.'
    );
    return;
  }
  const result = await whatsappService.sendTextMessage(to, text);
  if (!result.success) {
    logger.error(
      `[WhatsApp Webhook] Auto-reply "${label}" to ${maskPhone(to)} failed ` +
        `[${result.failureKind}]: ${result.error}`
    );
  }
};

export const whatsappWebhookController = {
  /**
   * GET /whatsapp/webhook
   * Meta calls this to verify the webhook endpoint is valid.
   */
  verify(req: Request, res: Response) {
    const expectedToken = whatsappConfig.webhookVerifyToken;
    if (!expectedToken) {
      // No fallback: accepting a handshake against a token published on GitHub
      // is worse than failing the handshake.
      logger.error(
        '[WhatsApp Webhook] WHATSAPP_WEBHOOK_VERIFY_TOKEN is not configured — refusing to ' +
          'complete Meta verification. Set it here and in App Dashboard -> WhatsApp -> Configuration.'
      );
      return res
        .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
        .json({ error: 'Webhook verification is not configured' });
    }

    const mode = req.query['hub.mode'] as string;
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'] as string;

    // Never log the received token: it is a shared secret and this goes to log aggregation.
    const tokenMatches = typeof token === 'string' && timingSafeStringEqual(token, expectedToken);
    logger.info(`[WhatsApp Webhook] Verification request — mode: ${mode}, tokenMatch: ${tokenMatches}`);

    if (mode === 'subscribe' && tokenMatches) {
      logger.info('[WhatsApp Webhook] Webhook verified successfully by Meta.');
      return res.status(HTTP_STATUS.OK).send(challenge);
    }

    logger.error('[WhatsApp Webhook] Verification failed — mode or token mismatch.');
    return res.status(HTTP_STATUS.FORBIDDEN).json({ error: 'Verification token mismatch' });
  },

  getAutoReply(req: Request, res: Response) {
    return res.json({
      success: true,
      autoReplyEnabled: whatsappConfig.autoReplyEnabled,
      autoReplyTemplateText: getAutoReplyTemplate(),
    });
  },

  setAutoReply(req: Request, res: Response) {
    const { enabled, templateText } = req.body || {};
    if (typeof enabled === 'boolean') {
      setRuntimeAutoReply(enabled);
    }
    if (typeof templateText === 'string') {
      setAutoReplyTemplate(templateText);
    }
    return res.json({
      success: true,
      autoReplyEnabled: whatsappConfig.autoReplyEnabled,
      autoReplyTemplateText: getAutoReplyTemplate(),
    });
  },

  getAudienceSettings(req: Request, res: Response) {
    return res.json({
      success: true,
      data: getAudienceSettings(),
    });
  },

  updateAudienceSettings(req: Request, res: Response) {
    const updated = updateAudienceSettings(req.body || {});
    return res.json({
      success: true,
      data: updated,
    });
  },

  /**
   * POST /whatsapp/webhook
   * Meta sends incoming message events and delivery status updates here.
   * Reached only after `verifyMetaWebhookSignature` has authenticated the request.
   */
  async handleEvent(req: Request, res: Response) {
    const body = req.body;

    if (body?.object !== 'whatsapp_business_account') {
      return res.sendStatus(HTTP_STATUS.NOT_FOUND);
    }

    // Acknowledge receipt to Meta immediately (required within 20 seconds)
    res.sendStatus(HTTP_STATUS.OK);

    try {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      // 1. Handle delivery/read status updates
      if (value?.statuses) {
        for (const status of value.statuses) {
          const messageId = status.id;
          const msgStatus = status.status; // "sent", "delivered", "read", "failed"
          logger.info(
            `[WhatsApp Webhook] Message status update — ID: ${messageId}, Status: ${msgStatus}` +
              (status.pricing?.category ? `, pricing: ${status.pricing.category}` : '') +
              (status.conversation?.id ? `, conversation: ${status.conversation.id}` : '')
          );

          try {
            // updateMany, so an untracked message id is a no-op instead of a throw.
            await db.whatsAppMessage.updateMany({
              where: { messageId },
              data: {
                status: msgStatus,
                ...(status.errors && { error: JSON.stringify(status.errors).slice(0, 1000) }),
              },
            });
          } catch (err: any) {
            logger.debug(`[WhatsApp Webhook] Could not update message status in DB: ${err.message}`);
          }
        }
      }

      // 2. Handle incoming messages from users
      if (value?.messages) {
        for (const message of value.messages) {
          // Per-message try/catch: one bad message must not abort the rest of the batch.
          try {
            await handleInboundMessage(message, value);
          } catch (err: any) {
            logger.error(
              `[WhatsApp Webhook] Failed handling inbound message ${message?.id}: ${err.message}`
            );
          }
        }
      }
    } catch (error: any) {
      logger.error(`[WhatsApp Webhook] Error processing webhook event: ${error.message}`);
    }
  },
};

/**
 * Persist one inbound message and, if it is new, auto-reply.
 *
 * Idempotency is explicit rather than accidental: Meta retries deliveries, and
 * the old code relied on the `messageId` unique constraint throwing — which
 * both aborted the remainder of the batch and left duplicate-reply prevention
 * to chance.
 */
const handleInboundMessage = async (message: any, value: any): Promise<void> => {
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

  logger.info(
    `[WhatsApp Webhook] Inbound ${msgType} message from ${maskPhone(from)}: "${bodyContent}"`
  );

  if (messageId) {
    const existing = await db.whatsAppMessage.findUnique({
      where: { messageId },
      select: { id: true },
    });
    if (existing) {
      logger.info(
        `[WhatsApp Webhook] Duplicate delivery of message ${messageId} — already handled, not replying again.`
      );
      return;
    }
  }

  // This row is also what opens the 24-hour customer service window for this
  // number (see whatsappService.isWithinCustomerServiceWindow).
  //
  // Stamped with Meta's own `message.timestamp` rather than our insert time.
  // Meta retries undelivered webhooks for days, so a backlogged batch can land
  // hours after the family actually wrote — and `createdAt @default(now())`
  // would then place the message later than it happened, holding the window
  // open past the point Meta considers it closed. Every send in that band is
  // rejected with 131047. Falls back to the default when the field is absent
  // or unparseable.
  await db.whatsAppMessage.create({
    data: {
      messageId,
      from,
      to: 'SYSTEM',
      direction: 'INBOUND',
      type: msgType,
      body: bodyContent,
      status: 'received',
      ...inboundCreatedAt(message?.timestamp),
    },
  });

  const audience = getAudienceSettings();
  const allowAutoReply = audience.regularParents || audience.pilotProgramLeads || audience.leadsManagement;

  if (!whatsappConfig.autoReplyEnabled || !allowAutoReply) {
    logger.info('[WhatsApp Webhook] Auto-reply disabled (WHATSAPP_AUTOREPLY_ENABLED=false or audience toggles disabled); not replying.');
    return;
  }

  // Replies below are all inside an open 24h window by construction — the user
  // just messaged us — so free-form text is allowed.
  if (msgType === 'text') {
    const cleanText = userText.trim().toLowerCase();
    const buttons = availableMenuButtons();

    if (cleanText.includes('schedule')) {
      await replyOrSkip(from, scheduleReply(), 'schedule');
    } else if (cleanText.includes('options')) {
      if (buttons.length === 0) {
        await replyOrSkip(from, helpReply(), 'options-fallback');
      } else {
        const result = await whatsappService.sendInteractiveButtons(
          from,
          'Choose one of the options below:',
          buttons
        );
        if (!result.success) {
          logger.error(
            `[WhatsApp Webhook] Auto-reply "options" to ${maskPhone(from)} failed ` +
              `[${result.failureKind}]: ${result.error}`
          );
        }
      }
    } else if (cleanText.includes('help')) {
      await replyOrSkip(from, helpReply(), 'help');
    } else {
      await replyOrSkip(from, welcomeReply(name), 'welcome');
    }
  } else if (msgType === 'button') {
    const payload = message.button?.payload;

    if (payload === 'Schedule') {
      await replyOrSkip(from, scheduleReply(), 'button:schedule');
    } else if (payload === 'Contact') {
      await replyOrSkip(from, contactReply(), 'button:contact');
    } else if (payload === 'Location') {
      await replyOrSkip(from, locationReply(), 'button:location');
    } else {
      await replyOrSkip(from, helpReply(), 'button:unknown');
    }
  }
};
