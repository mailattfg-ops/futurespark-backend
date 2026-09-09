import { logger } from '@futurespark/logger';
import { internalKeyHeader } from './internal-key';
import { db } from '../../database/datasource';

/**
 * Which lesson a finished recording belongs to.
 *
 * A recording hangs off a `Meeting` row, and it is tempting to read the
 * student, session and slot straight off it. That is wrong here: one room
 * serves every session of a programme, so the meeting row keeps the identity
 * of the FIRST class ever booked in it. Reading session identity from it meant
 * every later recording was transcribed against session one's material and
 * stamped with session one's date — a Budgeting class coming back titled
 * "Orientation", three weeks out.
 *
 * The recording's own timestamp answers it instead: auth-service owns the
 * timetable and can say which class was in that room at that moment. It
 * refuses when two classes could match, and so do we — a summary on the wrong
 * child's lesson is worse than no summary.
 */
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

export interface LessonOwner {
  id: string;
  studentId: string | null;
  mentorId: string | null;
  sessionId: string | null;
  programId: string | null;
  startTime: string;
  endTime: string;
  /** This lesson's stored summary, so the panel need not guess which to show. */
  classSummary?: string | null;
  transcript?: string | null;
}

export const findLessonForRecording = async (
  meetUrl: string | null | undefined,
  recordedAt: Date | null | undefined
): Promise<LessonOwner | null> => {
  if (!meetUrl || !recordedAt || Number.isNaN(recordedAt.getTime())) return null;
  try {
    const url =
      `${AUTH_SERVICE_URL}/schedules/internal/class-at` +
      `?link=${encodeURIComponent(meetUrl)}&at=${encodeURIComponent(recordedAt.toISOString())}`;
    const res = await fetch(url, { headers: internalKeyHeader(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body: any = await res.json().catch(() => null);
    return body?.data ?? null;
  } catch (err: any) {
    logger.warn(`[Recording] Could not resolve the lesson for ${meetUrl}: ${err.message}`);
    return null;
  }
};

/** Fetch the frozen-bound class by id — no time/room judgement, the binding already decided. */
const lessonById = async (classId: string): Promise<LessonOwner | null> => {
  try {
    const res = await fetch(
      `${AUTH_SERVICE_URL}/schedules/internal/class-by-id/${encodeURIComponent(classId)}`,
      { headers: internalKeyHeader(), signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const body: any = await res.json().catch(() => null);
    return body?.data ?? null;
  } catch (err: any) {
    logger.warn(`[Recording] Could not fetch bound class ${classId}: ${err.message}`);
    return null;
  }
};

/**
 * The lesson a recording belongs to — the persisted binding wins.
 *
 * If the recording already carries `boundClassId`, that class is returned and
 * no room/time matching happens: this is what makes a later reschedule, link
 * change or delete-and-recreate unable to orphan the video. Otherwise the
 * strict room+time match runs, and a successful match is FROZEN onto the
 * recording so it holds from then on.
 *
 * The pass-through `recording` is any row with id, meetUrl, recordedAt/createdAt
 * and boundClassId — every caller already has the full row.
 */
export const ownerForRecording = async (recording: {
  id: string;
  boundClassId?: string | null;
  recordedAt?: Date | null;
  createdAt?: Date | null;
  meeting?: { meetUrl?: string | null } | null;
}): Promise<LessonOwner | null> => {
  if (recording.boundClassId) {
    const bound = await lessonById(recording.boundClassId);
    if (bound) return bound;
    // Bound to a class that no longer exists (deleted). Clear the stale binding
    // and fall through to a fresh match rather than returning nothing forever.
    logger.warn(`[Recording] ${recording.id} was bound to missing class ${recording.boundClassId}; re-matching.`);
    await db.meetingRecording.update({ where: { id: recording.id }, data: { boundClassId: null, boundAt: null, boundBy: null } }).catch(() => {});
  }

  const lesson = await findLessonForRecording(
    recording.meeting?.meetUrl,
    recording.recordedAt ?? recording.createdAt
  );
  if (lesson) {
    // Freeze it. Best-effort: a failed write just means it re-matches next time,
    // never a wrong identity.
    await db.meetingRecording
      .update({ where: { id: recording.id }, data: { boundClassId: lesson.id, boundAt: new Date(), boundBy: 'auto' } })
      .then(() => logger.info(`[Recording] ${recording.id} bound to class ${lesson.id} (auto).`))
      .catch((e: any) => logger.warn(`[Recording] Could not persist binding for ${recording.id}: ${e?.message ?? e}`));
  }
  return lesson;
};
