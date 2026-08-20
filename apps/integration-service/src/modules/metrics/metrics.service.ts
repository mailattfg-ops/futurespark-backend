import { db, withDbRetry } from '../../database/datasource';
import { logger } from '@futurespark/logger';
import {
  callZoom,
  getZoomApiUsage,
  isZoomConfigured,
  isZoomEnabled,
  zoomConfig,
  ZoomApiError,
  ZoomAuthService,
} from '../zoom/auth/auth.service';
import { getActiveHostPool } from '../zoom/hosts/hosts.service';

/* ══════════════════════════════════════════════════════════════════════════
 * SYSTEM HEALTH METRICS
 *
 * Read-only aggregates for the admin System Health page. Everything here is
 * counts/sums/groupBys — the single row fetch is the arrival-lag sample, and
 * it is select-limited and capped so a pathological window can never pull the
 * recordings table into memory.
 *
 * A value that could not be measured is `null`, never 0 — a real 0 has to
 * mean "measured, and it was zero".
 * ═══════════════════════════════════════════════════════════════════════ */

/** The dashboard offers exactly two windows; anything else collapses to 7. */
export const clampDays = (raw: unknown): number => (Number(raw) === 30 ? 30 : 7);

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Median over an ALREADY sorted ascending list; null when the list is empty. */
const medianOf = (sorted: number[]): number | null => {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Same knob transcription-retry.ts gives up at, read lazily for the same
// reason zoomConfig is: this module can be imported before dotenv runs.
const transcriptionMaxAttempts = (): number => Number(process.env.TRANSCRIPTION_MAX_ATTEMPTS ?? 8);

/* ── GET /metrics/recordings ────────────────────────────────────────────── */

/** Held for a minute — connection_limit=1 makes these queries queue, and the
 *  dashboard polls on a timer. (Zoom has its own, much longer, cache below.) */
const RECORDINGS_TTL_MS = 60_000;
const recordingsCache = new Map<number, { at: number; data: any }>();

export async function getRecordingsMetrics(days: number, refresh = false) {
  const hit = recordingsCache.get(days);
  if (!refresh && hit && Date.now() - hit.at < RECORDINGS_TTL_MS) return hit.data;

  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const inWindow = { createdAt: { gte: since } };

  const [
    found,
    foundMeet,
    foundZoom,
    downloaded,
    transcribed,
    failed,
    durationSum,
    retried,
    exhausted,
    waitingRetry,
    meetingGroups,
    arrivalRows,
  ] = await Promise.all([
    withDbRetry(() => db.meetingRecording.count({ where: inWindow })),
    // `provider` lives on the meeting, so groupBy cannot reach it from the
    // recording side — two relation-filtered counts instead of a join.
    withDbRetry(() => db.meetingRecording.count({ where: { ...inWindow, meeting: { provider: 'GOOGLE_MEET' } } })),
    withDbRetry(() => db.meetingRecording.count({ where: { ...inWindow, meeting: { provider: 'ZOOM' } } })),
    withDbRetry(() => db.meetingRecording.count({ where: { ...inWindow, downloadStatus: 'COMPLETED' } })),
    withDbRetry(() => db.meetingRecording.count({ where: { ...inWindow, transcriptionStatus: 'COMPLETED' } })),
    withDbRetry(() => db.meetingRecording.count({ where: { ...inWindow, transcriptionStatus: 'FAILED' } })),
    withDbRetry(() => db.meetingRecording.aggregate({ where: inWindow, _sum: { duration: true } })),
    withDbRetry(() => db.meetingRecording.count({ where: { ...inWindow, transcriptionAttempts: { gt: 1 } } })),
    // Deliberately NOT windowed: an exhausted recording stays somebody's
    // problem until it is dealt with, however old it is. Same for the retry
    // queue — `retryAt > now` is a statement about the future, not the window.
    withDbRetry(() => db.meetingRecording.count({ where: { transcriptionAttempts: { gte: transcriptionMaxAttempts() } } })),
    withDbRetry(() => db.meetingRecording.count({ where: { transcriptionRetryAt: { gt: now } } })),
    withDbRetry(() =>
      db.meeting.groupBy({ by: ['provider'], where: { startTime: { gte: since } }, _count: { _all: true } })
    ),
    // The one row fetch: arrival lag needs per-row date math. Two timestamps
    // plus the title for the "slowest" list, newest first so the 5000 cap
    // drops the oldest rows if it ever bites.
    withDbRetry(() =>
      db.meetingRecording.findMany({
        where: { ...inWindow, meeting: { classCompletedAt: { not: null } } },
        select: { createdAt: true, meeting: { select: { classCompletedAt: true, title: true } } },
        orderBy: { createdAt: 'desc' },
        take: 5000,
      })
    ),
  ]);

  // Sign-off -> recording-appears lag. Negative means the recording pre-dates
  // the completion stamp (a re-link or manual upload); >48h means the stamp
  // belongs to a different run of the same meeting. Either would poison the
  // average, so both are dropped rather than clamped.
  const arrivals: { title: string; minutes: number; at: Date }[] = [];
  for (const row of arrivalRows) {
    const completedAt = row.meeting.classCompletedAt;
    if (!completedAt) continue;
    const diffMs = row.createdAt.getTime() - completedAt.getTime();
    if (diffMs <= 0 || diffMs >= 48 * 60 * 60 * 1000) continue;
    arrivals.push({ title: row.meeting.title, minutes: diffMs / 60_000, at: row.createdAt });
  }
  const arrivalMinutes = arrivals.map((a) => a.minutes).sort((a, b) => a - b);
  const arrivalAvg =
    arrivals.length > 0 ? arrivals.reduce((sum, a) => sum + a.minutes, 0) / arrivals.length : null;
  const arrivalMedian = medianOf(arrivalMinutes);

  const meetingsByProvider: Record<string, number> = {};
  let meetingsTotal = 0;
  for (const group of meetingGroups) {
    meetingsByProvider[group.provider] = group._count._all;
    meetingsTotal += group._count._all;
  }

  const payload = {
    windowDays: days,
    recordings: {
      found,
      byProvider: { GOOGLE_MEET: foundMeet, ZOOM: foundZoom },
      downloaded,
      transcribed,
      failed,
      // `_sum` is null when no row in the window has a duration — that is
      // "unknown", not 0 minutes of video.
      totalMinutes: durationSum._sum.duration === null ? null : round1(durationSum._sum.duration / 60),
    },
    videoArrival: {
      avgMinutes: arrivalAvg === null ? null : round1(arrivalAvg),
      medianMinutes: arrivalMedian === null ? null : round1(arrivalMedian),
      count: arrivals.length,
      slowest: [...arrivals]
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, 5)
        .map((a) => ({ title: a.title, minutes: round1(a.minutes), at: a.at.toISOString() })),
    },
    retryPressure: {
      retried,
      exhausted,
      waitingRetry,
    },
    meetings: { total: meetingsTotal, byProvider: meetingsByProvider },
  };

  recordingsCache.set(days, { at: Date.now(), data: payload });
  return payload;
}

