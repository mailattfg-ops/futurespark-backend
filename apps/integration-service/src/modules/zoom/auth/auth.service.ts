import { db, withDbRetry } from '../../../database/datasource';
import { logger } from '@futurespark/logger';
import crypto from 'crypto';

/* ══════════════════════════════════════════════════════════════════════════
 * CONFIGURATION
 *
 * Every value is read LAZILY through a getter, never captured into a module
 * const at import time. `server.ts` imports `./app` — which transitively
 * imports this file — BEFORE `dotenv.config()` runs in some services, so any
 * `process.env.X` evaluated in a module body would be `undefined` under
 * `npm start` / `npm run dev`. Lazy reads make the load order irrelevant.
 *
 * Zoom is an OPTIONAL fallback provider. It is OFF unless ZOOM_ENABLED is
 * explicitly "true", and there are no fallback credentials and no fallback
 * host: a missing value produces a clear error, never a silent default.
 * ═══════════════════════════════════════════════════════════════════════ */

/** Read an env var, treating empty/whitespace-only as unset. */
const readEnv = (name: string): string | undefined => {
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Booleans are explicit in both directions. An unparseable value keeps the
 * default and says so rather than being coerced to `false`, because
 * "ZOOM_ENABLED=TRUE " silently disabling Zoom is the kind of thing nobody
 * finds for a week.
 */
const readBoolEnv = (name: string, fallback: boolean): boolean => {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  logger.warn(`[Zoom Config] ${name}="${raw}" is not a boolean (true/false); using ${fallback}.`);
  return fallback;
};

const readIntEnv = (name: string, fallback: number, min: number, max: number): number => {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    logger.warn(`[Zoom Config] ${name}="${raw}" is out of range (${min}-${max}); using ${fallback}.`);
    return fallback;
  }
  return parsed;
};

const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

interface HostPool {
  /** The raw env string this was parsed from — the memo key. */
  raw: string;
  /** Valid seats, trimmed, de-duplicated case-insensitively, in declared order. */
  emails: string[];
  /** Entries that did not look like an email address and were dropped. */
  invalid: string[];
}

/**
 * Memoised on the raw string so the warning below is logged once per distinct
 * value rather than once per booking, and so a create does not re-parse the
 * pool on every attempt.
 */
let hostPoolCache: HostPool | null = null;

/**
 * The seat list: `ZOOM_HOST_EMAILS=seat1@x.com,seat2@x.com,...`
 *
 * Deliberately env-based rather than a DB table — adding a seat is an infra
 * change, and keeping it out of the database means the host pool needs no
 * schema change at all (the chosen seat is persisted on the existing
 * `Meeting.zoomHostEmail` column).
 *
 * Order is preserved because it is the tie-breaker in seat allocation, which
 * makes allocation deterministic and therefore reproducible when debugging.
 */
const parseHostPool = (): HostPool => {
  const raw = readEnv('ZOOM_HOST_EMAILS') ?? '';
  if (hostPoolCache && hostPoolCache.raw === raw) return hostPoolCache;

  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];

  for (const part of raw.split(',')) {
    const candidate = part.trim();
    if (!candidate) continue; // drop blanks, including a trailing comma
    if (!EMAIL_PATTERN.test(candidate)) {
      invalid.push(candidate);
      continue;
    }
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue; // dedupe, case-insensitively
    seen.add(key);
    emails.push(candidate);
  }

  if (invalid.length > 0) {
    // One bad entry must not take the whole pool down — the remaining seats
    // still work — but it does mean fewer concurrent classes than intended.
    logger.warn(
      `[Zoom Config] ZOOM_HOST_EMAILS contains ${invalid.length} entr${invalid.length === 1 ? 'y' : 'ies'} ` +
        `that ${invalid.length === 1 ? 'is' : 'are'} not an email address and ${invalid.length === 1 ? 'was' : 'were'} ` +
        `dropped: ${invalid.join(', ')}. Usable seats: ${emails.length}.`
    );
  }

  hostPoolCache = { raw, emails, invalid };
  return hostPoolCache;
};

