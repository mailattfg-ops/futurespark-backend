import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { successResponse } from '@futurespark/response';
import { asyncHandler } from '@futurespark/middleware';
import { logger } from '@futurespark/logger';
import { HTTP_STATUS } from '@futurespark/constants';

/**
 * GET /api/system-health — one merged payload for the admin's System Health page.
 *
 * The gateway is the only box that can reach every service, so it fans out to
 * each service's /metrics endpoint plus a /health ping and serves the results
 * as a single document. Everything downstream runs through Promise.allSettled
 * with a per-fetch AbortController timeout: a down service degrades its own
 * section to { down: true } but must NEVER fail the endpoint — the page
 * renders what it has.
 *
 * ADMIN-only (same gate as /api/logs): the payload carries student names,
 * parent phone numbers and provider errors.
 */

// Same targets the proxies in app.ts use. Analytics has no proxy route yet,
// but it does answer /health, so the pings cover it as the 7th service.
const AUTH_SERVICE_URL  = process.env.AUTH_SERVICE_URL  || 'http://127.0.0.1:3001';
const LEARN_SERVICE_URL = process.env.LEARN_SERVICE_URL || 'http://127.0.0.1:3002';
const PAY_SERVICE_URL   = process.env.PAY_SERVICE_URL   || 'http://127.0.0.1:3004';
const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://127.0.0.1:3003';
const INTEGRATION_SERVICE_URL = process.env.INTEGRATION_SERVICE_URL || 'http://127.0.0.1:3006';
const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL || 'http://127.0.0.1:3005';

// Metrics endpoints aggregate in the DB, so they get room; /health answers
// instantly or the service is down, so it gets cut off early.
//
// 25s, not 8s: the database URLs pin connection_limit=1, so a service's dozen
// aggregate queries run as a dozen sequential round trips to a hosted Postgres
// — measured at ~15s cold for auth. Each service caches its own answer, so
// this ceiling is only ever reached on a cold first load.
const METRICS_TIMEOUT_MS = 25_000;
const PING_TIMEOUT_MS = 3_000;
const CACHE_TTL_SECONDS = 30;

/** GET a downstream JSON endpoint and unwrap the successResponse envelope. */
const fetchJson = async (url: string, headers: Record<string, string>, timeoutMs: number): Promise<any> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const body = (await response.json()) as any;
    return body?.data ?? body;
  } finally {
    clearTimeout(timer);
  }
};

interface ServicePing {
  up: boolean;
  uptimeSeconds: number | null;
  latencyMs: number | null;
}

/** /health probe — never throws, so the pings can share a plain Promise.all. */
const ping = async (baseUrl: string): Promise<ServicePing> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (!response.ok) return { up: false, uptimeSeconds: null, latencyMs };
    let uptimeSeconds: number | null = null;
    try {
      const body = (await response.json()) as any;
      if (typeof body?.data?.uptime === 'number') uptimeSeconds = body.data.uptime;
    } catch {
      /* a non-JSON 200 still counts as up */
    }
    return { up: true, uptimeSeconds, latencyMs };
  } catch {
    return { up: false, uptimeSeconds: null, latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
};

/* ── Log-error counting ─────────────────────────────────────────────────────
 * Same file layout and line grammar as routes/logs.ts: one rotating plain-text
 * file per service under <repo-root>/logs/, lines of the form
 * `[timestamp] [level]: message`. Here we only need a COUNT of error-level
 * lines in the last 24h, so continuation lines (stack traces) are simply
 * skipped — they belong to an entry that was already counted.
 * ────────────────────────────────────────────────────────────────────────── */

const LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[.:](\d{1,4})\] \[(\w+)\]:? ?(.*)$/;

/** How much of each file's tail to read. 400 KB ≈ several thousand lines. */
const TAIL_BYTES = 400 * 1024;
/** …of which only the newest lines are parsed — a bound on CPU, not bytes. */
const TAIL_LINES = 2500;

const readTail = (filePath: string): string => {
  const size = fs.statSync(filePath).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // Drop the first line when we started mid-file — it is almost surely cut.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
};

const countLogErrors = (sinceMs: number): Record<string, number> => {
  const byService: Record<string, number> = {};
  const logDir = path.resolve(__dirname, '../../../../logs');
  if (!fs.existsSync(logDir)) return byService;

  // <service>.log plus winston's rotated <service>1.log generation — both
  // aggregate under the same service key, exactly like /api/logs groups them.
  for (const file of fs.readdirSync(logDir).filter((f) => f.endsWith('.log'))) {
    const service = file.replace(/\d*\.log$/, '');
    byService[service] = byService[service] ?? 0;
    try {
      const lines = readTail(path.join(logDir, file)).split('\n').slice(-TAIL_LINES);
      for (const raw of lines) {
        const match = raw.match(LINE_RE);
        if (!match) continue;
        const [, ts, ms, level] = match;
        if (level.toLowerCase() !== 'error') continue;
        // The logger stamps local time; Date parses the T-form as local too.
        const at = new Date(`${ts.replace(' ', 'T')}.${ms.padEnd(3, '0').slice(0, 3)}`).getTime();
        if (at >= sinceMs) byService[service] += 1;
      }
    } catch {
      /* a rotating file can vanish mid-read; skip it */
    }
  }
  return byService;
};

