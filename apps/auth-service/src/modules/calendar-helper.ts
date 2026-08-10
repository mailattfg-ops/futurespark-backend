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
