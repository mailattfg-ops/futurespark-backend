import { db, withDbRetry } from '../../../database/datasource';
import { emailKey } from '../hosts/hosts.service';
import { existingMeetingPayload } from '../host-buffer/host-buffer';
import {
  endZoomSession,
  getMeetingZoomStatus,
  isZoomMeetingLive,
} from '../shared/zoom-session';
import { ZoomServiceError } from './meetings.service';
import { logger } from '@futurespark/logger';

/**
 * After scheduled endTime, wait this long before we may force-end a ghost session.
 * Default 30 minutes — ZOOM_JOIN_GRACE_MINUTES.
 */
export const DEFAULT_JOIN_GRACE_MS = 30 * 60 * 1000;

export const resolveJoinGraceMs = (override?: number): number => {
  if (override !== undefined) return Math.max(0, override);
  const raw = process.env.ZOOM_JOIN_GRACE_MINUTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_JOIN_GRACE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_JOIN_GRACE_MS;
  return Math.round(minutes * 60_000);
};

type MeetingRow = {
  id: string;
  provider: string;
  zoomMeetingId: string | null;
  zoomJoinUrl: string | null;
  meetUrl: string;
  zoomHostEmail: string | null;
  organizerEmail: string;
  title: string;
  startTime: Date;
  endTime: Date;
  status: string;
  presenceIsLive: boolean;
  presenceLastLiveAt: Date | null;
};

export type PrepareJoinAction = 'none' | 'force_ended';

export interface PrepareJoinResult {
  joinUrl: string;
  meetLink: string;
  meetingId: string;
  action: PrepareJoinAction;
  /** Set when a stale session was ended on the host seat. */
  forcedMeetingId?: string;
  forcedZoomMeetingId?: string;
}

const joinUrlOf = (row: MeetingRow): string => row.zoomJoinUrl || row.meetUrl;

const findMeetingByLink = async (joinUrl: string): Promise<MeetingRow | null> => {
  const trimmed = joinUrl.trim();
  return withDbRetry(() =>
    db.meeting.findFirst({
      where: {
        provider: 'ZOOM',
        status: { not: 'CANCELLED' },
        OR: [{ meetUrl: trimmed }, { zoomJoinUrl: trimmed }],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        provider: true,
        zoomMeetingId: true,
        zoomJoinUrl: true,
        meetUrl: true,
        zoomHostEmail: true,
        organizerEmail: true,
        title: true,
        startTime: true,
        endTime: true,
        status: true,
        presenceIsLive: true,
        presenceLastLiveAt: true,
      },
    })
  );
};

/**
 * May we force-end a ghost session on this row?
 *
 * Requires:
 *   1. Scheduled end was at least `graceMs` ago.
 *   2. Room is not marked live locally (everyone left; mentor forgot "End for all").
 */
export const mayForceEndGhostSession = (
  meeting: Pick<MeetingRow, 'endTime' | 'presenceIsLive' | 'presenceLastLiveAt'>,
  now: Date,
  graceMs = resolveJoinGraceMs()
): boolean => {
  if (now.getTime() < meeting.endTime.getTime() + graceMs) return false;
  if (meeting.presenceIsLive) return false;
  // Recent activity after scheduled end → treat as still in use.
  if (
    meeting.presenceLastLiveAt &&
    meeting.presenceLastLiveAt.getTime() > meeting.endTime.getTime() &&
    now.getTime() - meeting.presenceLastLiveAt.getTime() < graceMs
  ) {
    return false;
  }
  return true;
};

const graceEndsAt = (endTime: Date, graceMs: number): Date =>
  new Date(endTime.getTime() + graceMs);

const buildJoinPayload = (target: MeetingRow, action: PrepareJoinAction, extra?: Partial<PrepareJoinResult>): PrepareJoinResult => {
  const link = joinUrlOf(target);
  return {
    joinUrl: link,
    meetLink: link,
    meetingId: target.id,
    action,
    ...extra,
  };
};

const throwHostBusy = (
  target: MeetingRow,
  blocker: MeetingRow,
  graceMs: number,
  now: Date,
  zoomLive: boolean
): never => {
  const endsAt = graceEndsAt(blocker.endTime, graceMs);
  const gapMin = Math.round(graceMs / 60_000);
  throw new ZoomServiceError(
    'ZOOM_JOIN_HOST_BUSY',
    zoomLive && now.getTime() < endsAt.getTime()
      ? `The Zoom host is still running an earlier meeting. Joining may fail until ${gapMin} minutes after that ` +
        `session's scheduled end (${endsAt.toISOString()}). You can try anyway.`
      : `The Zoom host seat may still be busy from an earlier session. Joining might fail — try anyway if you need to.`,
    {
      joinUrl: joinUrlOf(target),
      meetLink: joinUrlOf(target),
      meetingId: target.id,
      graceMinutes: gapMin,
      graceEndsAt: endsAt.toISOString(),
      hostStillLiveOnZoom: zoomLive,
      blockingMeeting: existingMeetingPayload(blocker),
      tryAnyway: true,
    }
  );
};

