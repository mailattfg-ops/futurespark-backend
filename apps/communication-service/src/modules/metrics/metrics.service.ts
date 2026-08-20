import db from '../../database/datasource';

const DAY_MS = 24 * 60 * 60 * 1000;

const CACHE_TTL_MS = 60_000;
const cache = new Map<number, { at: number; data: any }>();

/**
 * The system-health dashboard offers exactly two windows; anything else in the
 * query string (missing, garbage, "365") falls back to 7 rather than erroring,
 * so a hand-typed URL still renders a page.
 */
export const clampWindowDays = (raw: unknown): number => (Number(raw) === 30 ? 30 : 7);

/**
 * Failed sends store their classification as a "[KIND] ..." prefix on the
 * free-text error column (see whatsapp.service.ts — a real errorCode column
 * would need a migration). Rows written before that convention, or truncated
 * oddly, bucket as OTHER instead of being dropped from the histogram.
 */
const FAILURE_KIND_PREFIX = /^\[([A-Z][A-Z0-9_]*)\]/;

const parseFailureKind = (error: string | null): string => {
  const match = error ? FAILURE_KIND_PREFIX.exec(error) : null;
  return match ? match[1] : 'OTHER';
};

/**
 * GET /metrics/whatsapp — delivery health over the last N days.
 *
 * The status column always holds the LATEST state Meta reported (webhooks
 * overwrite sent -> delivered -> read), so a single groupBy on status is the
 * whole funnel; no row ever counts twice.
 */
export async function getWhatsAppMetrics(windowDays: number, refresh = false) {
  // Held for a minute: connection_limit=1 makes these queries queue rather
  // than overlap, and the dashboard polls on a timer.
  const hit = cache.get(windowDays);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const since = new Date(Date.now() - windowDays * DAY_MS);

  const [statusRows, inboundTotal, failedErrorRows, recentSends] = await Promise.all([
    db.whatsAppMessage.groupBy({
      by: ['status'],
      where: { direction: 'OUTBOUND', createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.whatsAppMessage.count({
      where: { direction: 'INBOUND', createdAt: { gte: since } },
    }),
    // groupBy on the error column rather than fetching full failed rows. Each
    // stored error embeds a per-call fbtrace id, so this is effectively one
    // (error, count) pair per failed send in the window — bounded by the
    // window's failure count, and only the error text crosses the wire.
    db.whatsAppMessage.groupBy({
      by: ['error'],
      where: { direction: 'OUTBOUND', status: 'failed', createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.whatsAppMessage.findMany({
      where: { direction: 'OUTBOUND', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        to: true,
        classId: true,
        type: true,
        status: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  const byStatus: Record<string, number> = {};
  let outboundTotal = 0;
  for (const row of statusRows) {
    byStatus[row.status] = row._count._all;
    outboundTotal += row._count._all;
  }

  const kindCounts = new Map<string, number>();
  for (const row of failedErrorRows) {
    const kind = parseFailureKind(row.error);
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + row._count._all);
  }
  const failureKinds = Array.from(kindCounts, ([kind, count]) => ({ kind, count })).sort(
    (a, b) => b.count - a.count
  );

  const payload = {
    windowDays,
    outbound: {
      total: outboundTotal,
      // These zeros are measured, not defaulted: groupBy simply returns no row
      // for a status that never occurred in the window.
      sent: byStatus['sent'] ?? 0,
      delivered: byStatus['delivered'] ?? 0,
      read: byStatus['read'] ?? 0,
      failed: byStatus['failed'] ?? 0,
      pending: byStatus['pending'] ?? 0,
    },
    inbound: { total: inboundTotal },
    failureKinds,
    recentSends,
  };

  cache.set(windowDays, { at: Date.now(), data: payload });
  return payload;
}

/**
 * GET /metrics/whatsapp/class/:classId — every report send attempted for one
 * class, newest first. Not windowed: when an operator drills into a class they
 * want its full send history, however old, and the classId index plus take: 20
 * keep that cheap.
 */
export async function getClassSends(classId: string) {
  const sends = await db.whatsAppMessage.findMany({
    where: { direction: 'OUTBOUND', classId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      to: true,
      status: true,
      type: true,
      error: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return { classId, sends };
}
