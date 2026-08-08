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
}

/**
 * Google answers a burst of writes with 403 rateLimitExceeded / usageLimits or
 * 429, and those clear on their own within seconds. Booking a 12-session
 * programme fires twelve creates back to back, so without this the whole
 * booking failed on a limit that had already lifted by the time the user read
 * the error.
 *
 * Only retries limit errors — a bad token or malformed event is returned
 * immediately, since repeating those just burns more quota.
 */
const RETRYABLE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'backendError',
]);

const isRetryableGoogleError = (err: any): boolean => {
  const status = err?.code ?? err?.response?.status;
  if (status === 429 || status === 500 || status === 503) return true;
  if (status !== 403) return false;
  const errors = err?.errors ?? err?.response?.data?.error?.errors ?? [];
  if (errors.some((e: any) => RETRYABLE_REASONS.has(e?.reason))) return true;
  // Some quota rejections arrive with only the human-readable message.
  return /usage limits|rate limit|quota/i.test(err?.message ?? '');
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withCalendarRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt === attempts || !isRetryableGoogleError(err)) throw err;
      // Exponential backoff with jitter, so parallel bookings do not resynchronise
      // and collide on the retry.
      const delay = Math.round(500 * 2 ** (attempt - 1) * (1 + Math.random() * 0.4));
      logger.warn(
        `[GoogleCalendar] ${label} hit a rate limit (attempt ${attempt}/${attempts}). ` +
        `Retrying in ${delay}ms — ${err.message}`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

export class GoogleCalendarService {
  static async createMeetEvent(workspaceEmail: string, input: CalendarEventInput) {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const calendar = google.calendar({ version: 'v3', auth });

    const event = {
      summary: input.title,
      description: input.description || '',
      start: {
        dateTime: input.startTime,
        timeZone: input.timezone,
      },
      end: {
        dateTime: input.endTime,
        timeZone: input.timezone,
      },
      attendees: input.attendees.map(email => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: {
            type: 'hangoutsMeet',
          },
        },
      },
    };

    const response = await withCalendarRetry('createMeetEvent', () =>
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
    const meetLink = createdEvent.conferenceData?.entryPoints?.find(
      ep => ep.entryPointType === 'video'
    )?.uri || '';

    return {
      eventId: createdEvent.id || '',
      meetLink,
      calendarLink: createdEvent.htmlLink || '',
      conferenceId: createdEvent.conferenceData?.conferenceId || '',
      organizer: createdEvent.organizer?.email || workspaceEmail,
      attendees: createdEvent.attendees?.map(a => a.email).filter(Boolean) as string[] || [],
    };
  }

  static async updateMeetEvent(workspaceEmail: string, eventId: string, input: Partial<CalendarEventInput>) {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const calendar = google.calendar({ version: 'v3', auth });

    // Fetch existing event first to keep untouched fields
    const getResponse = await calendar.events.get({
      calendarId: 'primary',
      eventId,
    });
    const currentEvent = getResponse.data;

    const updatedRequestBody = {
      ...currentEvent,
      ...(input.title ? { summary: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.startTime || input.timezone
        ? {
            start: {
              dateTime: input.startTime || currentEvent.start?.dateTime || undefined,
              timeZone: input.timezone || currentEvent.start?.timeZone || undefined,
            },
          }
        : {}),
      ...(input.endTime || input.timezone
        ? {
            end: {
              dateTime: input.endTime || currentEvent.end?.dateTime || undefined,
              timeZone: input.timezone || currentEvent.end?.timeZone || undefined,
            },
          }
        : {}),
      ...(input.attendees
        ? { attendees: input.attendees.map(email => ({ email })) }
        : {}),
    };

    const response = await withCalendarRetry('updateMeetEvent', () =>
      calendar.events.update({
        calendarId: 'primary',
        eventId,
        requestBody: updatedRequestBody,
        sendUpdates: 'none',
      })
    );

    const updatedEvent = response.data;
    const meetLink = updatedEvent.conferenceData?.entryPoints?.find(
      ep => ep.entryPointType === 'video'
    )?.uri || '';

    return {
      eventId: updatedEvent.id || '',
      meetLink,
      calendarLink: updatedEvent.htmlLink || '',
      attendees: updatedEvent.attendees?.map(a => a.email).filter(Boolean) as string[] || [],
    };
  }

  /**
   * Is this calendar event still live on Google?
   *
   * Our Meeting row can say SCHEDULED while the event has been cancelled on
   * Google — deleting a class cancels the event but leaves our row behind. A
   * cancelled event still has a working Meet room, but Meet no longer names the
   * recording after it (you get "abc-defg-hij (2026-08-06 14:32 GMT+5:30)"
   * instead of the class title), and attendees see it cancelled in their calendar.
   *
   * Returns null when the answer cannot be determined, so callers can decide
   * rather than assume.
   */
  static async isEventActive(workspaceEmail: string, eventId: string): Promise<boolean | null> {
    if (!eventId || eventId.startsWith('manual_')) return null;
    try {
      const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
      const calendar = google.calendar({ version: 'v3', auth });
      const res = await calendar.events.get({ calendarId: 'primary', eventId });
      return res.data.status !== 'cancelled';
    } catch (err: any) {
      if (err?.code === 404 || err?.response?.status === 404) return false;
      logger.warn(`[GoogleCalendarService] Could not read event ${eventId}: ${err.message}`);
      return null;
    }
  }

  static async deleteMeetEvent(workspaceEmail: string, eventId: string) {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const calendar = google.calendar({ version: 'v3', auth });

    await withCalendarRetry('deleteMeetEvent', () =>
      calendar.events.delete({
        calendarId: 'primary',
        eventId,
        sendUpdates: 'none',
      })
    );

    return { eventId, status: 'CANCELLED' };
  }
}
