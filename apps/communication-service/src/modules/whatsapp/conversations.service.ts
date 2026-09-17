import db from '../../database/datasource';
import { logger } from '@futurespark/logger';
import { whatsappService, isWhatsAppConfigured, getAudienceSettings } from './whatsapp.service';

/**
 * The conversational inbox, built from the WhatsAppMessage rows the webhook
 * and the sender already write. There is no second store: a thread is simply
 * every message exchanged with one phone number.
 *
 * Outbound rows carry the customer in `to` and 'SYSTEM' (or the business
 * number) in `from`; inbound rows are the reverse. `counterpart` is whichever
 * end is not us, and that is what threads are keyed by.
 */

/** Digits only, so "+91 98765 43210" and "919876543210" are one thread. */
export const normalisePhone = (value: string): string => (value || '').replace(/\D/g, '');

const OURS = new Set(['system', '']);

/** The customer side of a row, whichever direction it went. */
export const counterpartOf = (row: { from: string; to: string; direction: string }): string =>
  normalisePhone(row.direction === 'INBOUND' ? row.from : row.to);

const isOurs = (value: string): boolean => OURS.has((value || '').trim().toLowerCase());

export interface ChatMessageDto {
  id: string;
  messageId: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  type: string;
  body: string;
  status: string;
  error: string | null;
  at: string;
  /** Relative URL the admin app can play or download, when media was stored. */
  mediaUrl: string | null;
  mediaMime: string | null;
}

export interface ThreadDto {
  phone: string;
  /** Present when the caller asked for them — the whole thread, oldest first. */
  messages?: ChatMessageDto[];
  lastMessage: string;
  lastAt: string;
  lastDirection: 'INBOUND' | 'OUTBOUND';
  messageCount: number;
  hasMedia: boolean;
  /** Free-form replies are only allowed while this is true (Meta's 24h rule). */
  windowOpen: boolean;
  windowClosesAt: string | null;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

const toDto = (row: any): ChatMessageDto => ({
  id: row.id,
  messageId: row.messageId,
  direction: row.direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND',
  type: row.type,
  body: row.body,
  status: row.status,
  error: row.error ?? null,
  at: row.createdAt.toISOString(),
  mediaUrl: row.mediaFile ? `/api/whatsapp/media/${row.mediaFile}` : null,
  mediaMime: row.mediaMime ?? null,
});

/**
 * Every thread, most recently active first.
 *
 * Grouped in memory rather than SQL because the thread key is a computed
 * column (whichever end is not us) and the volume is a few thousand rows.
 */
export const listThreads = async (limit = 200, withMessages = false): Promise<ThreadDto[]> => {
  const rows = await db.whatsAppMessage.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 2000) * 10,
  });

  // Filled alongside the grouping when the caller wants whole threads, so the
  // inbox loads in one request instead of one per conversation.
  const messagesByPhone = new Map<string, ChatMessageDto[]>();

  const byPhone = new Map<string, ThreadDto & { lastInboundAt: Date | null }>();
  for (const row of rows) {
    const phone = counterpartOf(row);
    if (!phone || isOurs(phone)) continue;

    let thread = byPhone.get(phone);
    if (!thread) {
      // Rows arrive newest-first, so the first one seen IS the last message.
      thread = {
        phone,
        lastMessage: row.body,
        lastAt: row.createdAt.toISOString(),
        lastDirection: row.direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND',
        messageCount: 0,
        hasMedia: false,
        windowOpen: false,
        windowClosesAt: null,
        lastInboundAt: null,
      };
      byPhone.set(phone, thread);
    }
    thread.messageCount++;
    if (row.mediaFile) thread.hasMedia = true;
    if (withMessages) {
      const bucket = messagesByPhone.get(phone) ?? [];
      bucket.push(toDto(row));
      messagesByPhone.set(phone, bucket);
    }
    if (row.direction === 'INBOUND' && !thread.lastInboundAt) thread.lastInboundAt = row.createdAt;
  }

  const now = Date.now();
  return [...byPhone.values()]
    .map(({ lastInboundAt, ...thread }) => {
      const closesAt = lastInboundAt ? new Date(lastInboundAt.getTime() + WINDOW_MS) : null;
      return {
        ...thread,
        windowOpen: !!closesAt && closesAt.getTime() > now,
        windowClosesAt: closesAt ? closesAt.toISOString() : null,
        // Collected newest-first with the grouping pass; a chat reads the other way.
        ...(withMessages ? { messages: (messagesByPhone.get(thread.phone) ?? []).slice().reverse() } : {}),
      };
    })
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
    .slice(0, limit);
};

/** One thread's messages, oldest first — the order a chat panel renders. */
export const listMessages = async (phone: string, limit = 200): Promise<ChatMessageDto[]> => {
  const digits = normalisePhone(phone);
  if (!digits) return [];

  const rows = await db.whatsAppMessage.findMany({
    where: { OR: [{ from: { contains: digits } }, { to: { contains: digits } }] },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 1000),
  });

  return rows
    .filter((row) => counterpartOf(row) === digits)
    .reverse()
    .map(toDto);
};

export type ReplyOutcome =
  | { sent: true; messageId?: string }
  | { sent: false; reason: 'WINDOW_CLOSED' | 'DISABLED' | 'SEND_FAILED'; message: string };

/**
 * Reply to a family in their own thread.
 *
 * Free-form text is only legal inside Meta's 24-hour customer service window,
 * which the last inbound message opens. Outside it Meta rejects the send with
 * 131047, so this refuses up front with something an operator can act on
 * rather than letting it fail in the provider.
 */
export const replyToThread = async (phone: string, text: string): Promise<ReplyOutcome> => {
  const digits = normalisePhone(phone);
  const body = (text || '').trim();
  if (!digits) return { sent: false, reason: 'SEND_FAILED', message: 'A phone number is required.' };
  if (!body) return { sent: false, reason: 'SEND_FAILED', message: 'The reply is empty.' };

  const audience = getAudienceSettings();
  if (!audience.regularParents && !audience.pilotProgramLeads && !audience.leadsManagement) {
    return {
      sent: false,
      reason: 'DISABLED',
      message: 'Outbound WhatsApp is switched off for every audience in Notification Settings.',
    };
  }
  if (!isWhatsAppConfigured()) {
    return { sent: false, reason: 'DISABLED', message: 'WhatsApp is not configured on this server.' };
  }

  const open = await whatsappService.isWithinCustomerServiceWindow(digits);
  if (!open) {
    return {
      sent: false,
      reason: 'WINDOW_CLOSED',
      message:
        'The 24-hour reply window has closed. WhatsApp only allows an approved template until they message again.',
    };
  }

  const result = await whatsappService.sendTextMessage(digits, body);
  if (!result.success) {
    logger.warn(`[WhatsApp Inbox] Reply to ${digits.slice(-4).padStart(digits.length, '*')} failed: ${result.error}`);
    return { sent: false, reason: 'SEND_FAILED', message: result.error || 'WhatsApp refused the message.' };
  }
  return { sent: true, messageId: result.messageId };
};
