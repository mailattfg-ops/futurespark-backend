import { logger } from '@futurespark/logger';

const INTEGRATION_SERVICE_URL = process.env.INTEGRATION_SERVICE_URL || 'http://localhost:3006';

/**
 * Move the Google Calendar event behind a class after it is rescheduled.
 *
 * auth-service owns the schedule; the Calendar event lives in integration-service.
 * Without this the two drift apart: the class row says 12:10 while the calendar
 * invite (and the timestamp Meet writes into the recording filename) still says
 * 12:30. Attendees see the old slot, and recording matching keys off the stale time.
 *
 * Best-effort and non-blocking — a calendar hiccup must not fail the reschedule
 * itself, but it is logged loudly because the two stores are now out of step.
 */
export const rescheduleCalendarEvent = async (
  meetingLink: string | null | undefined,
  startTime: Date,
  endTime: Date,
  timezone?: string
): Promise<void> => {
  if (!meetingLink) return;

  try {
    const res = await fetch(`${INTEGRATION_SERVICE_URL}/google/meetings/by-link`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetUrl: meetingLink,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        timezone,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error(
        `[Calendar Helper] Could not move the Calendar event for ${meetingLink}: ${res.status} ${errText.slice(0, 200)}. ` +
        `The class time and the Google Calendar invite are now out of sync.`
      );
      return;
    }

    logger.info(`[Calendar Helper] Calendar event moved to ${startTime.toISOString()} for ${meetingLink}`);
  } catch (err: any) {
    logger.error(
      `[Calendar Helper] integration-service unreachable while rescheduling ${meetingLink}: ${err.message}. ` +
      `The class time and the Google Calendar invite are now out of sync.`
    );
  }
};
