import { google } from 'googleapis';
import { GoogleAuthService } from '../auth/auth.service';
import { logger } from '@futurespark/logger';
import crypto from 'crypto';

export interface CalendarEventInput {
  title: string;
  description?: string;
  startTime: string; // ISO string
  endTime: string; // ISO string
  timezone: string;
  attendees: string[]; // array of emails
  /** Threaded into the conference requestId so a room can be traced to its session. */
  sessionId?: string;
}

/** Fields that genuinely live on Google. Anything not here is ours alone. */
export interface CalendarEventPatch {
  title?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  attendees?: string[];
}

// ── Quota governance ─────────────────────────────────────────────────────────
//
// Calendar allows 600 requests/minute per user, but the number that actually
// bites is not that ceiling — it is the anti-abuse throttle, which trips on
// bursts and on repeated create/delete cycles and then locks writes out for
// hours. Neither retrying nor a higher quota clears it.
//
// So every write funnels through one queue that spaces calls apart and caps
// them per rolling minute. Booking a 40-session programme becomes a steady
// trickle instead of 40 simultaneous inserts.

const MIN_INTERVAL_MS = Number(process.env.GOOGLE_CALENDAR_MIN_INTERVAL_MS ?? 150);
const MAX_PER_MINUTE = Number(process.env.GOOGLE_CALENDAR_MAX_PER_MINUTE ?? 120);

const recentCallTimes: number[] = [];
let queueTail: Promise<unknown> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drop timestamps older than the rolling window. */
const pruneWindow = (nowMs: number) => {
  const cutoff = nowMs - 60_000;
  while (recentCallTimes.length && recentCallTimes[0] < cutoff) recentCallTimes.shift();
};

/**
 * Serialise onto the shared queue, holding each call back until both the
 * spacing and the per-minute budget allow it.
 */
async function throttle(): Promise<void> {
  for (;;) {
    const now = Date.now();
    pruneWindow(now);

    if (recentCallTimes.length >= MAX_PER_MINUTE) {
      // Wait until the oldest call ages out of the window.
      const waitMs = recentCallTimes[0] + 60_000 - now + 5;
      logger.warn(
        `[GoogleCalendar] Local budget reached (${MAX_PER_MINUTE}/min). Holding the next write for ${waitMs}ms.`
      );
      await sleep(waitMs);
      continue;
    }

    const last = recentCallTimes[recentCallTimes.length - 1];
    if (last !== undefined && now - last < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - (now - last));
      continue;
    }

    recentCallTimes.push(Date.now());
    return;
  }
}

/**
 * Google answers a burst of writes with 403 rateLimitExceeded / usageLimits or
 * 429. Only limit and transient errors are retried — a bad token, a malformed
 * event or a missing event is returned immediately, since repeating those burns
 * quota to reach the same answer.
 */
const RETRYABLE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'backendError',
]);

/** Errors that must never be retried, whatever else they look like. */
const isNonRetryable = (status: number | undefined): boolean =>
  status === 400 || status === 401 || status === 404 || status === 409 || status === 410;

const isRetryableGoogleError = (err: any): boolean => {
  const status = err?.code ?? err?.response?.status;
  if (isNonRetryable(status)) return false;
  if (status === 429 || status === 500 || status === 502 || status === 503) return true;
  if (status !== 403) return false;
  const errors = err?.errors ?? err?.response?.data?.error?.errors ?? [];
  if (errors.some((e: any) => RETRYABLE_REASONS.has(e?.reason))) return true;
  // Some quota rejections arrive with only the human-readable message.
  return /usage limits|rate limit|quota/i.test(err?.message ?? '');
};

const googleErrorReason = (err: any): string => {
  const errors = err?.errors ?? err?.response?.data?.error?.errors ?? [];
  return errors[0]?.reason ?? String(err?.code ?? err?.response?.status ?? 'unknown');
};

/** Google sometimes tells us exactly how long to wait. Prefer it over guessing. */
const retryAfterMs = (err: any): number | null => {
  const raw = err?.response?.headers?.['retry-after'] ?? err?.response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  return Number.isFinite(secs) ? secs * 1000 : null;
};

const BASE_BACKOFF_MS = Number(process.env.GOOGLE_CALENDAR_BACKOFF_MS ?? 2000);
const MAX_ATTEMPTS = Number(process.env.GOOGLE_CALENDAR_MAX_ATTEMPTS ?? 3);

