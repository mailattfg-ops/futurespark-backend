import db from '../../database/datasource';
import { logger } from '@futurespark/logger';
import { getAudienceSettings, whatsappConfig } from '../whatsapp/whatsapp.service';
import {
  maskPhone,
  whatsappService,
  WhatsAppFailureKind,
  WhatsAppSendResult,
} from '../whatsapp/whatsapp.service';

/**
 * What happened to the WhatsApp copy of a notification.
 *
 * INTERNAL ONLY — this must never be serialised into an HTTP response.
 * `POST /notifications` takes an arbitrary `recipientId` from the request body,
 * so echoing the delivery outcome back turns the endpoint into an oracle: a
 * caller can enumerate ids and read `NO_PHONE_NUMBER` vs `delivered` to learn
 * which users have a phone number on file, plus Meta message ids and
 * infrastructure error text. The outcome goes to the logs (where operators can
 * act on it) and to the WhatsAppMessage row (where it is queryable), not to the
 * caller. See `logDeliveryOutcome`.
 */
export interface WhatsAppDeliveryResult {
  attempted: boolean;
  delivered: boolean;
  /** 'text' inside the 24h window, 'template' outside it. */
  channel?: WhatsAppSendResult['channel'];
  messageId?: string;
  failureKind?: WhatsAppFailureKind | 'NO_PHONE_NUMBER' | 'TIMEOUT' | 'INTERNAL_ERROR' | 'WHATSAPP_DISABLED';
  error?: string;
  /** True when a retry with backoff could plausibly succeed. */
  retryable?: boolean;
}

const DEFAULT_DELIVERY_DEADLINE_MS = 8_000;

const deliveryDeadlineMs = (): number => {
  const raw = process.env.NOTIFICATION_WHATSAPP_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 60_000
    ? parsed
    : DEFAULT_DELIVERY_DEADLINE_MS;
};

/**
 * Fire-and-forget mode. Off by default — the whole point of this change is
 * that callers see failures. Some upstream callers (schedule.service.ts opens
 * a Prisma interactive transaction around its cross-service notification call)
 * cannot afford the extra latency; they should be refactored to notify outside
 * the transaction, and this switch exists so a hot fix does not require a
 * code change in another service.
 */
const isAsyncMode = (): boolean =>
  (process.env.NOTIFICATION_WHATSAPP_MODE || '').toLowerCase() === 'async';

/**
 * Resolve the recipient's phone and send the WhatsApp copy.
 *
 * Routed through `sendBusinessInitiatedMessage`, NOT `sendTextMessage`: these
 * are business-initiated by definition, so outside the 24-hour customer service
 * window a free-form text is rejected by Meta with 131047. That path picks text
 * or the approved template, and refuses outright when no template is configured.
 */
const deliverWhatsApp = async (data: {
  recipientId: string;
  title: string;
  message: string;
}): Promise<WhatsAppDeliveryResult> => {
  try {
    const audience = getAudienceSettings();
    const titleLower = (data.title || '').toLowerCase();
    const msgLower = (data.message || '').toLowerCase();

    const isPilotLead = titleLower.includes('pilot') || msgLower.includes('pilot');
    const isSalesLead = titleLower.includes('lead') || titleLower.includes('demo') || msgLower.includes('demo');
    const isRegularParent = titleLower.includes('parent') || msgLower.includes('parent') || titleLower.includes('session');

    const shouldSend =
      (isPilotLead && audience.pilotProgramLeads) ||
      (isSalesLead && audience.leadsManagement) ||
      (isRegularParent && audience.regularParents) ||
      (!isPilotLead && !isSalesLead && !isRegularParent && (audience.regularParents || audience.pilotProgramLeads || audience.leadsManagement));

    if (!shouldSend) {
      logger.info(
        `[Notification Service] WhatsApp message withheld for recipient ${data.recipientId} because audience toggle is DISABLED.`
      );
      return {
        attempted: false,
        delivered: false,
        failureKind: 'WHATSAPP_DISABLED',
        error: 'WhatsApp delivery withheld by Audience Section Control toggle settings.',
      };
    }

    if (whatsappConfig.outboundMode !== 'all') {
      return {
        attempted: false,
        delivered: false,
        failureKind: 'WHATSAPP_DISABLED',
        error: 'Outbound WhatsApp is limited to the manual session report (WHATSAPP_OUTBOUND_MODE).',
      };
    }

    const phone = await whatsappService.resolveUserPhoneNumber(data.recipientId);

    if (!phone) {
      // Expected for students and mentors: neither has a phone column today,
      // so those notifications are in-app only.
      logger.info(
        `[Notification Service] No phone number available for recipient ${data.recipientId}; ` +
          'notification is in-app only.'
      );
      return {
        attempted: false,
        delivered: false,
        failureKind: 'NO_PHONE_NUMBER',
        error: 'No phone number on record for this recipient',
      };
    }

    logger.info(
      `[Notification Service] Dispatching WhatsApp alert for recipient ${data.recipientId} ` +
        `to ${maskPhone(phone)}`
    );

    const result = await whatsappService.sendBusinessInitiatedMessage({
      to: phone,
      title: data.title,
      message: data.message,
      recipientId: data.recipientId,
    });

    if (result.success) {
      return {
        attempted: true,
        delivered: true,
        channel: result.channel,
        messageId: result.messageId,
      };
    }

    logger.error(
      `[Notification Service] WHATSAPP_NOTIFICATION_FAILED recipient=${data.recipientId} ` +
        `phone=${maskPhone(phone)} kind=${result.failureKind} retryable=${!!result.retryable} :: ${result.error}`
    );

    return {
      attempted: true,
      delivered: false,
      failureKind: result.failureKind,
      error: result.error,
      retryable: result.retryable,
    };
  } catch (err: any) {
    logger.error(
      `[Notification Service] WHATSAPP_NOTIFICATION_FAILED recipient=${data.recipientId} ` +
        `kind=INTERNAL_ERROR :: ${err.message}`
    );
    return {
      attempted: true,
      delivered: false,
      failureKind: 'INTERNAL_ERROR',
      error: err.message,
      retryable: true,
    };
  }
};