export const zoomConfig = {
  /**
   * Master switch. Zoom is an optional fallback provider behind Google Meet,
   * so it stays off until someone turns it on deliberately.
   */
  get enabled(): boolean {
    return readBoolEnv('ZOOM_ENABLED', false);
  },

  /** Licensed Zoom seats available to host sessions. Empty = pool not configured. */
  get hostEmails(): string[] {
    return parseHostPool().emails;
  },

  get invalidHostEmails(): string[] {
    return parseHostPool().invalid;
  },

  /**
   * Try the mentor's own Zoom account as host before touching the pool.
   *
   * Supports the future where mentors are licensed users themselves — their
   * meetings then appear in their own Zoom account and their own recordings
   * list. Harmless when they are not licensed: Zoom answers "user does not
   * exist" for that address and allocation falls back to the pool.
   */
  get preferMentorHost(): boolean {
    return readBoolEnv('ZOOM_PREFER_MENTOR_HOST', false);
  },

  /**
   * Let participants into the room before the host arrives.
   *
   * Default true, and it has to be, because a pool seat is a service account —
   * no human ever signs into it, so with join_before_host off NOBODY can ever
   * be admitted and every class is a locked door.
   *
   * The honest tradeoff: join_before_host and waiting_room are mutually
   * exclusive on Zoom's side, so this also means no waiting room. A student
   * and a mentor can therefore be in the room together unsupervised, and
   * anyone holding the link (plus the passcode, when the host account's policy
   * generates one) can walk in. On a platform teaching minors that is a real
   * safeguarding gap, mitigated only by the link not being public and by the
   * cloud recording. Setting ZOOM_JOIN_BEFORE_HOST=false turns the waiting
   * room back on — but only do that when a licensed human is actually the host
   * (ZOOM_PREFER_MENTOR_HOST with licensed mentors), otherwise every class is
   * unenterable.
   */
  get joinBeforeHost(): boolean {
    return readBoolEnv('ZOOM_JOIN_BEFORE_HOST', true);
  },

  /**
   * The account a Zoom booking is recorded as being organised by. This is NOT
   * the host — see `resolveTokenForHost`. It only decides which stored
   * credential is used and what lands in `Meeting.organizerEmail`.
   */
  get organizerEmail(): string {
    return readEnv('ZOOM_ORGANIZER_EMAIL') || 'zoom@meet.futurespark.com';
  },

  // ── Server-to-Server / OAuth credentials ──
  get accountId(): string | undefined {
    return readEnv('ZOOM_ACCOUNT_ID');
  },
  get clientId(): string | undefined {
    return readEnv('ZOOM_CLIENT_ID');
  },
  get clientSecret(): string | undefined {
    return readEnv('ZOOM_CLIENT_SECRET');
  },
  get redirectUri(): string {
    return readEnv('ZOOM_REDIRECT_URI') || 'http://localhost:3000/api/zoom/callback';
  },

  // ── API budget (see the doorway below) ──
  get apiMinIntervalMs(): number {
    return readIntEnv('ZOOM_API_MIN_INTERVAL_MS', 200, 0, 60_000);
  },
  get apiMaxPerMinute(): number {
    return readIntEnv('ZOOM_API_MAX_PER_MINUTE', 60, 1, 10_000);
  },
  get apiBackoffMs(): number {
    return readIntEnv('ZOOM_API_BACKOFF_MS', 2000, 100, 120_000);
  },
  get apiMaxAttempts(): number {
    return readIntEnv('ZOOM_API_MAX_ATTEMPTS', 3, 1, 10);
  },
  /** A hung socket must not sit inside an advisory lock until the tx times out. */
  get apiTimeoutMs(): number {
    return readIntEnv('ZOOM_API_TIMEOUT_MS', 20_000, 1_000, 120_000);
  },

  // ── Host allocation ──
  /** How many hosts a single create may try before giving up. */
  get maxHostAttempts(): number {
    return readIntEnv('ZOOM_MAX_HOST_ATTEMPTS', 3, 1, 25);
  },
  /** How far back "least recently used" looks. Bounds the allocation query. */
  get hostLruWindowDays(): number {
    return readIntEnv('ZOOM_HOST_LRU_WINDOW_DAYS', 30, 1, 365);
  },

  // ── Booking transaction (same names the Google path uses) ──
  get createTimeoutMs(): number {
    return readIntEnv('MEETING_CREATE_TIMEOUT_MS', 120_000, 5_000, 600_000);
  },
  get createMaxWaitMs(): number {
    return readIntEnv('MEETING_CREATE_MAX_WAIT_MS', 60_000, 1_000, 600_000);
  },
};

/** Reasons Zoom cannot create a meeting at all. Empty array = good to go. */
export const getZoomConfigErrors = (): string[] => {
  const errors: string[] = [];

  if (!zoomConfig.enabled) {
    errors.push(
      'ZOOM_ENABLED is not "true". Zoom is an optional fallback provider and is off by default; ' +
        'set ZOOM_ENABLED=true to turn it on.'
    );
  }
  if (zoomConfig.hostEmails.length === 0) {
    errors.push(
      'ZOOM_HOST_EMAILS is not set (or holds no valid address). Set it to a comma-separated list of ' +
        'LICENSED Zoom user emails, e.g. ZOOM_HOST_EMAILS=seat1@finquojunior.com,seat2@finquojunior.com. ' +
        'One licensed host can run only one live meeting at a time, so the number of seats is the number ' +
        'of classes that can run concurrently.'
    );
  }
  return errors;
};