/** Lifetime counters, exposed for the usage endpoint and for tests. */
const usage = { create: 0, patch: 0, get: 0, delete: 0, retries: 0, failures: 0 };
export const getCalendarUsage = () => ({ ...usage, windowUsed: recentCallTimes.length });

interface CallContext {
  operation: 'create' | 'patch' | 'get' | 'delete';
  sessionId?: string;
  eventId?: string;
  organizer: string;
}

/**
 * The single doorway to the Calendar API.
 *
 * Everything — throttling, backoff, structured logging, counters — happens here,
 * so no call site can accidentally bypass the quota budget.
 */
async function callCalendar<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    let lastErr: any;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await throttle();
      const startedAt = Date.now();
      try {
        const result = await fn();
        usage[ctx.operation] += 1;
        logger.info(
          `[GoogleCalendar] ${JSON.stringify({
            operation: ctx.operation,
            sessionId: ctx.sessionId ?? null,
            eventId: ctx.eventId ?? null,
            organizer: ctx.organizer,
            outcome: 'success',
            attempt,
            durationMs: Date.now() - startedAt,
            windowUsed: recentCallTimes.length,
            at: new Date().toISOString(),
          })}`
        );
        return result;
      } catch (err: any) {
        lastErr = err;
        const reason = googleErrorReason(err);
        const willRetry = attempt < MAX_ATTEMPTS && isRetryableGoogleError(err);
        logger.warn(
          `[GoogleCalendar] ${JSON.stringify({
            operation: ctx.operation,
            sessionId: ctx.sessionId ?? null,
            eventId: ctx.eventId ?? null,
            organizer: ctx.organizer,
            outcome: willRetry ? 'retrying' : 'failed',
            attempt,
            reason,
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
        // Exponential backoff — 2s, 4s, 8s — with jitter so parallel bookings do
        // not resynchronise and collide on the retry. Google's own Retry-After
        // wins when it sends one.
        const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        const delay = retryAfterMs(err) ?? Math.round(backoff * (1 + Math.random() * 0.3));
        await sleep(delay);
      }
    }
    usage.failures += 1;
    throw lastErr;
  };

  // Chain onto the queue so calls leave in order and the spacing actually holds.
  const scheduled = queueTail.then(run, run);
  queueTail = scheduled.catch(() => undefined);
  return scheduled;
}

const clientFor = async (workspaceEmail: string) => {
  const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
  return google.calendar({ version: 'v3', auth });
};

export class GoogleCalendarService {
  /**
   * Create the event and its Meet room in ONE request.
   *
   * `conferenceDataVersion: 1` makes Google mint the room as part of the insert
   * and return it inline, so the Meet URL comes straight off this response.
   * There is deliberately no follow-up GET — that was the classic second call.
   */
  static async createMeetEvent(workspaceEmail: string, input: CalendarEventInput) {
    const calendar = await clientFor(workspaceEmail);

    // Unique per conference, and traceable back to the session it belongs to.
    // Reusing a requestId across unrelated meetings makes Google hand back the
    // FIRST conference instead of a new one — two classes in one room.
    const requestId = `session-${input.sessionId ?? 'adhoc'}-${crypto.randomUUID()}`;

    const event = {
      summary: input.title,
      description: input.description || '',
      start: { dateTime: input.startTime, timeZone: input.timezone },
      end: { dateTime: input.endTime, timeZone: input.timezone },
      attendees: input.attendees.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    };

    const response = await callCalendar(
      { operation: 'create', sessionId: input.sessionId, organizer: workspaceEmail },
      () =>
        calendar.events.insert({
          calendarId: 'primary',
          requestBody: event,
          conferenceDataVersion: 1,
          // Attendees are still on the event (they need it for Meet admission and
          // it shows in their own calendar), but Google does not email them.
          // Invitation email is the most aggressively throttled part of the
          // Calendar API, and the app already notifies both parties itself.
          sendUpdates: 'none',
        })
    );

    const createdEvent = response.data;
    const meetLink =
      createdEvent.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === 'video')?.uri || '';

    return {
      eventId: createdEvent.id || '',
      meetLink,
      calendarLink: createdEvent.htmlLink || '',
      conferenceId: createdEvent.conferenceData?.conferenceId || '',
      organizer: createdEvent.organizer?.email || workspaceEmail,
      attendees: (createdEvent.attendees?.map((a) => a.email).filter(Boolean) as string[]) || [],
    };
  }

  /**
   * Change an event in ONE request.
   *
   * This used to GET the event and send the whole thing back via `update`, purely
   * to avoid clearing fields it was not changing — two calls to alter one. `patch`
   * has those merge semantics built in, so the read is unnecessary.
   *
   * `conferenceDataVersion` is deliberately omitted (defaults to 0), which tells
   * Google to leave the conference alone: the Meet room and its code survive a
   * reschedule, which matters because recording filenames key off that code.
   */
  static async patchMeetEvent(
    workspaceEmail: string,
    eventId: string,
    input: CalendarEventPatch,
    sessionId?: string
  ) {
    const calendar = await clientFor(workspaceEmail);

    const requestBody: Record<string, unknown> = {};
    if (input.title !== undefined) requestBody.summary = input.title;
    if (input.description !== undefined) requestBody.description = input.description;
    if (input.startTime !== undefined) {
      requestBody.start = { dateTime: input.startTime, ...(input.timezone ? { timeZone: input.timezone } : {}) };
    }
    if (input.endTime !== undefined) {
      requestBody.end = { dateTime: input.endTime, ...(input.timezone ? { timeZone: input.timezone } : {}) };
    }
    if (input.attendees !== undefined) {
      requestBody.attendees = input.attendees.map((email) => ({ email }));
    }

    // Nothing Google cares about changed — do not spend a request saying so.
    if (Object.keys(requestBody).length === 0) {
      logger.info(
        `[GoogleCalendar] ${JSON.stringify({
          operation: 'patch',
          sessionId: sessionId ?? null,
          eventId,
          organizer: workspaceEmail,
          outcome: 'skipped',
          reason: 'no Google-facing fields changed',
          at: new Date().toISOString(),
        })}`
      );
      return { eventId, meetLink: '', calendarLink: '', attendees: [] as string[], skipped: true };
    }

    const response = await callCalendar(
      { operation: 'patch', sessionId, eventId, organizer: workspaceEmail },
      () =>
        calendar.events.patch({
          calendarId: 'primary',
          eventId,
          requestBody,
          sendUpdates: 'none',
        })
    );

    const updatedEvent = response.data;
    const meetLink =
      updatedEvent.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === 'video')?.uri || '';

    return {
      eventId: updatedEvent.id || '',
      meetLink,
      calendarLink: updatedEvent.htmlLink || '',
      attendees: (updatedEvent.attendees?.map((a) => a.email).filter(Boolean) as string[]) || [],
      skipped: false,
    };
  }

  /**
   * Is this calendar event still live on Google?
   *
   * Costs a request, so it is NOT called on the normal booking path any more —
   * our own cancel path marks the row CANCELLED, which makes the database the
   * cheaper and equally correct answer. This remains for the one case the DB
   * cannot know about: an event deleted by hand in Google's own UI.
   *
   * Returns null when the answer cannot be determined, so callers can decide
   * rather than assume.
   */
  static async isEventActive(workspaceEmail: string, eventId: string): Promise<boolean | null> {
    if (!eventId || eventId.startsWith('manual_')) return null;
    try {
      const calendar = await clientFor(workspaceEmail);
      const res = await callCalendar({ operation: 'get', eventId, organizer: workspaceEmail }, () =>
        calendar.events.get({ calendarId: 'primary', eventId })
      );
      return res.data.status !== 'cancelled';
    } catch (err: any) {
      if (err?.code === 404 || err?.response?.status === 404) return false;
      logger.warn(`[GoogleCalendarService] Could not read event ${eventId}: ${err.message}`);
      return null;
    }
  }

  static async deleteMeetEvent(workspaceEmail: string, eventId: string, sessionId?: string) {
    const calendar = await clientFor(workspaceEmail);

    await callCalendar({ operation: 'delete', sessionId, eventId, organizer: workspaceEmail }, () =>
      calendar.events.delete({
        calendarId: 'primary',
        eventId,
        sendUpdates: 'none',
      })
    );

    return { eventId, status: 'CANCELLED' };
  }
}
