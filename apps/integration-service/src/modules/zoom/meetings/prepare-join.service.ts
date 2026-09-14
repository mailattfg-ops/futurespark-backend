import { db, withDbRetry } from '../../../database/datasource';
import { emailKey } from '../hosts/hosts.service';
import { existingMeetingPayload } from '../host-buffer/host-buffer';
import {
  endZoomSession,
  getMeetingLiveParticipantCount,
  getMeetingZoomStatus,
  isZoomMeetingOccupyingHost,
  listHostLiveZoomMeetingIds,
  type ZoomMeetingLiveStatus,
} from '../shared/zoom-session';
import { ZoomServiceError } from './meetings.service';
import { logger } from '@futurespark/logger';

/**
 * After scheduled endTime, wait this long before we warn (not before we try to
 * clear a *different* meeting id on the same seat). ZOOM_JOIN_GRACE_MINUTES.
 */
export const DEFAULT_JOIN_GRACE_MS = 30 * 60 * 1000;

/** How early before startTime a join is allowed. ZOOM_JOIN_EARLY_MINUTES. */
export const DEFAULT_JOIN_EARLY_MS = 10 * 60 * 1000;

export const resolveJoinGraceMs = (override?: number): number => {
  if (override !== undefined) return Math.max(0, override);
  const raw = process.env.ZOOM_JOIN_GRACE_MINUTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_JOIN_GRACE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_JOIN_GRACE_MS;
  return Math.round(minutes * 60_000);
};

export const resolveJoinEarlyMs = (override?: number): number => {
  if (override !== undefined) return Math.max(0, override);
  const raw = process.env.ZOOM_JOIN_EARLY_MINUTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_JOIN_EARLY_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_JOIN_EARLY_MS;
  return Math.round(minutes * 60_000);
};

export type MeetingPresenceRow = {
  startTime: Date;
  endTime: Date;
  presenceIsLive: boolean;
  presenceFirstJoinAt: Date | null;
};

type MeetingRow = MeetingPresenceRow & {
  id: string;
  provider: string;
  zoomMeetingId: string | null;
  zoomJoinUrl: string | null;
  meetUrl: string;
  zoomHostEmail: string | null;
  organizerEmail: string;
  title: string;
  status: string;
  presenceLastLiveAt: Date | null;
};

export type PrepareJoinAction = 'none' | 'force_ended';

export interface PrepareJoinResult {
  joinUrl: string;
  meetLink: string;
  meetingId: string;
  action: PrepareJoinAction;
  forcedMeetingId?: string;
  forcedZoomMeetingId?: string;
}

const meetingSelect = {
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
  presenceFirstLiveAt: true,
  presenceFirstJoinAt: true,
  presenceLastLiveAt: true,
} as const;

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
      select: meetingSelect,
    })
  );
};

/**
 * A reused Zoom room is still "started" on Zoom from the PREVIOUS class.
 * Joining now would drop user4 into user1's session.
 */
export const isGhostSessionOnTarget = (
  target: MeetingPresenceRow,
  now: Date,
  earlyMs = resolveJoinEarlyMs(),
  graceMs = resolveJoinGraceMs()
): boolean => {
  const windowStart = target.startTime.getTime() - earlyMs;
  const windowEnd = target.endTime.getTime() + graceMs;

  // Live before this class's join window opens → prior session ghost.
  if (now.getTime() < windowStart) return true;

  // First join on file predates this class's window → presence is from user1.
  if (target.presenceFirstJoinAt && target.presenceFirstJoinAt.getTime() < windowStart) {
    return true;
  }

  // Scheduled slot ended; Zoom still up with an empty room → ghost.
  if (now.getTime() > target.endTime.getTime() && !target.presenceIsLive) {
    return true;
  }

  // Well past grace with nobody marked in-room → ghost.
  if (now.getTime() > windowEnd && !target.presenceIsLive) {
    return true;
  }

  return false;
};

/** @deprecated Use {@link isGhostSessionOnTarget} — kept for existing checks. */
export const mayForceEndGhostSession = (
  meeting: Pick<MeetingRow, 'endTime' | 'presenceIsLive' | 'presenceLastLiveAt' | 'startTime' | 'presenceFirstJoinAt'>,
  now: Date,
  graceMs = resolveJoinGraceMs()
): boolean => isGhostSessionOnTarget(meeting, now, resolveJoinEarlyMs(), graceMs);

