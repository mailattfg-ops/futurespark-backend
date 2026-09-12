import { db, withDbRetry } from '../../database/datasource';
import { logger } from '@futurespark/logger';

/**
 * Where a class's sign-off lands.
 *
 * auth-service owns `ScheduledClass` and integration-service owns `Meeting`, and
 * they live in different databases — there is no foreign key to join on. When a
 * mentor presses "Completed", auth-service calls in here so the recording sweep
 * knows the class is genuinely over and can start counting down to its single
 * Drive search.
 *
 * Matching is the whole problem. One Meet link is shared by every session of a
 * programme (40 of them, for a year-long course), so `meetUrl` alone identifies
 * the *room*, never the lesson. The identity that does hold is
 * (studentId, sessionId) — the curriculum session a particular child sat — with
 * startTime as the tie-breaker for a session taught twice after a reschedule.
 */
/** How long after a class starts its room may still be closed on sign-off. */
export const END_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * May a sign-off end the Zoom room?
 *
 * Only for a PROMPT sign-off. One room serves every session of a programme
 * behind a single Meeting row, so ending it late would kill whichever class is
 * live in that room now — possibly another child's lesson. Inside the window,
 * the only thing that can be live there is this class (over-running or left
 * open), which is exactly what we want to close.
 *
 * Exported for end-window.check.ts.
 */
export const mayEndRoomOnSignOff = (classStart: Date | null, completedAt: Date): boolean =>
  !classStart || completedAt.getTime() - classStart.getTime() <= END_WINDOW_MS;

export const ClassLifecycleService = {
  /**
   * Stamp `classCompletedAt` on the meeting behind a class.
   *
   * Idempotent: re-marking an already-stamped meeting leaves the original
   * timestamp alone, so a retried call cannot push the recording search
   * further into the future.
   */
  async markClassCompleted(input: {
    meetingLink?: string | null;
    studentId?: string | null;
    sessionId?: string | null;
    programId?: string | null;
    startTime?: string | Date | null;
    completedAt?: string | Date | null;
  }) {
    const completedAt = input.completedAt ? new Date(input.completedAt) : new Date();
    if (Number.isNaN(completedAt.getTime())) {
      throw new Error('completedAt is not a valid date.');
    }

    const startTime = input.startTime ? new Date(input.startTime) : null;
    const validStart = startTime && !Number.isNaN(startTime.getTime()) ? startTime : null;

    // ±2h around the booked start. Wide enough to absorb a timezone-naive
    // string or a slot nudged by a few minutes, narrow enough that the
    // *neighbouring* week's class can never match.
    const SLOT_TOLERANCE_MS = 2 * 60 * 60 * 1000;
    const slotWindow = validStart
      ? {
          startTime: {
            gte: new Date(validStart.getTime() - SLOT_TOLERANCE_MS),
            lte: new Date(validStart.getTime() + SLOT_TOLERANCE_MS),
          },
        }
      : {};

    // Tried in descending order of confidence. The first that returns exactly
    // one row wins; anything ambiguous falls through rather than guessing.
    const strategies: Array<{ label: string; where: any }> = [];

    if (input.studentId && input.sessionId) {
      strategies.push({
        label: 'studentId+sessionId+slot',
        where: { studentId: input.studentId, sessionId: input.sessionId, ...slotWindow },
      });
    }
    if (input.studentId && input.programId && validStart) {
      strategies.push({
        label: 'studentId+programId+slot',
        where: { studentId: input.studentId, programId: input.programId, ...slotWindow },
      });
    }
    if (input.meetingLink && validStart) {
      strategies.push({
        label: 'meetUrl+slot',
        where: { meetUrl: { contains: normalizeLink(input.meetingLink) }, ...slotWindow },
      });
    }

    for (const strategy of strategies) {
      const matches = await withDbRetry(() =>
        db.meeting.findMany({
          where: { status: { not: 'CANCELLED' }, ...strategy.where },
          orderBy: { startTime: 'desc' },
          take: 5,
        })
      );

      if (matches.length === 0) continue;
      if (matches.length > 1) {
        logger.warn(
          `[ClassLifecycle] "${strategy.label}" matched ${matches.length} meetings for student ` +
            `${input.studentId ?? '-'} session ${input.sessionId ?? '-'} — too ambiguous to stamp, ` +
            'trying the next strategy.'
        );
        continue;
      }

      const meeting = matches[0];
      if (meeting.classCompletedAt) {
        logger.info(
          `[ClassLifecycle] Meeting ${meeting.id} was already marked complete at ` +
            `${meeting.classCompletedAt.toISOString()}; leaving the original timestamp.`
        );
        return { matched: true, meetingId: meeting.id, classCompletedAt: meeting.classCompletedAt, alreadyMarked: true };
      }

      const updated = await withDbRetry(() =>
        db.meeting.update({
          where: { id: meeting.id },
          data: { classCompletedAt: completedAt },
        })
      );

      logger.info(
        `[ClassLifecycle] Meeting ${meeting.id} ("${meeting.title}") marked complete at ` +
          `${completedAt.toISOString()} via ${strategy.label} — the Drive sweep will search once the ` +
          'publish delay has elapsed.'
      );

      /* Sign-off should also close the room — but only a PROMPT sign-off.
       *
       * One Zoom room serves every session of a programme, and there is a
       * single Meeting row behind it, so "end the session" cannot be aimed at
       * one particular lesson. Ending it hours late would therefore kill
       * whichever class is live in that room NOW, which could be a different
       * child's lesson in progress.
       *
       * Bounded to the completed class's own sitting: within three hours of its
       * start, the only thing that can be live in that room is this class
       * (running over, or left open) — exactly what we want to close. Later
       * than that, we leave the room alone and the seat is reclaimed by the
       * buffer/next booking instead of by guessing.
       */
      if (mayEndRoomOnSignOff(validStart, completedAt)) {
        // Awaited so the seat is free before we answer, but it can never fail
        // the completion itself.
        await endZoomSessionIfRunning(meeting);
      } else {
        logger.info(
          `[ClassLifecycle] Meeting ${meeting.id} signed off ` +
            `${Math.round((completedAt.getTime() - validStart!.getTime()) / 3600000)}h after it started — ` +
            'leaving the Zoom room alone in case another class is using it now.'
        );
      }

      return { matched: true, meetingId: updated.id, classCompletedAt: updated.classCompletedAt, alreadyMarked: false };
    }

    // Not an error. Demo classes and manually-linked rooms often have no Meeting
    // row at all, and the report pipeline degrades to "no recording" cleanly.
    logger.warn(
      `[ClassLifecycle] No meeting matched the completed class (student ${input.studentId ?? '-'}, ` +
        `session ${input.sessionId ?? '-'}, link ${input.meetingLink ?? '-'}). No recording will be ` +
        'searched for it.'
    );
    return { matched: false, meetingId: null, classCompletedAt: null, alreadyMarked: false };
  },
};