/**
 * Prepare a join for `joinUrl` (link4 in the scenario doc).
 *
 *   • Host clear → 200, action `none`, link4
 *   • Ghost session past end+grace and inactive → force-end, 200, action `force_ended`, link4
 *   • Still inside grace or room still active → 409, link4 in errors (frontend: warn + try anyway)
 */
export const prepareJoin = async (joinUrl: string): Promise<PrepareJoinResult> => {
  if (!joinUrl?.trim()) {
    throw new ZoomServiceError('ZOOM_VALIDATION', 'joinUrl is required.');
  }

  const target = await findMeetingByLink(joinUrl);
  if (!target?.zoomMeetingId || !target.zoomHostEmail) {
    throw new ZoomServiceError('ZOOM_NOT_FOUND', 'No active Zoom meeting matched that join link.');
  }

  const now = new Date();
  const graceMs = resolveJoinGraceMs();
  const hostKey = emailKey(target.zoomHostEmail);

  const targetStatus = await getMeetingZoomStatus(
    target.zoomMeetingId,
    target.zoomHostEmail,
    target.organizerEmail
  );

  // Same room still live on Zoom — either this class or a ghost from a prior session.
  if (isZoomMeetingLive(targetStatus)) {
    if (mayForceEndGhostSession(target, now, graceMs)) {
      const result = await endZoomSession(target);
      if (result === 'ended' || result === 'already_closed') {
        return buildJoinPayload(target, 'force_ended', {
          forcedMeetingId: target.id,
          forcedZoomMeetingId: target.zoomMeetingId,
        });
      }
      throwHostBusy(target, target, graceMs, now, true);
    }

    // Inside scheduled window or grace — joining the live room is expected.
    if (now.getTime() <= target.endTime.getTime() + graceMs) {
      return buildJoinPayload(target, 'none');
    }

    // Past grace but still live (people still in room) — warn, still return link for try-anyway flow.
    if (target.presenceIsLive) {
      throwHostBusy(target, target, graceMs, now, true);
    }

    return buildJoinPayload(target, 'none');
  }

  // Host may be held by a *different* Zoom meeting on the same seat.
  const hostMeetings = await withDbRetry(() =>
    db.meeting.findMany({
      where: {
        provider: 'ZOOM',
        status: { not: 'CANCELLED' },
        zoomHostEmail: { equals: target.zoomHostEmail, mode: 'insensitive' },
        zoomMeetingId: { not: null },
        id: { not: target.id },
      },
      select: {
        id: true,
        provider: true,
        zoomMeetingId: true,
        zoomJoinUrl: true,
        meetUrl: true,
        zoomHostEmail: true,
        organizerEmail: true,
        title: true,
        startTime: true,
        endTime: true,
        status: true,
        presenceIsLive: true,
        presenceLastLiveAt: true,
      },
      orderBy: { endTime: 'desc' },
      take: 20,
    })
  );

  const seenZoomIds = new Set<string>();
  for (const candidate of hostMeetings) {
    if (!candidate.zoomMeetingId) continue;
    const zid = candidate.zoomMeetingId;
    if (seenZoomIds.has(zid)) continue;
    seenZoomIds.add(zid);

    const live = await getMeetingZoomStatus(zid, candidate.zoomHostEmail, candidate.organizerEmail);
    if (!isZoomMeetingLive(live)) continue;

    logger.info(
      `[PrepareJoin] Host ${hostKey} is live on meeting ${zid} ("${candidate.title}") ` +
        `while user is joining ${target.id}.`
    );

    if (mayForceEndGhostSession(candidate, now, graceMs)) {
      const result = await endZoomSession(candidate);
      if (result === 'ended' || result === 'already_closed') {
        return buildJoinPayload(target, 'force_ended', {
          forcedMeetingId: candidate.id,
          forcedZoomMeetingId: zid,
        });
      }
    }

    throwHostBusy(target, candidate, graceMs, now, true);
  }

  return buildJoinPayload(target, 'none');
};
