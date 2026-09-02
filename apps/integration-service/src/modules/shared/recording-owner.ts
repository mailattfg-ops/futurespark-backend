import { logger } from '@futurespark/logger';
import { internalKeyHeader } from './internal-key';

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
