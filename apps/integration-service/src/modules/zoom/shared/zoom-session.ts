import { ZoomAuthService } from '../auth/auth.service';
import { logger } from '@futurespark/logger';

export type ZoomMeetingLiveStatus = 'waiting' | 'started' | 'finished' | 'unknown';

export type EndZoomSessionResult = 'ended' | 'already_closed' | 'failed';

/**
 * Read Zoom's live state for a meeting. `null` = API unreachable.
 */
export const getMeetingZoomStatus = async (
  zoomMeetingId: string,
  hostEmail: string | null,
  organizerEmail: string
): Promise<ZoomMeetingLiveStatus | null> => {
  try {
    const token = await ZoomAuthService.getAccessToken(hostEmail || organizerEmail);
    const res = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(zoomMeetingId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status === 404) return 'finished';
      logger.warn(`[ZoomSession] status lookup ${zoomMeetingId} returned ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { status?: string };
    const status = String(data?.status ?? '').toLowerCase();
    if (status === 'started' || status === 'waiting' || status === 'finished') {
      return status as ZoomMeetingLiveStatus;
    }
    return 'unknown';
  } catch (err: any) {
    logger.warn(`[ZoomSession] status lookup failed for ${zoomMeetingId}: ${err.message}`);
    return null;
  }
};

export const isZoomMeetingLive = (status: ZoomMeetingLiveStatus | null): boolean => status === 'started';

/**
 * End the current live session for a meeting. The join URL survives.
 *
 * Never throws — callers decide how to surface failure.
 */
export const endZoomSession = async (meeting: {
  id?: string;
  zoomMeetingId: string | null;
  zoomHostEmail: string | null;
  organizerEmail: string;
}): Promise<EndZoomSessionResult> => {
  if (!meeting.zoomMeetingId) return 'failed';

  try {
    const token = await ZoomAuthService.getAccessToken(meeting.zoomHostEmail || meeting.organizerEmail);
    const res = await fetch(
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(meeting.zoomMeetingId)}/status`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'end' }),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (res.status === 204) {
      logger.info(
        `[ZoomSession] Ended live session for meeting ${meeting.id ?? meeting.zoomMeetingId} ` +
          `on host ${meeting.zoomHostEmail ?? meeting.organizerEmail}.`
      );
      return 'ended';
    }

    const body = await res.text().catch(() => '');
    if (res.status === 400) {
      logger.info(`[ZoomSession] Session for ${meeting.id ?? meeting.zoomMeetingId} was already closed.`);
      return 'already_closed';
    }

    logger.warn(
      `[ZoomSession] Could not end session for ${meeting.id ?? meeting.zoomMeetingId}: ${res.status} ${body.slice(0, 200)}`
    );
    return 'failed';
  } catch (err: any) {
    logger.warn(
      `[ZoomSession] End session failed for ${meeting.id ?? meeting.zoomMeetingId}: ${err?.message ?? err}`
    );
    return 'failed';
  }
};