/** Non-blocking problems worth shouting about. */
export const getZoomConfigWarnings = (): string[] => {
  const warnings: string[] = [];

  if (!zoomConfig.accountId || !zoomConfig.clientId || !zoomConfig.clientSecret) {
    warnings.push(
      'ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET are not all present in the environment. ' +
        'A connected SERVER_TO_SERVER row in the ZoomAccount table is used instead when one exists; ' +
        'otherwise every Zoom call will fail.'
    );
  }
  if (zoomConfig.invalidHostEmails.length > 0) {
    warnings.push(
      `ZOOM_HOST_EMAILS has ${zoomConfig.invalidHostEmails.length} malformed entr` +
        `${zoomConfig.invalidHostEmails.length === 1 ? 'y' : 'ies'} that will never be allocated: ` +
        `${zoomConfig.invalidHostEmails.join(', ')}.`
    );
  }
  if (zoomConfig.enabled && !zoomConfig.joinBeforeHost && !zoomConfig.preferMentorHost) {
    warnings.push(
      'ZOOM_JOIN_BEFORE_HOST=false with ZOOM_PREFER_MENTOR_HOST=false means every meeting is hosted by ' +
        'an unattended pool seat behind a waiting room nobody can open. Participants will not be able to join.'
    );
  }
  return warnings;
};

export const isZoomEnabled = (): boolean => zoomConfig.enabled;

/** True when a Zoom meeting could actually be created right now. */
export const isZoomConfigured = (): boolean => getZoomConfigErrors().length === 0;

/**
 * "This deployment cannot talk to Zoom", as distinct from "Zoom said no".
 *
 * Typed so callers can answer 503 rather than dressing a missing environment
 * variable up as a Zoom API failure.
 */
export class ZoomConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoomConfigError';
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * TOKEN ENCRYPTION
 * ═══════════════════════════════════════════════════════════════════════ */

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
// NOTE: read at module load on purpose — changing it lazily would re-derive the
// key for a process whose stored ciphertext was written with the fallback, and
// `decrypt` fails open (returns its input), so the breakage would be silent.
// ENCRYPTION_KEY is absent from .env today, which means the hardcoded fallback
// below is live. That is a real weakness, but rotating it is a data migration,
// not a code change.
const ENCRYPTION_KEY = Buffer.concat([Buffer.from(process.env.ENCRYPTION_KEY || 'default-secret-key-32-chars-long!')], 32);

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText: string): string {
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return encryptedText;
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    logger.error(`Zoom token decryption failed: ${(err as Error).message}`);
    return encryptedText;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE ZOOM API DOORWAY
 *
 * Zoom rate-limits per account, and — the limit that actually bites a host
 * pool — caps meeting CREATIONS per user per day (100 on most plans). A burst
 * of bookings that trips either one comes back as 429s, and nothing but time
 * clears the daily cap. So every Zoom request in this service funnels through
 * one queue that spaces calls apart and caps them per rolling minute, exactly
 * as GoogleCalendarService does for Calendar.
 *
 * This replaces `withZoomRetry`, which was called from exactly one line while
 * the token fetch, the PATCH, the DELETE and the presence poll all issued bare
 * `fetch` with no retry, no spacing and no logging.
 * ═══════════════════════════════════════════════════════════════════════ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const recentCallTimes: number[] = [];
let queueTail: Promise<unknown> = Promise.resolve();

/** Drop timestamps older than the rolling window. */
const pruneWindow = (nowMs: number) => {
  const cutoff = nowMs - 60_000;
  while (recentCallTimes.length && recentCallTimes[0] < cutoff) recentCallTimes.shift();
};

/**
 * Hold each call back until both the spacing and the per-minute budget allow
 * it. Called inside the attempt loop, so a retry consumes budget like any
 * other call.
 */
async function throttle(): Promise<void> {
  const maxPerMinute = zoomConfig.apiMaxPerMinute;
  const minIntervalMs = zoomConfig.apiMinIntervalMs;

  for (;;) {
    const now = Date.now();
    pruneWindow(now);

    if (recentCallTimes.length >= maxPerMinute) {
      const waitMs = recentCallTimes[0] + 60_000 - now + 5;
      logger.warn(
        `[ZoomApi] Local budget reached (${maxPerMinute}/min). Holding the next call for ${waitMs}ms.`
      );
      await sleep(waitMs);
      continue;
    }

    const last = recentCallTimes[recentCallTimes.length - 1];
    if (last !== undefined && now - last < minIntervalMs) {
      await sleep(minIntervalMs - (now - last));
      continue;
    }

    recentCallTimes.push(Date.now());
    return;
  }
}

export interface ZoomApiErrorInit {
  status?: number;
  zoomCode?: number | string | null;
  body?: string;
  retryAfterMs?: number | null;
  /** True when the request never got an HTTP response at all. */
  transport?: boolean;
}

/**
 * `fetch` does not throw on 4xx/5xx, so every non-OK response is converted
 * into one of these BEFORE the retry classifier runs. Without that the old
 * code's `isRetryableZoomError` could never fire outside the one call site
 * that hand-attached `err.status`.
 */
export class ZoomApiError extends Error {
  readonly status?: number;
  readonly zoomCode: number | string | null;
  readonly body: string;
  readonly retryAfterMs: number | null;
  readonly transport: boolean;

  constructor(message: string, init: ZoomApiErrorInit = {}) {
    super(message);
    this.name = 'ZoomApiError';
    this.status = init.status;
    this.zoomCode = init.zoomCode ?? null;
    this.body = init.body ?? '';
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.transport = init.transport ?? false;
  }
}

/** Errors that must never be retried, whatever else they look like. */
const isNonRetryableStatus = (status: number | undefined): boolean =>
  status === 400 || status === 401 || status === 403 || status === 404 || status === 409;

const isRetryableZoomError = (err: unknown, retryOnNetworkError: boolean): boolean => {
  if (!(err instanceof ZoomApiError)) return false;
  // No HTTP response at all: a socket reset or a timeout. Safe to repeat for
  // idempotent calls; NOT safe for a create, which may already have made a
  // meeting we would never learn the id of.
  if (err.transport) return retryOnNetworkError;
  if (isNonRetryableStatus(err.status)) return false;
  return err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503 || err.status === 504;
};

const zoomErrorReason = (err: unknown): string => {
  if (err instanceof ZoomApiError) {
    if (err.transport) return 'transport';
    return String(err.zoomCode ?? err.status ?? 'unknown');
  }
  return 'unknown';
};

/** Zoom tells us how long to wait on some 429s. Prefer it over guessing. */
const parseRetryAfter = (headers: { get(name: string): string | null } | null | undefined): number | null => {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw); // Retry-After may also be an HTTP date
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
};