/**
 * End the live Zoom session behind a completed class, freeing its host seat.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * A licensed Zoom host can run exactly ONE live meeting. Seats are allocated
 * against BOOKED windows, but Zoom enforces against reality — so a room left
 * running holds its seat for hours, regardless of when the class was supposed
 * to finish. A mentor who clicks "Leave" instead of "End meeting for all", or
 * simply shuts the lid with the tab open, stays a connected participant and the
 * room never closes.
 *
 * The result was a later class on that same seat failing at JOIN time with
 * "the host has another meeting in progress", having scheduled perfectly hours
 * earlier. Marking the class complete used to write a timestamp and nothing
 * else; now it means what everyone assumed it meant.
 *
 * ── Why this is safe for reused rooms ─────────────────────────────────────
 * `action: "end"` terminates the CURRENT session only. The meeting and its join
 * URL survive and can be started again, so the shared link every later session
 * of a programme depends on keeps working.
 *
 * Never throws: Zoom answers 400 when the meeting is not live, which is the
 * common case (the mentor did end it properly) and not a problem.
 */
const endZoomSessionIfRunning = async (meeting: {
  id: string;
  provider: string;
  zoomMeetingId: string | null;
  organizerEmail: string;
  zoomHostEmail: string | null;
}): Promise<void> => {
  if (meeting.provider !== 'ZOOM' || !meeting.zoomMeetingId) return;

  try {
    const { ZoomAuthService } = await import('../zoom/auth/auth.service');
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
        `[ClassLifecycle] Ended the live Zoom session for meeting ${meeting.id} — seat ` +
          `${meeting.zoomHostEmail ?? meeting.organizerEmail} is free again.`
      );
      return;
    }

    // 400 = "Meeting is not live", by far the most common answer and entirely fine.
    const body = await res.text().catch(() => '');
    if (res.status === 400) {
      logger.info(`[ClassLifecycle] Zoom session for meeting ${meeting.id} was already closed.`);
      return;
    }
    logger.warn(
      `[ClassLifecycle] Could not end the Zoom session for meeting ${meeting.id}: ${res.status} ${body.slice(0, 200)}`
    );
  } catch (err: any) {
    logger.warn(`[ClassLifecycle] Ending the Zoom session for meeting ${meeting.id} failed: ${err?.message ?? err}`);
  }
};

/** Reduce a meeting link to the part that survives query strings and protocols. */
const normalizeLink = (link: string): string =>
  link.trim().replace(/^https?:\/\//, '').split('?')[0].split('#')[0];
