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

/** Reduce a meeting link to the part that survives query strings and protocols. */
const normalizeLink = (link: string): string =>
  link.trim().replace(/^https?:\/\//, '').split('?')[0].split('#')[0];
