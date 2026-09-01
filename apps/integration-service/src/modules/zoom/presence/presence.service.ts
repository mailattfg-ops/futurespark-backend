import { db, withDbRetry } from '../../../database/datasource';
import { ZoomAuthService } from '../auth/auth.service';
import { logger } from '@futurespark/logger';
import { Semaphore } from '../../../utils/concurrency';

export const NO_SHOW_AFTER_MS = 30 * 60 * 1000;
export const EMPTY_GRACE_MS = parseInt(process.env.ZOOM_EMPTY_GRACE_MS || '120000', 10);
const WATCH_BEFORE_MS = 30 * 60 * 1000;
const WATCH_AFTER_MS = parseInt(process.env.ZOOM_WATCH_AFTER_MS || '3600000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.ZOOM_PRESENCE_POLL_MS || '30000', 10);
const MAX_CONCURRENT_PRESENCE_CALLS = parseInt(process.env.MAX_CONCURRENT_ZOOM_CALLS || '4', 10);

const presenceSemaphore = new Semaphore(MAX_CONCURRENT_PRESENCE_CALLS, 'zoom-presence');

const ZOOM_ID_RE = /\/j\/(\d+)/;

export function extractZoomMeetingId(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(ZOOM_ID_RE);
  if (match && match[1]) return match[1];
  const digits = url.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 11 ? digits : null;
}

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const reportedRooms = new Set<string>();

async function reportRoomEnded(meetUrl: string, endedAt: Date, title: string): Promise<void> {
  const key = `${meetUrl}|${endedAt.toISOString()}`;
  if (reportedRooms.has(key)) return;
  reportedRooms.add(key);

  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/schedules/internal/room-ended`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingLink: meetUrl, endedAt: endedAt.toISOString() }),
    });
    if (!res.ok) {
      reportedRooms.delete(key);
      logger.warn(`[ZoomPresence] auth-service rejected room-ended for "${title}": ${res.status}`);
      return;
    }
    const body: any = await res.json().catch(() => null);
    if (body?.data?.updated) {
      logger.info(`[ZoomPresence] "${title}" ended — class ${body.data.classId} marked as finished.`);
    }
  } catch (err: any) {
    reportedRooms.delete(key);
    logger.warn(`[ZoomPresence] Could not report room end for "${title}": ${err.message}`);
  }
}

export class ZoomPresenceService {
  /**
   * Queries Zoom REST API to check if meeting is currently active / started.
   */
  static async isMeetingActive(organizerEmail: string, zoomMeetingId: string): Promise<boolean | null> {
    try {
      const accessToken = await ZoomAuthService.getAccessToken(organizerEmail);
      const res = await fetch(`https://api.zoom.us/v2/meetings/${zoomMeetingId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        if (res.status === 404) return false;
        logger.warn(`[ZoomPresence] Zoom meeting lookup returned ${res.status}`);
        return null;
      }

      const data = await res.json();
      // status can be "waiting", "started", "finished"
      return data.status === 'started';
    } catch (err: any) {
      logger.warn(`[ZoomPresence] Failed to query Zoom status for ${zoomMeetingId}: ${err.message}`);
      return null;
    }
  }

  /**
   * The links of classes running around now, asked of auth-service.
   *
   * Empty on any failure: a room is then watched only by its own dates, which
   * is the behaviour that existed before this call - degraded, never broken.
   */
  static async activeClassLinks(): Promise<string[]> {
    try {
      const res = await fetch(`${AUTH_SERVICE_URL}/schedules/internal/active-links`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const body: any = await res.json().catch(() => null);
      return Array.isArray(body?.data) ? body.data.filter((l: unknown) => typeof l === 'string') : [];
    } catch (err: any) {
      logger.warn(`[ZoomPresence] Could not read active class links: ${err.message}`);
      return [];
    }
  }

  /**
   * Zoom meetings worth polling right now.
   *
   * Two ways in, unioned:
   *   1. the meeting's OWN slot is current - a room booked for this class;
   *   2. a class running now is using its link - a room reused across sessions,
   *      whose row still carries the date of the first class booked on it.
   *
   * (2) is why a reused room used to sit permanently on "cannot confirm anyone
   * joined": it never entered the window again after its first day.
   */
  static async getWatchWindowMeetings() {
    const now = Date.now();
    const windowStart = new Date(now - WATCH_AFTER_MS);
    const windowEnd = new Date(now + WATCH_BEFORE_MS);
    const activeLinks = await this.activeClassLinks();

    return withDbRetry(() =>
      db.meeting.findMany({
        where: {
          provider: 'ZOOM',
          status: { not: 'CANCELLED' },
          OR: [
            { AND: [{ startTime: { lte: windowEnd } }, { endTime: { gte: windowStart } }] },
            ...(activeLinks.length ? [{ meetUrl: { in: activeLinks } }] : []),
          ],
        },
      })
    );
  }

  /**
   * Polls every in-window Zoom meeting and updates live presence timestamps.
   */
  static async poll(): Promise<{ checked: number; live: number }> {
    const meetings = await this.getWatchWindowMeetings();
    if (meetings.length === 0) return { checked: 0, live: 0 };

    const now = new Date();
    let liveCount = 0;

    await Promise.all(
      meetings.map(meeting =>
        presenceSemaphore.run(async () => {
          const meetingId = meeting.zoomMeetingId || extractZoomMeetingId(meeting.meetUrl);
          if (!meetingId) return;

          const active = await this.isMeetingActive(meeting.organizerEmail, meetingId);
          if (active === null) return; // API error or transient network issue

          if (active) liveCount++;

          await withDbRetry(() =>
            db.meeting.update({
              where: { id: meeting.id },
              data: {
                presenceIsLive: active,
                presenceCheckedAt: now,
                ...(active ? { presenceLastLiveAt: now } : {}),
                ...(active && !meeting.presenceFirstJoinAt ? { presenceFirstJoinAt: now } : {}),
              },
            })
          );

          if (active && !meeting.presenceFirstJoinAt) {
            logger.info(`[ZoomPresence] First join detected for "${meeting.title}" (${meetingId})`);
          }

          // Check if meeting ended and room emptied past grace period
          if (!active && meeting.presenceFirstJoinAt && meeting.presenceLastLiveAt) {
            const emptyFor = now.getTime() - new Date(meeting.presenceLastLiveAt).getTime();
            if (emptyFor >= EMPTY_GRACE_MS) {
              await reportRoomEnded(meeting.meetUrl, new Date(meeting.presenceLastLiveAt), meeting.title);
            }
          }
        })
      )
    );

    return { checked: meetings.length, live: liveCount };
  }

  /**
   * Returns current presence snapshot for all active Zoom meetings.
   */
  static async getPresenceSnapshot(): Promise<Record<string, any>> {
    const meetings = await this.getWatchWindowMeetings();
    const result: Record<string, any> = {};

    for (const m of meetings) {
      const code = m.zoomMeetingId || extractZoomMeetingId(m.meetUrl) || m.id;
      result[code] = {
        meetingId: m.id,
        meetUrl: m.meetUrl,
        title: m.title,
        startTime: m.startTime,
        endTime: m.endTime,
        isLive: m.presenceIsLive,
        firstJoinAt: m.presenceFirstJoinAt,
        lastLiveAt: m.presenceLastLiveAt,
        checkedAt: m.presenceCheckedAt,
      };
    }

    return result;
  }
}

let presenceInterval: NodeJS.Timeout | null = null;

export function startZoomPresencePolling() {
  if (presenceInterval) return;

  const run = async () => {
    try {
      const { checked, live } = await ZoomPresenceService.poll();
      if (checked > 0) {
        logger.info(`[ZoomPresence] Polled ${checked} in-window Zoom meeting(s) — ${live} live.`);
      }
    } catch (err: any) {
      logger.warn(`[ZoomPresence] Polling error: ${err.message}`);
    }
  };

  presenceInterval = setInterval(run, POLL_INTERVAL_MS);
  setTimeout(run, 5000); // Initial check 5s after startup
}