/* ── GET /metrics/zoom ──────────────────────────────────────────────────── */

/**
 * The users probe hits Zoom's API, which is throttled through the shared
 * doorway — an hour of cache keeps a dashboard someone leaves open from
 * eating the same budget bookings need. `?refresh=true` bypasses.
 */
let zoomMetricsCache: { at: number; data: Awaited<ReturnType<typeof buildZoomMetrics>> } | null = null;
const ZOOM_METRICS_TTL_MS = 60 * 60 * 1000;

export async function getZoomMetrics(refresh: boolean) {
  if (!refresh && zoomMetricsCache && Date.now() - zoomMetricsCache.at < ZOOM_METRICS_TTL_MS) {
    return zoomMetricsCache.data;
  }
  const data = await buildZoomMetrics();
  zoomMetricsCache = { at: Date.now(), data };
  return data;
}

/**
 * Zoom's missing-scope answer, as distinct from "Zoom is down": code 4711
 * (or the older 104), or any message that talks about scopes. Worth naming
 * because the fix is a marketplace setting, not a code change.
 */
const isMissingScopeError = (err: unknown): boolean => {
  if (err instanceof ZoomApiError && (Number(err.zoomCode) === 4711 || Number(err.zoomCode) === 104)) return true;
  return /scope/i.test(err instanceof Error ? err.message : String(err));
};

