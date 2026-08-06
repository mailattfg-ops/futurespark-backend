import { google } from 'googleapis';
import { db, withDbRetry } from '../../../database/datasource';
import { GoogleAuthService } from '../auth/auth.service';
import { logger } from '@futurespark/logger';
import { Semaphore } from '../../../utils/concurrency';

/**
 * Live Meet presence tracking.
 *
 * The join link opens 30 minutes before a class starts, so "the clock says it's
 * 10:05" tells you nothing about whether anyone actually turned up. This polls
 * the Meet REST API for each meeting whose window is open and records whether a
 * conference is genuinely active, plus the first moment anyone was ever seen.
 *
 * That first-join timestamp is what lets the dashboard distinguish:
 *   - in progress            → someone is in the room now
 *   - waiting                → window open, nobody yet, still early
 *   - no-show                → NO_SHOW_AFTER_MS past start and nobody ever joined
 */

// A class is only a confirmed no-show once its allocated time has run out. Up to
// the scheduled end the room is still open and someone can still arrive, so the
// dashboard holds a blinking "waiting" alert rather than declaring failure early.
export const NO_SHOW_AFTER_MS = 30 * 60 * 1000; // retained for display copy only

// How long the room must stay empty after people attended before the class is
// called finished. Classes are scheduled for 90 min but often wrap early, so an
// empty room means "done" — the grace period just stops a mentor's Wi-Fi blip
// from briefly reporting a live class as completed.
export const EMPTY_GRACE_MS = parseInt(process.env.MEET_EMPTY_GRACE_MS || '120000', 10);

// Start watching this far before the scheduled start (matches the join window).
const WATCH_BEFORE_MS = 30 * 60 * 1000;
// Keep watching this far past the scheduled end. Covers classes that run over,
// and keeps a confirmed no-show visible on the dashboard long enough to be acted on.
const WATCH_AFTER_MS = parseInt(process.env.MEET_WATCH_AFTER_MS || '3600000', 10);

const POLL_INTERVAL_MS = parseInt(process.env.MEET_PRESENCE_POLL_MS || '30000', 10);
const MAX_CONCURRENT_PRESENCE_CALLS = parseInt(process.env.MAX_CONCURRENT_PRESENCE_CALLS || '4', 10);

const presenceSemaphore = new Semaphore(MAX_CONCURRENT_PRESENCE_CALLS, 'meet-presence');

const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** Pull the 3-4-3 room code out of a Meet URL. */
export function extractMeetCode(meetUrl: string | null | undefined): string | null {
  if (!meetUrl) return null;
  const code = meetUrl.trim().split('?')[0].split('#')[0].split('/').pop() || '';
  return MEET_CODE_RE.test(code) ? code : null;
}

