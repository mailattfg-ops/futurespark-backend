import { logger } from '@futurespark/logger';

const INTEGRATION_SERVICE_URL = process.env.INTEGRATION_SERVICE_URL || 'http://localhost:3006';

/**
 * Move the Google Calendar or Zoom event behind a class after it is rescheduled.
 */
export const rescheduleCalendarEvent = async (
  meetingLink: string | null | undefined,
  startTime: Date,
  endTime: Date,
  timezone?: string
): Promise<void> => {
  if (!meetingLink) return;

  const isZoom = meetingLink.includes('zoom.us');
  const endpoint = isZoom
    ? `${INTEGRATION_SERVICE_URL}/zoom/meetings/by-link`
    : `${INTEGRATION_SERVICE_URL}/google/meetings/by-link`;

  const payloadKey = isZoom ? 'zoomUrl' : 'meetUrl';

  try {
    const res = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        [payloadKey]: meetingLink,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        timezone,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error(
        `[Meeting Helper] Could not move meeting for ${meetingLink}: ${res.status} ${errText.slice(0, 200)}.`
      );
      return;
    }

    logger.info(`[Meeting Helper] Meeting moved to ${startTime.toISOString()} for ${meetingLink}`);
  } catch (err: any) {
    logger.error(
      `[Meeting Helper] integration-service unreachable while rescheduling ${meetingLink}: ${err.message}`
    );
  }
};

/**
 * Tell integration-service that a mentor has signed a class off.
 *
 * This is what starts the recording clock. integration-service cannot see
 * `ScheduledClass` — different database — so until this call lands it has no way
 * to distinguish "the booked slot has passed" from "the class actually happened
 * and is finished". The old sweep used the former and searched Drive every two
 * minutes for 48 hours per meeting; now it searches once, after the class is
 * genuinely over and Google has had time to publish.
 *
 * Best-effort by design: a failure here must never stop a mentor closing out a
 * class. The report cron re-drives it, so a missed call self-heals.
 */
export const markMeetingClassCompleted = async (input: {
  meetingLink?: string | null;
  studentId?: string | null;
  sessionId?: string | null;
  programId?: string | null;
  startTime?: Date | null;
  completedAt?: Date | null;
}): Promise<boolean> => {
  if (!input.meetingLink && !(input.studentId && input.sessionId)) return false;

  try {
    const res = await fetch(`${INTEGRATION_SERVICE_URL}/classes/completed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingLink: input.meetingLink ?? undefined,
        studentId: input.studentId ?? undefined,
        sessionId: input.sessionId ?? undefined,
        programId: input.programId ?? undefined,
        startTime: input.startTime ? input.startTime.toISOString() : undefined,
        completedAt: (input.completedAt ?? new Date()).toISOString(),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.warn(
        `[Meeting Helper] Could not record class completion for ${input.meetingLink ?? 'unknown link'}: ` +
          `${res.status} ${errText.slice(0, 200)}. The report cron will retry.`
      );
      return false;
    }

    const body = (await res.json().catch(() => ({}))) as any;
    const matched = Boolean(body?.data?.matched);
    if (!matched) {
      logger.warn(
        `[Meeting Helper] integration-service found no meeting for the completed class ` +
          `(student ${input.studentId ?? '-'}, session ${input.sessionId ?? '-'}). ` +
          'No recording will be searched — the parent report will go out without one.'
      );
    }
    return matched;
  } catch (err: any) {
    logger.warn(
      `[Meeting Helper] integration-service unreachable while recording class completion: ${err.message}. ` +
        'The report cron will retry.'
    );
    return false;
  }
};

/**
 * Delete or cancel a meeting event behind a class when cancelled.
 */
export const deleteMeetingByLink = async (
  meetingLink: string | null | undefined
): Promise<void> => {
  if (!meetingLink) return;

  const isZoom = meetingLink.includes('zoom.us');
  const endpoint = isZoom
    ? `${INTEGRATION_SERVICE_URL}/zoom/meetings/by-link?zoomUrl=${encodeURIComponent(meetingLink)}`
    : `${INTEGRATION_SERVICE_URL}/google/meetings/by-link?meetUrl=${encodeURIComponent(meetingLink)}`;

  try {
    const res = await fetch(endpoint, { method: 'DELETE' });
    if (!res.ok) {
      const errText = await res.text();
      logger.warn(`[Meeting Helper] Could not cancel meeting for ${meetingLink}: ${res.status} ${errText.slice(0, 200)}`);
      return;
    }
    logger.info(`[Meeting Helper] Meeting cancelled successfully for ${meetingLink}`);
  } catch (err: any) {
    logger.warn(`[Meeting Helper] integration-service unreachable while cancelling ${meetingLink}: ${err.message}`);
  }
};