export type ZoomOperation = 'token' | 'create' | 'get' | 'patch' | 'delete';

export interface ZoomCallContext {
  operation: ZoomOperation;
  /** The FutureSpark session, so a Zoom call can be traced to a class. */
  sessionId?: string | null;
  /** The Zoom meeting id, where one exists yet. */
  meetingId?: string | null;
  /** The pool seat / user the call is made against. Never a token or secret. */
  host?: string | null;
}

export interface ZoomRequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  bearer?: string;
  basic?: string;
  json?: unknown;
  form?: string;
  /**
   * Defaults to false for POST — repeating a create that may already have
   * succeeded would mint a duplicate meeting. Set true for POSTs that are
   * effectively idempotent, like the token endpoint.
   */
  retryOnNetworkError?: boolean;
}

export interface ZoomResponse<T> {
  status: number;
  /** null for 204 / empty bodies. */
  data: T | null;
}

/** Lifetime counters, exposed for diagnostics and tests. */
const usage = { token: 0, create: 0, get: 0, patch: 0, delete: 0, retries: 0, failures: 0 };
export const getZoomApiUsage = () => ({ ...usage, windowUsed: recentCallTimes.length });

async function performRequest<T>(ctx: ZoomCallContext, opts: ZoomRequestOptions): Promise<ZoomResponse<T>> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  else if (opts.basic) headers.Authorization = `Basic ${opts.basic}`;

  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = opts.form;
  }

  let response: Response;
  try {
    response = await fetch(opts.url, {
      method: opts.method,
      headers,
      body,
      signal: AbortSignal.timeout(zoomConfig.apiTimeoutMs),
    });
  } catch (err: any) {
    // Never echo the URL: the token endpoint carries account_id in its query.
    throw new ZoomApiError(`Zoom ${ctx.operation} request failed before a response: ${err?.message ?? err}`, {
      transport: true,
    });
  }

  // Read once as text: a 204 has no body, and consuming the stream twice throws.
  const text = await response.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const detail = parsed?.message ?? parsed?.reason ?? text.slice(0, 500) ?? response.statusText;
    throw new ZoomApiError(`Zoom API error (${response.status}) on ${ctx.operation}: ${detail}`, {
      status: response.status,
      zoomCode: parsed?.code ?? null,
      body: text.slice(0, 2000),
      retryAfterMs: parseRetryAfter(response.headers),
    });
  }

  return { status: response.status, data: (parsed as T) ?? null };
}