export const shouldForceEndSession = (
  zoomMeetingId: string,
  target: MeetingRow,
  row: MeetingRow | undefined,
  now: Date
): boolean => {
  if (zoomMeetingId !== target.zoomMeetingId) {
    // Different meeting on the same host seat — candidate for force-end.
    return true;
  }
  return isGhostSessionOnTarget(target, now);
};

export type ForceEndParticipantDecision =
  | { action: 'force_end' }
  | { action: 'skip'; reason: string };

/**
 * Gate force-end using live participant count for the blocking session.
 *
 * - 0 participants → force end
 * - 2+ participants → do not force end
 * - 1 participant before session endTime → do not force end
 * - 1 participant after session endTime → force end
 * - API unavailable → allow force end (other ghost signals already matched)
 */
export const shouldForceEndByParticipants = (
  participantCount: number | null,
  sessionEndTime: Date,
  now: Date
): ForceEndParticipantDecision => {
  if (participantCount === null) {
    return { action: 'force_end' };
  }
  if (participantCount === 0) {
    return { action: 'force_end' };
  }
  if (participantCount >= 2) {
    return {
      action: 'skip',
      reason: `${participantCount} participants still in the previous meeting`,
    };
  }
  if (now.getTime() > sessionEndTime.getTime()) {
    return { action: 'force_end' };
  }
  return {
    action: 'skip',
    reason: 'one participant still in the previous meeting before its scheduled end',
  };
};

const graceEndsAt = (endTime: Date, graceMs: number): Date => new Date(endTime.getTime() + graceMs);

const buildJoinPayload = (
  target: MeetingRow,
  action: PrepareJoinAction,
  extra?: Partial<PrepareJoinResult>
): PrepareJoinResult => {
  const link = joinUrlOf(target);
  return { joinUrl: link, meetLink: link, meetingId: target.id, action, ...extra };
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
      ? `The Zoom host is still running an earlier meeting. Joining may land you in the wrong session until ` +
        `${gapMin} minutes after that class was scheduled to end (${endsAt.toISOString()}). You can try anyway.`
      : `The Zoom host seat may still be busy from an earlier session. Joining might open the wrong room — try anyway if you need to.`,
    {
      joinUrl: joinUrlOf(target),
      meetLink: joinUrlOf(target),
      meetingId: target.id,
      graceMinutes: gapMin,
      graceEndsAt: endsAt.toISOString(),
      hostStillLiveOnZoom: zoomLive,
      blockingMeeting: existingMeetingPayload(blocker),
      tryAnyway: true,
      wrongSessionRisk: true,
    }
  );
};

const rowByZoomId = (rows: MeetingRow[]): Map<string, MeetingRow> => {
  const map = new Map<string, MeetingRow>();
  for (const row of rows) {
    if (row.zoomMeetingId) map.set(row.zoomMeetingId, row);
  }
  return map;
};

const isBlockingZoomStatus = (
  status: ZoomMeetingLiveStatus | null,
  row: MeetingRow | undefined,
  now: Date,
  isTarget: boolean
): boolean => {
  if (!status || status === 'finished' || status === 'unknown') return false;
  if (status === 'started') return true;
  // Target in waiting room before class — normal, not a cross-session blocker.
  if (isTarget) return false;
  // Another meeting id still waiting after its slot — ghost holding the host seat.
  if (row && row.endTime.getTime() < now.getTime()) return true;
  return status === 'waiting';
};

const hostStillOccupied = async (
  hostEmail: string,
  organizerEmail: string,
  target: MeetingRow,
  rowsByZoom: Map<string, MeetingRow>,
  now: Date
): Promise<{ occupied: boolean; zoomId: string | null; row: MeetingRow | null }> => {
  const targetZoomId = target.zoomMeetingId!;

  for (const zid of await listHostLiveZoomMeetingIds(hostEmail, organizerEmail)) {
    if (zid === targetZoomId) continue;
    return { occupied: true, zoomId: zid, row: rowsByZoom.get(zid) ?? null };
  }

  for (const [zid, row] of rowsByZoom) {
    if (zid === targetZoomId) continue;
    const status = await getMeetingZoomStatus(zid, hostEmail, organizerEmail);
    if (isBlockingZoomStatus(status, row, now, false)) {
      return { occupied: true, zoomId: zid, row };
    }
  }

  const targetStatus = await getMeetingZoomStatus(targetZoomId, hostEmail, organizerEmail);
  const targetGhost = isGhostSessionOnTarget(target, now);
  const targetBlocking =
    isBlockingZoomStatus(targetStatus, target, now, true) ||
    (targetStatus === 'started' && targetGhost);
  return {
    occupied: targetBlocking,
    zoomId: targetBlocking ? targetZoomId : null,
    row: targetBlocking ? target : null,
  };
};

