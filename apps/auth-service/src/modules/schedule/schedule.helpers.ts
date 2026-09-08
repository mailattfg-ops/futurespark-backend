/**
 * schedule.helpers.ts
 *
 * Internal helpers, constants, and pure functions shared across schedule
 * service files.  Nothing here answers an HTTP request — it is building
 * blocks only.
 */

import { db } from '../../database/datasource';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS, canSeeAnswerKey, stripAnswerKey } from '@futurespark/constants';

// ─────────────────────────────────────────────────────────────────────────────
// Role helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A class is finished if it was completed, the room emptied, or its slot ran out. */
export const isOver = (c: { status: string; endTime: Date; actualEndedAt: Date | null }, nowMs: number): boolean =>
  c.status === 'COMPLETED' || Boolean(c.actualEndedAt) || c.endTime.getTime() <= nowMs;

/**
 * A mentor reaches us under either role string: `TEACHER` is what the auth
 * schema stores, `INSTRUCTOR` is what the curriculum side issues. Both mean the
 * same person, so every mentor gate has to accept both or half of them get a 403.
 */
export const isMentorRole = (role?: string): boolean => role === 'TEACHER' || role === 'INSTRUCTOR';

/**
 * Staff whose job spans the whole platform, so a class list is not narrowed for
 * them. Mirrors the `isStaff` test in user.service.ts so the two cannot drift.
 */
export const isUnscopedStaffRole = (role?: string): boolean => role === 'ADMIN' || role === 'SCHEDULER';

/**
 * The office wall board — DISPLAY reads the whole timetable and does nothing else.
 * Deliberately kept out of `isUnscopedStaffRole`.
 */
export const isWallDisplayRole = (role?: string): boolean => role === 'DISPLAY';

/**
 * Staff whose job is auditing classes that have already been delivered.
 * Deliberately NOT the same set as `isUnscopedStaffRole`.
 */
export const isClassAuditorRole = (role?: string): boolean => role === 'ADMIN' || role === 'QA_AUDITOR';

// ─────────────────────────────────────────────────────────────────────────────
// Access control helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip the marking scheme out of a curriculum session before it leaves for a
 * student or parent.
 */
export const redactSessionAnswerKey = <T extends { reflectionQuiz?: unknown } | null>(
  session: T,
  callerRole?: string
): T => {
  if (!session || canSeeAnswerKey(callerRole)) return session;
  if (!Array.isArray(session.reflectionQuiz) || session.reflectionQuiz.length === 0) return session;
  return { ...session, reflectionQuiz: stripAnswerKey(session.reflectionQuiz as any) };
};

/**
 * The one relationship test every per-class read shares: the student who sat
 * the class, that student's parent, or the mentor who taught it.
 */
export const assertClassAccess = (
  cls: {
    studentId: string | null;
    mentorId: string | null;
    student?: { parentAccountId: string } | null;
  },
  callerId?: string,
  callerRole?: string
): void => {
  if (callerRole === 'ADMIN') return;
  if (!callerId) {
    throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
  }
  const permitted =
    (isMentorRole(callerRole) && cls.mentorId === callerId) ||
    (callerRole === 'STUDENT' && callerId === cls.studentId) ||
    (callerRole === 'PARENT' && callerId === cls.student?.parentAccountId);
  if (!permitted) {
    throw new AppError('You do not have access to this class', HTTP_STATUS.FORBIDDEN);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DB select shapes
// ─────────────────────────────────────────────────────────────────────────────

export const STUDENT_CLASS_SELECT = {
  id: true,
  studentCode: true,
  firstName: true,
  lastName: true,
  email: true,
  avatarUrl: true,
  credits: true,
  timezone: true,
  schedulerGroupId: true,
  parentAccountId: true,
} as const;

export const MENTOR_CLASS_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  schedulerGroupId: true,
} as const;

export const REPORT_CLASS_SELECT = {
  id: true,
  programId: true,
  sessionId: true,
  startTime: true,
  endTime: true,
  status: true,
  classType: true,
  studentId: true,
  mentorId: true,
  student: {
    select: { id: true, firstName: true, lastName: true, parentAccountId: true },
  },
  mentor: {
    select: { id: true, firstName: true, lastName: true },
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Domain constants
// ─────────────────────────────────────────────────────────────────────────────

export const DOUBT_QUESTION_MAX = 2000;
export const DOUBT_ANSWER_MAX = 5000;

export const RESCHEDULE_FLOW_STATUSES = new Set(['SCHEDULED', 'RESCHEDULE_REQUESTED']);

export const TIMETABLE_UPDATE_FIELDS = [
  'startTime',
  'mentorId',
  'creditsAwarded',
  'meetingLink',
  'updateAll',
] as const;

export const AUDIT_UPDATE_FIELDS = ['qaStatus', 'qaFeedback'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Internal class loader & view projection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The raw class row, with no authorization of any kind. INTERNAL ONLY.
 */
export const loadClassRecord = async (id: string) => {
  const classSession = await db.scheduledClass.findUnique({
    where: { id },
    include: {
      student: { select: STUDENT_CLASS_SELECT },
      mentor: { select: MENTOR_CLASS_SELECT },
      scheduledBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  });
  if (!classSession) {
    throw new AppError('Scheduled class not found', HTTP_STATUS.NOT_FOUND);
  }
  return classSession;
};

export type ClassRecord = Awaited<ReturnType<typeof loadClassRecord>>;

/**
 * What the people in the room are allowed to see of their own class.
 * An allowlist, not a denylist.
 */
export const participantClassView = (c: ClassRecord) => ({
  id: c.id,
  studentId: c.studentId,
  student: c.student,
  mentorId: c.mentorId,
  mentor: c.mentor,
  scheduledById: c.scheduledById,
  scheduledBy: c.scheduledBy,
  programId: c.programId,
  sessionId: c.sessionId,
  startTime: c.startTime,
  endTime: c.endTime,
  status: c.status,
  classType: c.classType,
  leadId: c.leadId,
  meetingLink: c.meetingLink,
  rescheduleReason: c.rescheduleReason,
  rescheduleMessage: c.rescheduleMessage,
  rescheduledCount: c.rescheduledCount,
  qaStatus: c.qaStatus,
  creditsAwarded: c.creditsAwarded,
  studentRating: c.studentRating,
  studentFeedback: c.studentFeedback,
  reflectionSubmittedAt: c.reflectionSubmittedAt,
  reflectionScore: c.reflectionScore,
  reflectionMaxScore: c.reflectionMaxScore,
  reflectionBadge: c.reflectionBadge,
  reflectionReviewedAt: c.reflectionReviewedAt,
  reflectionReviewedById: c.reflectionReviewedById,
  reflectionMentorNote: c.reflectionMentorNote,
  actualEndedAt: c.actualEndedAt,
  autoRecording: c.autoRecording,
  recordingUrl: c.recordingUrl,
  classSummary: c.classSummary,
  transcriptionStatus: c.transcriptionStatus,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One answered prompt, snapshotted at submit time and marked afterwards.
 * The read-side, tolerant twin of `ReflectionAnswerEntry` in `@futurespark/constants`.
 */
export interface ReflectionEntry {
  question: string;
  answer: string;
  questionId?: string;
  type?: string;
  selectedOptionId?: string | null;
  pointsPossible?: number;
  /** The mentor's award. null or absent means this answer is not marked yet. */
  pointsEarned?: number | null;
  mentorComment?: string | null;
  mentorMarkedAt?: string | null;
  /** Legacy auto-grade verdict. Nothing writes it any more. */
  correct?: boolean | null;
}