/**
 * The single doorway to the Zoom API.
 *
 * Everything — throttling, backoff, structured logging, counters — happens
 * here, so no call site can accidentally bypass the budget. One JSON log line
 * per call, outcome ∈ success | retrying | failed (call sites emit `skipped`).
 */
export async function callZoom<T = any>(
  ctx: ZoomCallContext,
  opts: ZoomRequestOptions
): Promise<ZoomResponse<T>> {
  const maxAttempts = zoomConfig.apiMaxAttempts;
  const retryOnNetworkError = opts.retryOnNetworkError ?? opts.method !== 'POST';

  const run = async (): Promise<ZoomResponse<T>> => {
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await throttle();
      const startedAt = Date.now();
      try {
        const result = await performRequest<T>(ctx, opts);
        usage[ctx.operation] += 1;
        logger.info(
          `[ZoomApi] ${JSON.stringify({
            operation: ctx.operation,
            sessionId: ctx.sessionId ?? null,
            meetingId: ctx.meetingId ?? null,
            host: ctx.host ?? null,
            outcome: 'success',
            attempt,
            httpStatus: result.status,
            durationMs: Date.now() - startedAt,
            windowUsed: recentCallTimes.length,
            at: new Date().toISOString(),
          })}`
        );
        return result;
      } catch (err: any) {
        lastErr = err;
        const willRetry = attempt < maxAttempts && isRetryableZoomError(err, retryOnNetworkError);
        logger.warn(
          `[ZoomApi] ${JSON.stringify({
            operation: ctx.operation,
            sessionId: ctx.sessionId ?? null,
            meetingId: ctx.meetingId ?? null,
            host: ctx.host ?? null,
            outcome: willRetry ? 'retrying' : 'failed',
            attempt,
            httpStatus: err?.status ?? null,
            reason: zoomErrorReason(err),
            message: err?.message,
            durationMs: Date.now() - startedAt,
            at: new Date().toISOString(),
          })}`
        );
        if (!willRetry) {
          usage.failures += 1;
          throw err;
        }
        usage.retries += 1;
        // Exponential backoff — 2s, 4s, 8s — with jitter so parallel bookings
        // do not resynchronise and collide on the retry. Zoom's own
        // Retry-After wins when it sends one.
        const backoff = zoomConfig.apiBackoffMs * 2 ** (attempt - 1);
        const retryAfter = err instanceof ZoomApiError ? err.retryAfterMs : null;
        await sleep(retryAfter ?? Math.round(backoff * (1 + Math.random() * 0.3)));
      }
    }
    usage.failures += 1;
    throw lastErr;
  };

  // Chain onto the queue so calls leave in order and the spacing holds. `run`
  // is passed as BOTH handlers so a rejected predecessor cannot break the
  // chain, and the stored tail never rejects.
  const scheduled = queueTail.then(run, run);
  queueTail = scheduled.catch(() => undefined);
  return scheduled;
}

/* ══════════════════════════════════════════════════════════════════════════
 * TOKENS
 * ═══════════════════════════════════════════════════════════════════════ */

interface ServerToServerTokenCache {
  accessToken: string;
  expiresAt: number; // Unix epoch ms
  accountId: string;
}

let s2sTokenCache: ServerToServerTokenCache | null = null;
/** De-duplicates concurrent token fetches: N callers, one OAuth round trip. */
let s2sInFlight: Promise<string> | null = null;

export type ZoomIdentityKind = 'user-oauth' | 'server-to-server';

export interface ZoomResolvedToken {
  accessToken: string;
  /** Which credential answered — so logs can say who a meeting was created as. */
  identity: ZoomIdentityKind;
  /** The Zoom user the OAuth grant belongs to, or null for the account token. */
  identityEmail: string | null;
}