async function buildZoomMetrics() {
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  // The local-DB half works whether or not Zoom itself answers.
  const [recordingsCount, recordingsDuration] = await Promise.all([
    withDbRetry(() =>
      db.meetingRecording.count({ where: { createdAt: { gte: monthStart }, meeting: { provider: 'ZOOM' } } })
    ),
    withDbRetry(() =>
      db.meetingRecording.aggregate({
        where: { createdAt: { gte: monthStart }, meeting: { provider: 'ZOOM' } },
        _sum: { duration: true },
      })
    ),
  ]);

  const payload: Record<string, unknown> = {
    enabled: isZoomEnabled(),
    configured: isZoomConfigured(),
    // The seat register is what the allocator actually books on, so report it
    // rather than ZOOM_HOST_EMAILS — otherwise this page and System → Zoom
    // Hosts would disagree the moment a seat is added in the UI.
    configuredHosts: await getActiveHostPool(),
    // null = not measured. They stay null when Zoom is disabled, because no
    // call was made and pretending to know would be a lie.
    reachable: null as boolean | null,
    scopeMissing: null as boolean | null,
    users: null as { total: number; licensed: number; basic: number } | null,
    cloudRecordingsThisMonth: {
      count: recordingsCount,
      minutes: recordingsDuration._sum.duration === null ? null : round1(recordingsDuration._sum.duration / 60),
    },
    apiUsage: getZoomApiUsage(),
  };

  if (!isZoomEnabled()) return payload;

  try {
    // 300 covers every plausible seat count in one page; a second page would
    // only skew licensed/basic, and total_records still reports the truth.
    const bearer = await ZoomAuthService.getServerToServerToken();
    const { data } = await callZoom<any>(
      { operation: 'get' },
      { method: 'GET', url: 'https://api.zoom.us/v2/users?page_size=300', bearer }
    );

    const users: any[] = Array.isArray(data?.users) ? data.users : [];
    let licensed = 0;
    let basic = 0;
    for (const user of users) {
      if (user?.type === 2) licensed += 1;
      else if (user?.type === 1) basic += 1;
      // any other type (on-prem etc.) counts only toward the total
    }

    payload.reachable = true;
    payload.scopeMissing = false;
    payload.users = {
      total: typeof data?.total_records === 'number' ? data.total_records : users.length,
      licensed,
      basic,
    };
  } catch (err: any) {
    // A dead Zoom must never take the health page down with it — the page is
    // exactly where an operator goes to find out Zoom is dead.
    payload.reachable = false;
    payload.error = err?.message ?? String(err);
    payload.scopeMissing = isMissingScopeError(err);
    if (payload.scopeMissing) {
      // Zoom's granular-scope error names the exact scope it wants — surface
      // that verbatim so the operator adds the right one on the first try
      // (measured live: listing users needs user:read:list_users:admin).
      const named = /scopes:\[([^\]]+)\]/.exec(String(payload.error ?? ''))?.[1];
      payload.scopeMessage =
        `Grant the ${named ?? 'user:read:list_users:admin (Users → List users)'} scope to the ` +
        'Server-to-Server app in the Zoom marketplace. The next token refresh (within the hour, ' +
        'or on service restart) picks it up — no code change needed.';
    }
    logger.warn(`[Metrics] Zoom users probe failed: ${payload.error}`);
  }

  // Re-snapshot AFTER the probe so the counters include the call just made.
  payload.apiUsage = getZoomApiUsage();
  return payload;
}