/** Await delivery, but never let it hold the HTTP response open indefinitely. */
const deliverWithDeadline = async (data: {
  recipientId: string;
  title: string;
  message: string;
}): Promise<WhatsAppDeliveryResult> => {
  const deadline = deliveryDeadlineMs();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<WhatsAppDeliveryResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          attempted: true,
          delivered: false,
          failureKind: 'TIMEOUT',
          error: `WhatsApp delivery did not complete within ${deadline}ms; still in flight`,
          retryable: true,
        }),
      deadline
    );
  });

  try {
    // The underlying send keeps running past the deadline and logs its own
    // outcome; the caller just stops waiting for it.
    return await Promise.race([deliverWhatsApp(data), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Correlate the delivery outcome with the notification row in the logs. This is
 * the only place the outcome is reported to anyone — it is deliberately not
 * returned to the HTTP caller (see WhatsAppDeliveryResult).
 *
 * Distinct token from `deliverWhatsApp`'s own WHATSAPP_NOTIFICATION_FAILED,
 * which stays as the authoritative send-level log: that one still fires when a
 * send fails AFTER the deadline, at which point this function has already run
 * and reported TIMEOUT. Two different facts, so two different tokens.
 */
const logDeliveryOutcome = (
  notificationId: string,
  recipientId: string,
  result: WhatsAppDeliveryResult
): void => {
  const prefix = `[Notification Service] notification=${notificationId} recipient=${recipientId}`;

  if (result.delivered) {
    logger.info(
      `${prefix} WHATSAPP_NOTIFICATION_DELIVERED channel=${result.channel ?? '-'} ` +
        `messageId=${result.messageId ?? '-'}`
    );
    return;
  }

  if (!result.attempted) {
    // Expected for students and mentors, who have no phone column today.
    logger.info(`${prefix} WHATSAPP_NOTIFICATION_SKIPPED kind=${result.failureKind ?? '-'} — in-app only`);
    return;
  }

  logger.error(
    `${prefix} WHATSAPP_NOTIFICATION_UNDELIVERED kind=${result.failureKind ?? '-'} ` +
      `retryable=${!!result.retryable} :: ${result.error ?? 'no detail'}`
  );
};

export const notificationService = {
  /**
   * Create the in-app notification and dispatch the WhatsApp copy.
   *
   * Returns the notification row and NOTHING about WhatsApp delivery: the
   * endpoint accepts an arbitrary recipientId, so the delivery outcome is
   * attacker-controlled reconnaissance about a third party rather than
   * information the caller is entitled to. Failures are loud in the logs.
   */
  async createNotification(data: { recipientId: string; title: string; message: string; priority: string }) {
    const notification = await db.notification.create({
      data: {
        recipientId: data.recipientId,
        title: data.title,
        message: data.message,
        priority: data.priority || 'LOW',
      },
    });

    if (isAsyncMode()) {
      void deliverWhatsApp(data)
        .then((result) => logDeliveryOutcome(notification.id, data.recipientId, result))
        .catch((err: any) =>
          logger.error(
            `[Notification Service] notification=${notification.id} recipient=${data.recipientId} ` +
              `WHATSAPP_NOTIFICATION_FAILED (async) :: ${err.message}`
          )
        );
      return notification;
    }

    // Still awaited: the send must finish (or hit its deadline) before the
    // response, so failures are logged in-band and a slow Meta call cannot
    // outlive the request unnoticed. The outcome informs the LOGS, not the body.
    const delivery = await deliverWithDeadline(data);
    logDeliveryOutcome(notification.id, data.recipientId, delivery);

    return notification;
  },

  async getNotifications(recipientId: string) {
    return db.notification.findMany({
      where: { recipientId },
      orderBy: { createdAt: 'desc' },
    });
  },

  async getAllNotifications() {
    return db.notification.findMany({
      orderBy: { createdAt: 'desc' },
    });
  },

  async markAsRead(id: string, recipientId: string, isAdmin: boolean = false) {
    return db.notification.updateMany({
      where: isAdmin ? { id } : { id, recipientId },
      data: { read: true },
    });
  },

  async markAllAsRead(recipientId: string, isAdmin: boolean = false) {
    return db.notification.updateMany({
      where: isAdmin ? { read: false } : { recipientId, read: false },
      data: { read: true },
    });
  },
};