export class ZoomAuthService {
  /**
   * Retrieves a Server-to-Server OAuth access token for Zoom API operations.
   * Cached in memory and refreshed 5 minutes before expiry.
   */
  static async getServerToServerToken(): Promise<string> {
    ZoomAuthService.assertEnabled();

    // Cache FIRST, before resolving credentials. This used to sit inside the
    // env-configured branch only, so the DB-credentials path — the only
    // reachable one in this deployment — fetched a brand new token, plus a DB
    // round trip, on EVERY Zoom call.
    const now = Date.now();
    if (s2sTokenCache && s2sTokenCache.expiresAt > now + 5 * 60 * 1000) {
      return s2sTokenCache.accessToken;
    }
    if (s2sInFlight) return s2sInFlight;

    const fetchToken = async (): Promise<string> => {
      const envAccountId = zoomConfig.accountId;
      const envClientId = zoomConfig.clientId;
      const envClientSecret = zoomConfig.clientSecret;

      if (envAccountId && envClientId && envClientSecret) {
        return ZoomAuthService.fetchS2SToken(envAccountId, envClientId, envClientSecret);
      }

      const dbAccount = await withDbRetry(() =>
        db.zoomAccount.findFirst({
          where: { accountType: 'SERVER_TO_SERVER', connected: true },
        })
      );

      if (dbAccount && dbAccount.accountId && dbAccount.clientId && dbAccount.clientSecret) {
        return ZoomAuthService.fetchS2SToken(
          dbAccount.accountId,
          decrypt(dbAccount.clientId),
          decrypt(dbAccount.clientSecret)
        );
      }

      throw new ZoomConfigError(
        'Zoom Server-to-Server credentials are not configured. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ' +
          'ZOOM_CLIENT_SECRET, or connect a SERVER_TO_SERVER Zoom account.'
      );
    };

    const inFlight = fetchToken().finally(() => {
      s2sInFlight = null;
    });
    s2sInFlight = inFlight;
    return inFlight;
  }

  private static async fetchS2SToken(accountId: string, clientId: string, clientSecret: string): Promise<string> {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;

    // Retryable on a transport failure despite being a POST: requesting a
    // token twice costs nothing and creates nothing.
    const { data } = await callZoom<any>(
      { operation: 'token' },
      { method: 'POST', url, basic: credentials, form: '', retryOnNetworkError: true }
    );

    const accessToken = data?.access_token;
    if (!accessToken) {
      throw new Error('Zoom returned no access_token for the Server-to-Server grant.');
    }
    const expiresIn = data.expires_in || 3600; // seconds

    s2sTokenCache = {
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
      accountId,
    };

    logger.info('[ZoomAuth] Acquired a fresh Server-to-Server OAuth token');
    return accessToken;
  }

  /**
   * Generates authorization URL for User OAuth 2.0 flow.
   *
   * NOTE: `state` is the caller-supplied email with no CSRF nonce. Out of
   * scope here, but this endpoint is unauthenticated and the state is fully
   * attacker-chosen.
   */
  static getAuthUrl(email: string): string {
    const clientId = zoomConfig.clientId;
    if (!clientId) {
      throw new Error('ZOOM_CLIENT_ID is not configured in the environment.');
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: zoomConfig.redirectUri,
      state: email,
    });