export class MeetPresenceService {
  /**
   * Ask Meet whether a conference is currently active in this room.
   * Returns null when the answer is unknown (auth/API failure) so callers can
   * leave the previous state alone rather than falsely reporting "empty".
   */
  static async isConferenceActive(workspaceEmail: string, meetCode: string): Promise<boolean | null> {
    try {
      const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
      const token = await auth.getAccessToken();
      const accessToken = typeof token === 'string' ? token : token?.token;
      if (!accessToken) throw new Error('No access token available for Meet API');

      const res = await fetch(`https://meet.googleapis.com/v2/spaces/${meetCode}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        const body = await res.text();
        logger.warn(`[MeetPresence] spaces.get ${meetCode} → HTTP ${res.status}: ${body.slice(0, 200)}`);
        return null;
      }

      const space = (await res.json()) as { activeConference?: { conferenceRecord?: string } };
      return Boolean(space.activeConference?.conferenceRecord);
    } catch (err: any) {
      logger.warn(`[MeetPresence] Presence check failed for ${meetCode}: ${err.message}`);
      return null;
    }
  }

  /**
   * Meetings whose join window is currently open.
   *
   * Status is deliberately NOT filtered. A Meet room keeps working after its
   * calendar event is cancelled, and people do still join it — so excluding
   * cancelled meetings blinded the poller to exactly those rooms. The dashboard
   * then lost presence for a class that was genuinely running and fell back to
   * the clock, which reports "playing" whether or not anyone is there.
   *
   * Reading presence is cheap and read-only; knowing the truth about a room that
   * is being used matters more than skipping a few polls.
   */
  static async getWatchWindowMeetings() {
    const now = Date.now();
    return withDbRetry(() =>
      db.meeting.findMany({
        where: {
          startTime: { lte: new Date(now + WATCH_BEFORE_MS) },
          endTime: { gte: new Date(now - WATCH_AFTER_MS) },
        },
        take: 100,
      })
    );
  }

  /** Poll every in-window meeting and persist what we saw. */
  static async pollOnce(): Promise<{ checked: number; live: number }> {
    const meetings = await MeetPresenceService.getWatchWindowMeetings();
    if (meetings.length === 0) return { checked: 0, live: 0 };

    let live = 0;
    let checked = 0;

    await Promise.all(
      meetings.map((meeting) =>
        presenceSemaphore.run(async () => {
          const code = extractMeetCode(meeting.meetUrl);
          if (!code) return;

          const active = await MeetPresenceService.isConferenceActive(meeting.organizerEmail, code);
          checked++;
          // Unknown result — leave prior state untouched rather than flipping to
          // "empty" and triggering a false no-show alert on a transient API blip.
          if (active === null) return;
          if (active) live++;

          const now = new Date();
          await withDbRetry(() =>
            db.meeting.update({
              where: { id: meeting.id },
              data: {
                presenceIsLive: active,
                presenceCheckedAt: now,
                ...(active ? { presenceLastLiveAt: now } : {}),
                // Only stamp the first-ever join once.
                ...(active && !meeting.presenceFirstJoinAt ? { presenceFirstJoinAt: now } : {}),
              },
            })
          );

          if (active && !meeting.presenceFirstJoinAt) {
            logger.info(`[MeetPresence] First join detected for "${meeting.title}" (${code})`);
          }
        })
      )
    );

    return { checked, live };
  }

  /**
   * Presence for the dashboard, keyed by Meet code so the frontend can match on
   * meetingLink without needing integration-service's meeting IDs.
   */
  static async getPresenceSnapshot() {
    const meetings = await MeetPresenceService.getWatchWindowMeetings();
    const now = Date.now();

    return meetings
      .map((m) => {
        const code = extractMeetCode(m.meetUrl);
        if (!code) return null;
        const startedMsAgo = now - new Date(m.startTime).getTime();
        const allocatedTimeOver = now >= new Date(m.endTime).getTime();
        return {
          meetCode: code,
          meetUrl: m.meetUrl,
          title: m.title,
          isLive: m.presenceIsLive,
          everJoined: Boolean(m.presenceFirstJoinAt),
          firstJoinAt: m.presenceFirstJoinAt,
          lastLiveAt: m.presenceLastLiveAt,
          checkedAt: m.presenceCheckedAt,
          // Started long enough ago, and not one person has ever appeared.
          // Confirmed no-show only once the allocated slot has fully elapsed.
          noShow: !m.presenceFirstJoinAt && allocatedTimeOver,
          // How long the slot has been running with nobody in it — drives the
          // "started Xm ago, nobody has joined" copy on the blinking alert.
          waitingMs: !m.presenceFirstJoinAt && startedMsAgo > 0 ? startedMsAgo : 0,
          noShowAfterMs: NO_SHOW_AFTER_MS,
          emptyGraceMs: EMPTY_GRACE_MS,
        };
      })
      .filter(Boolean);
  }
}

// ── Poller ───────────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

export function startPresencePolling(): void {
  if (pollTimer) return;

  logger.info(`[MeetPresence] Starting live presence poller (every ${POLL_INTERVAL_MS / 1000}s)`);

  const tick = async () => {
    // Same re-entrancy guard as the sync cron — a slow sweep must not overlap itself.
    if (isPolling) {
      logger.warn('[MeetPresence] Previous poll still running — skipping this tick.');
      return;
    }
    isPolling = true;
    try {
      const { checked, live } = await MeetPresenceService.pollOnce();
      if (checked > 0) {
        logger.info(`[MeetPresence] Polled ${checked} in-window meeting(s) — ${live} live.`);
      }
    } catch (err: any) {
      logger.error(`[MeetPresence] Poll failed: ${err.message}`);
    } finally {
      isPolling = false;
    }
  };

  setTimeout(tick, 8000);
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}