/* ── The endpoint ─────────────────────────────────────────────────────────── */

// One cache slot per days value: the dashboard polls, and 30s of staleness is
// invisible next to metrics that aggregate whole days.
const cache = new Map<number, { at: number; data: any }>();

// Downstream metrics endpoints enforce the same x-user-role gate, so forward
// the identity the authenticate middleware already verified for this request.
const adminHeaders = (req: Request): Record<string, string> => ({
  'x-user-role': 'ADMIN',
  'x-user-id': String(req.headers['x-user-id'] ?? ''),
});

/** Compare phone numbers on their last 10 digits: the DB stores +91XXXXXXXXXX
 *  while Meta echoes 91XXXXXXXXXX, so full strings never match verbatim. */
const last10 = (value: unknown): string => String(value ?? '').replace(/\D/g, '').slice(-10);

export const systemHealthRouter = Router();

systemHealthRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  if (String(req.headers['x-user-role'] ?? '').toUpperCase() !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Only an admin can read the system health metrics.' });
  }

  const days = Number(req.query.days) === 30 ? 30 : 7;
  const hit = cache.get(days);
  if (req.query.refresh !== 'true' && hit && Date.now() - hit.at < CACHE_TTL_SECONDS * 1000) {
    return res.status(HTTP_STATUS.OK).json(successResponse(hit.data, 'System health (cached).'));
  }

  const headers = adminHeaders(req);

  // Health pings and metrics fetches all fly at once; ping() never rejects,
  // and allSettled absorbs any metrics failure into its own section.
  const pings = Promise.all([
    ping(AUTH_SERVICE_URL),
    ping(LEARN_SERVICE_URL),
    ping(COMMUNICATION_SERVICE_URL),
    ping(PAY_SERVICE_URL),
    ping(INTEGRATION_SERVICE_URL),
    ping(ANALYTICS_SERVICE_URL),
  ]);
  // Each service caches its own answer for a minute, so an explicit Refresh
  // has to say so downstream too — otherwise the button only clears the
  // gateway's copy and returns the same minute-old numbers.
  const forceRefresh = req.query.refresh === 'true' ? '&refresh=true' : '';
  const [pipelineR, aiR, recordingsR, zoomR, whatsappR] = await Promise.allSettled([
    fetchJson(`${AUTH_SERVICE_URL}/metrics/pipeline?days=${days}${forceRefresh}`, headers, METRICS_TIMEOUT_MS),
    fetchJson(`${LEARN_SERVICE_URL}/metrics/ai?days=${days}${forceRefresh}`, headers, METRICS_TIMEOUT_MS),
    fetchJson(`${INTEGRATION_SERVICE_URL}/metrics/recordings?days=${days}${forceRefresh}`, headers, METRICS_TIMEOUT_MS),
    // Zoom is deliberately NOT force-refreshed here: its cache is an hour long
    // because the probe spends the same API budget bookings need.
    fetchJson(`${INTEGRATION_SERVICE_URL}/metrics/zoom`, headers, METRICS_TIMEOUT_MS),
    fetchJson(`${COMMUNICATION_SERVICE_URL}/metrics/whatsapp?days=${days}${forceRefresh}`, headers, METRICS_TIMEOUT_MS),
  ]);
  const [authPing, learnPing, commPing, payPing, integPing, analyticsPing] = await pings;

  const value = (r: PromiseSettledResult<any>): any => (r.status === 'fulfilled' ? r.value : null);
  const pipeline = value(pipelineR);
  const ai = value(aiR);
  const recordings = value(recordingsR);
  const zoom = value(zoomR);
  const whatsapp = value(whatsappR);

  // Enrich the recent sends with who the class belonged to, so the dashboard
  // can flag messages that went to a number other than the parent's.
  let enrichedSends: any[] = [];
  if (whatsapp) {
    const recentSends: any[] = Array.isArray(whatsapp.recentSends) ? whatsapp.recentSends : [];
    const classIds = [...new Set(
      recentSends.map((s) => s?.classId).filter((id): id is string => typeof id === 'string' && id.length > 0)
    )].slice(0, 60); // auth truncates at 60 too — belt and braces

    let refsById = new Map<string, any>();
    if (classIds.length > 0) {
      try {
        const refs = await fetchJson(
          `${AUTH_SERVICE_URL}/metrics/class-refs?ids=${classIds.map(encodeURIComponent).join(',')}`,
          headers,
          METRICS_TIMEOUT_MS
        );
        if (Array.isArray(refs)) refsById = new Map(refs.map((r: any) => [r.id, r]));
      } catch (err: any) {
        // Enrichment is a bonus — the sends still render without names.
        logger.warn(`[SystemHealth] class-refs enrichment skipped: ${err.message}`);
      }
    }

    // Distinct destination numbers per class — 2+ means the same class's
    // report went out to different numbers, which is worth a human look.
    const numbersByClass = new Map<string, Set<string>>();
    for (const send of recentSends) {
      if (!send?.classId) continue;
      const numbers = numbersByClass.get(send.classId) ?? new Set<string>();
      numbers.add(String(send.to ?? ''));
      numbersByClass.set(send.classId, numbers);
    }

    enrichedSends = recentSends.map((send) => {
      const ref = send?.classId ? refsById.get(send.classId) : undefined;
      const parentPhone = ref?.parentPhone ?? null;
      const anomalies: string[] = [];
      if (send?.classId && (numbersByClass.get(send.classId)?.size ?? 0) >= 2) anomalies.push('multiple-numbers');
      if (parentPhone && last10(send?.to) !== last10(parentPhone)) anomalies.push('not-parent-number');
      return {
        ...send,
        studentName: ref?.studentName ?? null,
        sessionTitle: ref?.sessionTitle ?? null,
        parentPhone,
        anomalies,
      };
    });
  }

  // db reflects whether the service's OWN metrics query worked — a sharper
  // signal than the ping, which only proves the HTTP process is alive.
  // Gateway, payment and analytics expose no metrics endpoint, hence null.
  const db = (r: PromiseSettledResult<any>): string => (r.status === 'fulfilled' ? 'ok' : 'error');
  const services = [
    { name: 'gateway', up: true, uptimeSeconds: Math.round(process.uptime() * 10) / 10, latencyMs: 0, db: null },
    { name: 'auth', ...authPing, db: db(pipelineR) },
    { name: 'learning', ...learnPing, db: db(aiR) },
    { name: 'communication', ...commPing, db: db(whatsappR) },
    { name: 'payment', ...payPing, db: null },
    { name: 'integration', ...integPing, db: db(recordingsR) },
    { name: 'analytics', ...analyticsPing, db: null },
  ];

  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const data = {
    generatedAt: new Date().toISOString(),
    days,
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    services,
    pipeline: pipeline ?? { down: true },
    ai: ai ?? { down: true },
    recordings: recordings ?? { down: true },
    zoom: zoom ?? { down: true },
    whatsapp: whatsapp ? { ...whatsapp, recentSends: enrichedSends } : { down: true },
    logErrors: { since: new Date(sinceMs).toISOString(), byService: countLogErrors(sinceMs) },
  };

  cache.set(days, { at: Date.now(), data });
  res.status(HTTP_STATUS.OK).json(successResponse(data, 'System health.'));
}));