    return `https://zoom.us/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchanges authorization code for OAuth 2.0 tokens and saves to DB.
   *
   * Deliberately NOT gated on ZOOM_ENABLED: an operator has to be able to wire
   * accounts up before turning the provider on.
   */
  static async handleCallback(code: string, stateEmail: string) {
    const clientId = zoomConfig.clientId;
    const clientSecret = zoomConfig.clientSecret;

    if (!clientId || !clientSecret) {
      throw new Error('Zoom OAuth credentials (ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET) are not configured.');
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: zoomConfig.redirectUri,
    });

    const { data: tokenData } = await callZoom<any>(
      { operation: 'token' },
      {
        method: 'POST',
        url: 'https://zoom.us/oauth/token',
        basic: credentials,
        form: params.toString(),
        // An authorization code is single-use: replaying it after a transport
        // failure just burns it.
        retryOnNetworkError: false,
      }
    );

    const accessToken = tokenData?.access_token;
    if (!accessToken) throw new Error('Zoom OAuth exchange returned no access_token.');
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in || 3600;

    // Resolve the real Zoom identity behind the grant; fall back to the state
    // email if Zoom will not tell us.
    let zoomEmail = stateEmail;
    try {
      const { data: userData } = await callZoom<any>(
        { operation: 'get' },
        { method: 'GET', url: 'https://api.zoom.us/v2/users/me', bearer: accessToken }
      );
      zoomEmail = userData?.email || stateEmail;
    } catch (err: any) {
      logger.warn(`[ZoomAuth] Could not read the Zoom profile for the new grant: ${err.message}`);
    }

    const encryptedAccessToken = encrypt(accessToken);
    const encryptedRefreshToken = refreshToken ? encrypt(refreshToken) : '';
    const expiryDate = new Date(Date.now() + expiresIn * 1000);

    const account = await withDbRetry(() =>
      db.zoomAccount.upsert({
        where: { accountEmail: zoomEmail },
        update: {
          accessToken: encryptedAccessToken,
          ...(encryptedRefreshToken ? { refreshToken: encryptedRefreshToken } : {}),
          tokenExpiry: expiryDate,
          connected: true,
          accountType: 'OAUTH',
        },
        create: {
          accountEmail: zoomEmail,
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          tokenExpiry: expiryDate,
          connected: true,
          accountType: 'OAUTH',
        },
      })
    );

    logger.info(`[ZoomAuth] Zoom account connected successfully for: ${zoomEmail}`);
    return account;
  }

  /**
   * Returns a valid Bearer access token for Zoom REST API requests.
   * Priority: User OAuth if the email is connected, otherwise Server-to-Server.
   */
  static async getAccessToken(email?: string): Promise<string> {
    const resolved = await ZoomAuthService.resolveToken(email);
    return resolved.accessToken;
  }

  /**
   * Same as `getAccessToken`, but says WHICH credential answered.
   *
   * Any email with no ZoomAccount row — or a disconnected one — silently falls
   * through to the account-wide Server-to-Server token, which changes who
   * Zoom thinks is acting. Callers that care can now see it.
   */
  static async resolveToken(email?: string | null): Promise<ZoomResolvedToken> {
    ZoomAuthService.assertEnabled();

    if (email) {
      const account = await withDbRetry(() =>
        db.zoomAccount.findUnique({ where: { accountEmail: email } })
      );

      if (account && account.connected && account.accessToken) {
        if (account.tokenExpiry && account.tokenExpiry.getTime() <= Date.now() + 60000 && account.refreshToken) {
          return {
            accessToken: await ZoomAuthService.refreshUserToken(account),
            identity: 'user-oauth',
            identityEmail: account.accountEmail,
          };
        }
        return {
          accessToken: decrypt(account.accessToken),
          identity: 'user-oauth',
          identityEmail: account.accountEmail,
        };
      }
    }

    return {
      accessToken: await ZoomAuthService.getServerToServerToken(),
      identity: 'server-to-server',
      identityEmail: null,
    };
  }

  /**
   * Picks the credential to create/modify a meeting owned by `hostEmail`.
   *
   * Host selection and token selection are two SEPARATE concepts and must stay
   * that way. The host is decided by the seat allocator; this only answers
   * "whose credential can act on that seat":
   *
   *   1. the seat's own OAuth grant, if it has connected one — then the token
   *      identity IS the host and no admin scope is needed;
   *   2. otherwise the organizer's credential, which in practice resolves to
   *      the account-wide Server-to-Server token. That token is account-scoped,
   *      which is exactly what makes `POST /users/{seat}/meetings` possible.
   */
  static async resolveTokenForHost(
    hostEmail: string | null | undefined,
    organizerEmail?: string | null
  ): Promise<ZoomResolvedToken> {
    if (hostEmail) {
      const hostAccount = await withDbRetry(() =>
        db.zoomAccount.findUnique({ where: { accountEmail: hostEmail } })
      );
      if (hostAccount && hostAccount.connected && hostAccount.accessToken) {
        return ZoomAuthService.resolveToken(hostEmail);
      }
    }
    return ZoomAuthService.resolveToken(organizerEmail ?? null);
  }

  /**
   * Resolves credentials for a whole set of candidate hosts in ONE query, so a
   * caller holding a lock does not have to touch the database again.
   *
   * Seat allocation runs inside a transaction that holds a global advisory
   * lock. Any query issued from inside it that is not routed through the
   * transaction client needs a SECOND connection from Prisma's pool — and
   * while N bookings queue on that lock, N connections are already held. Under
   * enough concurrency the holder cannot get a connection to finish, and the
   * pool deadlocks against itself. Resolving everything up front removes the
   * problem rather than making it rarer.
   */
  static async resolveHostCredentials(
    hosts: (string | null | undefined)[],
    organizerEmail?: string | null
  ): Promise<{ fallback: ZoomResolvedToken; byHost: Map<string, ZoomResolvedToken> }> {
    // First, because it is the one that fails when Zoom is off or the account
    // credential is missing — fail before doing any other work.
    const fallback = await ZoomAuthService.resolveToken(organizerEmail ?? null);

    const wanted = [...new Set(hosts.filter((h): h is string => typeof h === 'string' && h.trim().length > 0).map((h) => h.trim()))];
    const byHost = new Map<string, ZoomResolvedToken>();
    if (wanted.length === 0) return { fallback, byHost };

    const rows = await withDbRetry(() =>
      db.zoomAccount.findMany({ where: { accountEmail: { in: wanted }, connected: true } })
    );

    for (const row of rows) {
      if (!row.accessToken) continue;
      try {
        const needsRefresh =
          Boolean(row.tokenExpiry) && row.tokenExpiry!.getTime() <= Date.now() + 60_000 && Boolean(row.refreshToken);
        const accessToken = needsRefresh ? await ZoomAuthService.refreshUserToken(row) : decrypt(row.accessToken);
        byHost.set(row.accountEmail.toLowerCase(), {
          accessToken,
          identity: 'user-oauth',
          identityEmail: row.accountEmail,
        });
      } catch (err: any) {
        // A seat whose own grant is broken still works through the
        // account-wide token; it just acts as the account rather than as
        // itself. Say so instead of failing the booking.
        logger.warn(
          `[ZoomAuth] Could not use ${row.accountEmail}'s own OAuth grant (${err.message}); ` +
            `falling back to the account credential for that host.`
        );
      }
    }

    return { fallback, byHost };
  }

  private static async refreshUserToken(account: any): Promise<string> {
    const clientId = zoomConfig.clientId;
    const clientSecret = zoomConfig.clientSecret;
    if (!clientId || !clientSecret) {
      throw new ZoomConfigError('Zoom OAuth credentials (ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET) are missing for token refresh.');
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const plainRefreshToken = decrypt(account.refreshToken);

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: plainRefreshToken,
    });

    let data: any;
    try {
      const res = await callZoom<any>(
        { operation: 'token', host: account.accountEmail },
        {
          method: 'POST',
          url: 'https://zoom.us/oauth/token',
          basic: credentials,
          form: params.toString(),
          retryOnNetworkError: true,
        }
      );
      data = res.data;
    } catch (err: any) {
      // A revoked grant answers 400 invalid_grant forever. Mark the row
      // disconnected so the next call falls through to the account token
      // instead of throwing on every single request from here on.
      if (err instanceof ZoomApiError && (err.status === 400 || err.status === 401)) {
        logger.error(
          `[ZoomAuth] Refresh token for ${account.accountEmail} was rejected (${err.status}). ` +
            `Marking the account disconnected; it must be reconnected.`
        );
        await withDbRetry(() =>
          db.zoomAccount.update({ where: { id: account.id }, data: { connected: false } })
        ).catch(() => undefined);
      }
      throw new Error(`Failed to refresh Zoom OAuth token for ${account.accountEmail}: ${err.message}`);
    }

    if (!data?.access_token) throw new Error('Zoom refresh returned no access_token.');

    const encryptedAccess = encrypt(data.access_token);
    const encryptedRefresh = data.refresh_token ? encrypt(data.refresh_token) : account.refreshToken;
    const expiry = new Date(Date.now() + (data.expires_in || 3600) * 1000);

    await withDbRetry(() =>
      db.zoomAccount.update({
        where: { id: account.id },
        data: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          tokenExpiry: expiry,
        },
      })
    );

    return data.access_token;
  }

  static async disconnect(email: string) {
    const account = await withDbRetry(() =>
      db.zoomAccount.findUnique({ where: { accountEmail: email } })
    );

    if (!account) {
      throw new Error(`No Zoom account found for email: ${email}`);
    }

    return withDbRetry(() =>
      db.zoomAccount.update({
        where: { accountEmail: email },
        data: { connected: false },
      })
    );
  }

  static async getStatus() {
    const envConfigured = Boolean(zoomConfig.accountId && zoomConfig.clientId && zoomConfig.clientSecret);

    // The DB row is what `getServerToServerToken` actually falls back to, so a
    // status that ignores it reports "not configured" on a working deployment.
    const dbAccount = envConfigured
      ? null
      : await withDbRetry(() =>
          db.zoomAccount.findFirst({
            where: { accountType: 'SERVER_TO_SERVER', connected: true },
            select: { id: true, accountId: true, clientId: true, clientSecret: true },
          })
        );

    const accounts = await withDbRetry(() =>
      db.zoomAccount.findMany({
        select: {
          id: true,
          accountEmail: true,
          accountType: true,
          connected: true,
          tokenExpiry: true,
          createdAt: true,
        },
      })
    );

    return {
      enabled: zoomConfig.enabled,
      serverToServerConfigured:
        envConfigured || Boolean(dbAccount?.accountId && dbAccount?.clientId && dbAccount?.clientSecret),
      credentialSource: envConfigured ? 'env' : dbAccount ? 'database' : 'none',
      hostPoolSize: zoomConfig.hostEmails.length,
      configErrors: getZoomConfigErrors(),
      configWarnings: getZoomConfigWarnings(),
      apiUsage: getZoomApiUsage(),
      connectedAccounts: accounts,
    };
  }

  /** The master switch, enforced at the one place every Zoom call needs. */
  private static assertEnabled(): void {
    if (zoomConfig.enabled) return;
    throw new ZoomConfigError(
      'Zoom is disabled on this deployment (ZOOM_ENABLED is not "true"). Zoom is an optional fallback ' +
        'provider and is off by default — no Zoom API call will be made.'
    );
  }
}