/**
 * Prepare a join for link4.
 *
 * Clears ANY other live Zoom meeting on the same host seat, and ends ghost
 * sessions on a reused room so user4 cannot land in user1's call.
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
  const targetZoomId = target.zoomMeetingId;

  const hostRows = await withDbRetry(() =>
    db.meeting.findMany({
      where: {
        provider: 'ZOOM',
        status: { not: 'CANCELLED' },
        zoomHostEmail: { equals: target.zoomHostEmail, mode: 'insensitive' },
        zoomMeetingId: { not: null },
        endTime: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
      select: meetingSelect,
      orderBy: { endTime: 'desc' },
      take: 50,
    })
  );

  const rowsByZoom = rowByZoomId(hostRows);
  const toEnd = new Set<string>();

  for (const zid of await listHostLiveZoomMeetingIds(target.zoomHostEmail, target.organizerEmail)) {
    if (shouldForceEndSession(zid, target, rowsByZoom.get(zid), now)) toEnd.add(zid);
  }

  for (const row of hostRows) {
    if (!row.zoomMeetingId) continue;
    const status = await getMeetingZoomStatus(row.zoomMeetingId, row.zoomHostEmail, row.organizerEmail);
    const isTarget = row.zoomMeetingId === targetZoomId;
    if (!isBlockingZoomStatus(status, row, now, isTarget)) continue;
    if (shouldForceEndSession(row.zoomMeetingId, target, row, now)) {
      toEnd.add(row.zoomMeetingId);
    }
  }

  let forcedMeetingId: string | undefined;
  let forcedZoomMeetingId: string | undefined;

  for (const zid of toEnd) {
    const row = rowsByZoom.get(zid);
    const sessionEndTime = row?.endTime ?? target.endTime;
    const participantCount = await getMeetingLiveParticipantCount(
      zid,
      target.zoomHostEmail,
      row?.organizerEmail ?? target.organizerEmail
    );
    const participantDecision = shouldForceEndByParticipants(participantCount, sessionEndTime, now);

    if (participantDecision.action === 'skip') {
      logger.info(
        `[PrepareJoin] Skipping force-end for Zoom session ${zid} on host ${hostKey}: ${participantDecision.reason}.`
      );
      continue;
    }

    const endRow = row ?? {
      id: zid,
      zoomMeetingId: zid,
      zoomHostEmail: target.zoomHostEmail,
      organizerEmail: target.organizerEmail,
    };
    logger.info(
      `[PrepareJoin] Clearing live Zoom session ${zid} on host ${hostKey} before join to ${target.id} ` +
        `(participants=${participantCount ?? 'unknown'}).`
    );
    const result = await endZoomSession({
      id: endRow.id,
      zoomMeetingId: zid,
      zoomHostEmail: target.zoomHostEmail,
      organizerEmail: endRow.organizerEmail ?? target.organizerEmail,
    });
    if (result === 'ended' || result === 'already_closed') {
      forcedMeetingId = endRow.id;
      forcedZoomMeetingId = zid;
    }
  }

  const occupancy = await hostStillOccupied(
    target.zoomHostEmail,
    target.organizerEmail,
    target,
    rowsByZoom,
    now
  );

  if (occupancy.occupied) {
    const blocker =
      occupancy.row ??
      (occupancy.zoomId === targetZoomId
        ? target
        : hostRows.find((r) => r.zoomMeetingId === occupancy.zoomId) ?? target);

    const targetStatus = await getMeetingZoomStatus(targetZoomId, target.zoomHostEmail, target.organizerEmail);
    const ghostOnTarget =
      occupancy.zoomId === targetZoomId && isGhostSessionOnTarget(target, now);

    if (ghostOnTarget || occupancy.zoomId !== targetZoomId) {
      throwHostBusy(target, blocker, graceMs, now, isZoomMeetingOccupyingHost(targetStatus));
    }

    // Target is legitimately live for this class window.
    return buildJoinPayload(target, forcedMeetingId ? 'force_ended' : 'none', {
      forcedMeetingId,
      forcedZoomMeetingId,
    });
  }

  if (forcedMeetingId) {
    return buildJoinPayload(target, 'force_ended', { forcedMeetingId, forcedZoomMeetingId });
  }

  return buildJoinPayload(target, 'none');
};
