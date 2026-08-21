import { db } from '../../database/datasource';

/**
 * Recent events from this service, for the Technical Dashboard.
 *
 * One shape for every kind of thing that happens, so the gateway can merge
 * three services into a single time-ordered feed without knowing what any of
 * them mean. `at` is the moment the event HAPPENED, not when the row was last
 * written — a feed sorted by updatedAt reorders itself whenever anything is
 * touched, which makes it useless for answering "what happened at 3pm".
 */
export interface FeedEvent {
  type: 'session' | 'lead' | 'report' | 'summary' | 'whatsapp' | 'notification' | 'video' | 'audio';
  at: string;
  title: string;
  subtitle?: string | null;
  /** Rendered as a chip: ok | warn | fail | info. */
  status?: 'ok' | 'warn' | 'fail' | 'info';
  detail?: string | null;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

const name = (first?: string | null, last?: string | null): string =>
  [first, last].filter(Boolean).join(' ').trim();

/**
 * @param since  Only events at or after this moment. Null means no lower bound.
 * @param limit  Per event type, before the gateway merges and re-slices.
 */
export const getAuthFeed = async (since: Date | null, limit: number): Promise<FeedEvent[]> => {
  const events: FeedEvent[] = [];
  const window = since ? { gte: since } : undefined;

  const [classes, leads, reports, summaries] = await Promise.all([
    // SESSIONS — by when the class was scheduled to run.
    db.scheduledClass.findMany({
      where: window ? { startTime: window } : {},
      orderBy: { startTime: 'desc' },
      take: limit,
      select: {
        id: true, startTime: true, status: true, classType: true,
        student: { select: { firstName: true, lastName: true } },
        mentor: { select: { firstName: true, lastName: true } },
      },
    }),

    // LEADS — by when the enquiry arrived.
    db.lead.findMany({
      where: window ? { createdAt: window } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, createdAt: true, status: true, source: true,
        firstName: true, lastName: true, studentFirstName: true, studentLastName: true,
      },
    }),

    // REPORTS — by when the parent actually received one.
    db.scheduledClass.findMany({
      where: { reportSentAt: since ? window : { not: null } },
      orderBy: { reportSentAt: 'desc' },
      take: limit,
      select: {
        id: true, reportSentAt: true, reportSentTo: true, reportAttempts: true,
        student: { select: { firstName: true, lastName: true } },
      },
    }),

    // SUMMARIES — the pipeline logs one as it finishes, which is the only
    // record of WHEN a summary landed; ScheduledClass has no such column.
    db.auditLog.findMany({
      where: { entityType: 'ai-summary', ...(since ? { occurredAt: window } : {}) },
      orderBy: { occurredAt: 'desc' },
      take: limit,
      select: { occurredAt: true, entityName: true, summary: true, action: true, entityId: true },
    }),
  ]);

  for (const c of classes) {
    const at = iso(c.startTime);
    if (!at) continue;
    events.push({
      type: 'session',
      at,
      title: name(c.student?.firstName, c.student?.lastName) || 'Class',
      subtitle: `${c.classType === 'DEMO' ? 'Demo' : 'Class'} with ${name(c.mentor?.firstName, c.mentor?.lastName) || 'a mentor'}`,
      status: c.status === 'COMPLETED' ? 'ok' : c.status === 'CANCELLED' ? 'fail' : 'info',
      detail: c.status,
    });
  }

  for (const l of leads) {
    const at = iso(l.createdAt);
    if (!at) continue;
    const child = name(l.studentFirstName, l.studentLastName);
    events.push({
      type: 'lead',
      at,
      title: child || name(l.firstName, l.lastName) || 'New lead',
      subtitle: `via ${l.source || 'unknown source'}`,
      status: l.status === 'ENROLLED' ? 'ok' : l.status === 'LOST' ? 'fail' : 'info',
      detail: String(l.status),
    });
  }

  for (const r of reports) {
    const at = iso(r.reportSentAt);
    if (!at) continue;
    events.push({
      type: 'report',
      at,
      title: name(r.student?.firstName, r.student?.lastName) || 'Report',
      subtitle: r.reportSentTo ? `sent to ${r.reportSentTo}` : 'sent (number not recorded)',
      status: 'ok',
      detail: r.reportAttempts > 1 ? `after ${r.reportAttempts} attempts` : null,
    });
  }

  /* Classes that HAVE a summary but no audit line — anything summarised
   * before the pipeline started logging the event. */
  const loggedClassIds = new Set(summaries.map((e) => e.entityId).filter(Boolean) as string[]);
  const legacySummaries = await db.scheduledClass.findMany({
    where: {
      classSummary: { not: null },
      ...(since ? { updatedAt: { gte: since } } : {}),
      ...(loggedClassIds.size > 0 ? { id: { notIn: [...loggedClassIds] } } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true, updatedAt: true,
      student: { select: { firstName: true, lastName: true } },
    },
  });

  for (const c of legacySummaries) {
    events.push({
      type: 'summary',
      at: c.updatedAt.toISOString(),
      title: name(c.student?.firstName, c.student?.lastName) || 'Class summary',
      // Said plainly: this is when the row was last written, not when the
      // model finished. Every summary from here on carries an exact time.
      subtitle: 'summary on file · time approximate',
      status: 'ok',
      detail: null,
    });
  }

  for (const sEvent of summaries) {
    const at = iso(sEvent.occurredAt);
    if (!at) continue;
    // The pipeline writes a second, distinct line when a report is held.
    const held = /HELD/i.test(sEvent.summary);
    events.push({
      type: 'summary',
      at,
      title: sEvent.entityName || 'Class summary',
      subtitle: held ? 'held for review' : 'summary generated',
      status: held ? 'warn' : 'ok',
      detail: null,
    });
  }

  return events;
};
