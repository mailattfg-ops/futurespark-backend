import db from '../../database/datasource';

/** Same shape every service emits — see auth-service/modules/metrics/feed.service.ts. */
export interface FeedEvent {
  type: 'whatsapp' | 'notification';
  at: string;
  title: string;
  subtitle?: string | null;
  status?: 'ok' | 'warn' | 'fail' | 'info';
  detail?: string | null;
}

/** Meta's status chain, mapped onto the feed's four states. */
const statusOf = (s: string): FeedEvent['status'] => {
  const v = (s || '').toLowerCase();
  if (v === 'delivered' || v === 'read') return 'ok';
  if (v === 'failed') return 'fail';
  if (v === 'pending') return 'warn';
  return 'info';
};

/** The machine-greppable "[KIND] ..." prefix the sender writes on failures. */
const failureKind = (error: string | null): string | null => {
  const m = error ? /^\[([A-Z][A-Z0-9_]*)\]/.exec(error) : null;
  return m ? m[1] : null;
};

export const getCommFeed = async (since: Date | null, limit: number): Promise<FeedEvent[]> => {
  const window = since ? { gte: since } : undefined;
  const events: FeedEvent[] = [];

  const [messages, notifications] = await Promise.all([
    db.whatsAppMessage.findMany({
      where: window ? { createdAt: window } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { createdAt: true, to: true, from: true, direction: true, type: true, status: true, error: true },
    }),
    // The nearest thing this platform has to mail: there is no SMTP, SES or
    // nodemailer anywhere in the codebase, so an "email" row would be invented.
    db.notification.findMany({
      where: window ? { createdAt: window } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { createdAt: true, title: true, message: true, priority: true, read: true },
    }),
  ]);

  for (const m of messages) {
    const inbound = m.direction === 'INBOUND';
    events.push({
      type: 'whatsapp',
      at: m.createdAt.toISOString(),
      title: inbound ? `Message from ${m.from}` : m.to,
      subtitle: inbound ? 'inbound' : `${m.type} · ${m.status}`,
      status: inbound ? 'info' : statusOf(m.status),
      detail: failureKind(m.error),
    });
  }

  for (const n of notifications) {
    events.push({
      type: 'notification',
      at: n.createdAt.toISOString(),
      title: n.title,
      subtitle: n.message?.slice(0, 90) ?? null,
      status: n.priority === 'HIGH' ? 'warn' : 'info',
      detail: n.read ? 'read' : 'unread',
    });
  }

  return events;
};
