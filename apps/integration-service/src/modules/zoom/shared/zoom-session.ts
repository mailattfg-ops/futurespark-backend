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
  organizerEmail: string,
  /** Pre-resolved token: callers inside a DB transaction must pass one (connection_limit=1). */
  token?: string
): Promise<ZoomMeetingLiveStatus | null> => {
  try {
    token ??= await ZoomAuthService.getAccessToken(hostEmail || organizerEmail);
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

/** Host-alone sessions sometimes report `waiting` while still holding the seat. */
export const isZoomMeetingOccupyingHost = (status: ZoomMeetingLiveStatus | null): boolean =>
  status === 'started' || status === 'waiting';

/**
 * Zoom's live-meeting list for a host seat. Empty when API fails or host is
 * alone in the room — callers should also probe known meeting ids directly.
 */
type ZoomParticipantRecord = {
  id?: string;
  user_id?: string;
  user_name?: string;
  leave_time?: string;
  status?: string;
};

const participantKey = (p: ZoomParticipantRecord): string =>
  String(p.user_id ?? p.id ?? p.user_name ?? '').trim();

/** Active in-room participants (no leave_time, not in waiting room). */
export const countActiveMeetingParticipants = (participants: ZoomParticipantRecord[] | undefined): number => {
  if (!Array.isArray(participants) || participants.length === 0) return 0;
  const active = participants.filter((p) => {
    if (p.leave_time) return false;
    const status = String(p.status ?? '').toLowerCase();
    return status !== 'in_waiting_room';
  });
  return new Set(active.map(participantKey).filter(Boolean)).size;
};

const fetchParticipantPage = async (
  url: string,
  token: string
): Promise<ZoomParticipantRecord[] | null> => {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn(`[ZoomSession] participants ${url} returned ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { participants?: ZoomParticipantRecord[] };
    return Array.isArray(data.participants) ? data.participants : [];
  } catch (err: any) {
    logger.warn(`[ZoomSession] participants ${url} failed: ${err.message}`);
    return null;
  }
};

/**
 * Count participants currently in a live session.
 *
 * Tries dashboard metrics first (live meetings), then the report API the product
 * team specified. Returns `null` when both endpoints are unavailable.
 */
export const getMeetingLiveParticipantCount = async (
  zoomMeetingId: string,
  hostEmail: string | null,
  organizerEmail: string
): Promise<number | null> => {
  try {
    const token = await ZoomAuthService.getAccessToken(hostEmail || organizerEmail);
    const encoded = encodeURIComponent(zoomMeetingId);

    const live = await fetchParticipantPage(
      `https://api.zoom.us/v2/metrics/meetings/${encoded}/participants?type=live&page_size=300`,
      token
    );
    if (live !== null) return countActiveMeetingParticipants(live);

    const report = await fetchParticipantPage(
      `https://api.zoom.us/v2/report/meetings/${encoded}/participants?page_size=300`,
      token
    );
    if (report !== null) return countActiveMeetingParticipants(report);

    return null;
  } catch (err: any) {
    logger.warn(`[ZoomSession] participant count for ${zoomMeetingId} failed: ${err.message}`);
    return null;
  }
};

export interface ZoomLiveMeeting {
  id: string;
  topic: string;
  /** When this live session actually started on Zoom (ISO), if reported. */
  startTime: string | null;
}

/** Meetings live on a host seat right now (needs meeting:read:list_meetings:admin). */
export const listHostLiveZoomMeetings = async (
  hostEmail: string,
  organizerEmail: string
): Promise<ZoomLiveMeeting[]> => {
  try {
    const token = await ZoomAuthService.getAccessToken(hostEmail || organizerEmail);
    const res = await fetch(
      `https://api.zoom.us/v2/users/${encodeURIComponent(hostEmail)}/meetings?type=live&page_size=50`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) {
      logger.warn(`[ZoomSession] live list for ${hostEmail} returned ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { meetings?: { id?: number | string; topic?: string; start_time?: string }[] };
    return (Array.isArray(data.meetings) ? data.meetings : [])
      .filter((m) => m.id !== undefined && m.id !== null)
      .map((m) => ({ id: String(m.id), topic: m.topic ?? '', startTime: m.start_time ?? null }));
  } catch (err: any) {
    logger.warn(`[ZoomSession] live list for ${hostEmail} failed: ${err.message}`);
    return [];
  }
};

export const listHostLiveZoomMeetingIds = async (hostEmail: string, organizerEmail: string): Promise<string[]> =>
  (await listHostLiveZoomMeetings(hostEmail, organizerEmail)).map((m) => m.id);

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
  /** Pre-resolved token: callers inside a DB transaction must pass one (connection_limit=1). */
  token?: string;
}): Promise<EndZoomSessionResult> => {
  if (!meeting.zoomMeetingId) return 'failed';

  try {
    const token = meeting.token ?? (await ZoomAuthService.getAccessToken(meeting.zoomHostEmail || meeting.organizerEmail));
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