/**
 * GET /api/system-health/class/:classId/sends — every WhatsApp send for one
 * class merged with the class's identity and report state. Uncached: this is
 * the drill-down an admin opens right after retrying a dispatch, so it must
 * show the retry immediately.
 */
systemHealthRouter.get('/class/:classId/sends', asyncHandler(async (req: Request, res: Response) => {
  if (String(req.headers['x-user-role'] ?? '').toUpperCase() !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Only an admin can read the system health metrics.' });
  }

  const classId = String(req.params.classId);
  const headers = adminHeaders(req);

  const [sendsR, refsR] = await Promise.allSettled([
    fetchJson(`${COMMUNICATION_SERVICE_URL}/metrics/whatsapp/class/${encodeURIComponent(classId)}`, headers, METRICS_TIMEOUT_MS),
    fetchJson(`${AUTH_SERVICE_URL}/metrics/class-refs?ids=${encodeURIComponent(classId)}`, headers, METRICS_TIMEOUT_MS),
  ]);

  const sendsPayload = sendsR.status === 'fulfilled' ? sendsR.value : null;
  const refs = refsR.status === 'fulfilled' && Array.isArray(refsR.value) ? refsR.value : [];
  const ref = refs.find((r: any) => r?.id === classId) ?? null;

  res.status(HTTP_STATUS.OK).json(successResponse({
    classId,
    studentName: ref?.studentName ?? null,
    sessionTitle: ref?.sessionTitle ?? null,
    parentPhone: ref?.parentPhone ?? null,
    report: ref
      ? {
          sentAt: ref.reportSentAt ?? null,
          sentTo: ref.reportSentTo ?? null,
          attempts: ref.reportAttempts ?? 0,
          lastError: ref.reportLastError ?? null,
        }
      : null,
    sends: Array.isArray(sendsPayload?.sends) ? sendsPayload.sends : [],
  }));
}));
