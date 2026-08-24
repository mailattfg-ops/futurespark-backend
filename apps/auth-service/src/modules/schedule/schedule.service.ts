import { db } from '../../database/datasource';
import { CreateScheduleInput, UpdateScheduleInput } from './schedule.schema';
import { AppError } from '@futurespark/middleware';
import {
  HTTP_STATUS,
  effectiveReflectionQuestions,
  effectiveReflectionQuiz,
  effectiveSessionTopics,
  snapshotReflection,
  applyMentorMarks,
  mentorAwardedTotal,
  deriveAttendance,
  owesReflection,
  stripAnswerKey,
  canSeeAnswerKey,
  createClassMediaGrant,
  extractMeetCode,
  ReflectionResponse,
  ReflectionMentorMark,
  ReflectionAnswerEntry,
} from '@futurespark/constants';

/** A class is finished if it was completed, the room emptied, or its slot ran out. */
const isOver = (c: { status: string; endTime: Date; actualEndedAt: Date | null }, nowMs: number): boolean =>
  c.status === 'COMPLETED' || Boolean(c.actualEndedAt) || c.endTime.getTime() <= nowMs;

/**
 * A mentor reaches us under either role string: `TEACHER` is what the auth
 * schema stores, `INSTRUCTOR` is what the curriculum side issues. Both mean the
 * same person, so every mentor gate has to accept both or half of them get a 403.
 */
const isMentorRole = (role?: string): boolean => role === 'TEACHER' || role === 'INSTRUCTOR';

/**
 * Staff whose job spans the whole platform, so a class list is not narrowed for
 * them. Mirrors the `isStaff` test in user.service.ts so the two cannot drift.
 * Every other role — including the other staff roles — is scoped to what it owns.
 */
const isUnscopedStaffRole = (role?: string): boolean => role === 'ADMIN' || role === 'SCHEDULER';

/**
 * Staff whose job is auditing classes that have already been delivered: they
 * sign off a class's QA verdict, work the session-report queue, and are the only
 * roles allowed to read a class's transcript and reflection answer key.
 *
 * Deliberately *not* the same set as `isUnscopedStaffRole`. A SCHEDULER moves
 * classes around and so needs `startTime` / `mentorId` / `creditsAwarded`, but
 * has no business reading what a child wrote in a lesson; a QA_AUDITOR is the
 * mirror image. Conflating the two is how a "staff" check ends up handing the
 * whole platform's transcripts to whoever books the timetable.
 */
const isClassAuditorRole = (role?: string): boolean => role === 'ADMIN' || role === 'QA_AUDITOR';

/**
 * Strip the marking scheme out of a curriculum session before it leaves for a
 * student or parent.
 *
 * `Session.reflectionQuiz` stores `correctOptionId` per question. Narrowing the
 * class row was not enough on its own: the attached session carried the same
 * answer key by a different column, readable on an UPCOMING class, so a student
 * could look up the answers before their first attempt. `canSeeAnswerKey` is the
 * shared rule — staff and mentors keep it, families do not.
 */
const redactSessionAnswerKey = <T extends { reflectionQuiz?: unknown } | null>(
  session: T,
  callerRole?: string
): T => {
  if (!session || canSeeAnswerKey(callerRole)) return session;
  if (!Array.isArray(session.reflectionQuiz) || session.reflectionQuiz.length === 0) return session;
  return { ...session, reflectionQuiz: stripAnswerKey(session.reflectionQuiz as any) };
};

/**
 * The one relationship test every per-class read shares: the student who sat
 * the class, that student's parent, or the mentor who taught it. ADMIN is let
 * through for support fixes; everyone else — including other mentors on the
 * platform — is refused.
 *
 * A PARENT's caller id is their ParentAccount id, not a User id, so the caller
 * must load `student: { select: { parentAccountId: true } }` alongside the ids.
 */
const assertClassAccess = (
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

/**
 * The student and mentor fields a class-shaped response is allowed to carry.
 *
 * Never `student: true` / `mentor: true`: a bare `true` selects every scalar on
 * the model, and both Student and User carry `passwordHash`. Kept in step with
 * the inline list `listSchedules` uses.
 */
const STUDENT_CLASS_SELECT = {
  id: true,
  studentCode: true,
  firstName: true,
  lastName: true,
  email: true,
  avatarUrl: true,
  credits: true,
  timezone: true,
  schedulerGroupId: true,
  // QA's disciplinary panel offers the parent account behind a reported class
  // as an action target, so the id has to travel with the student.
  parentAccountId: true,
} as const;

const MENTOR_CLASS_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  schedulerGroupId: true,
} as const;

/**
 * The class fields a session report is allowed to carry.
 *
 * A report is read by the person who filed it (`my-reports.tsx`) and by the QA
 * queue (`qa/page.tsx`). Between them they need the lesson's slot, its programme
 * and the names of the two people in the room — nothing else. It used to be an
 * `include`, which selects *every* ScheduledClass scalar: `reflectionAnswers`
 * (a child's own words, and the mentor's marks on them), `transcript`,
 * `classSummary`, `studentFeedback` and `recordingUrl` all rode out on the back
 * of a report row.
 *
 * `parentAccountId` is here because QA's disciplinary panel offers the parent
 * behind a reported class as an action target; `mentor.id` / `student.id` for
 * the same reason.
 */
const REPORT_CLASS_SELECT = {
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

// Long enough for a real question and a real explanation, short enough that a
// runaway paste cannot be used to fill the column.
const DOUBT_QUESTION_MAX = 2000;
const DOUBT_ANSWER_MAX = 5000;
import { logger } from '@futurespark/logger';
import { sendNotification } from '../notification-helper';
import { rescheduleCalendarEvent, markMeetingClassCompleted } from '../calendar-helper';

/**
 * The raw class row, with no authorization of any kind.
 *
 * INTERNAL ONLY. Deliberately a module-level function rather than a method on
 * `scheduleService`, so a controller cannot reach it and no route can ever be
 * wired straight to it. `updateSchedule`, `deleteSchedule` and `createReport`
 * all need the row *before* they can decide whether the caller may touch it, so
 * they load it through here and then run their own gate. Anything that answers
 * an HTTP GET must go through `scheduleService.getScheduleById`, which both
 * gates and narrows.
 */
const loadClassRecord = async (id: string) => {
  const classSession = await db.scheduledClass.findUnique({
    where: { id },
    include: {
      student: { select: STUDENT_CLASS_SELECT },
      mentor: { select: MENTOR_CLASS_SELECT },
      scheduledBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });

  if (!classSession) {
    throw new AppError('Scheduled class not found', HTTP_STATUS.NOT_FOUND);
  }

  return classSession;
};

type ClassRecord = Awaited<ReturnType<typeof loadClassRecord>>;

/**
 * What the people in the room — the student, their parent, the mentor — are
 * allowed to see of their own class.
 *
 * An allowlist, not a denylist: a column added to ScheduledClass later is
 * withheld until someone deliberately adds it here, which is the opposite of
 * what `include` does. Four fields are held back on purpose:
 *
 *  - `reflectionAnswers` — a child's own answers, plus the mentor's per-answer
 *    marks and remarks on them. `getReflection` is the one endpoint that serves
 *    those, and it gates on the same three-way relationship.
 *  - `transcript` — the verbatim record of a child speaking in a lesson.
 *  - `qaFeedback` — QA's internal notes on how the mentor performed.
 *  - `interactionMetrics` — the same audit material in derived form.
 *
 * `recordingUrl` / `classSummary` / `studentFeedback` stay: `getStudentOverview`
 * already hands those to exactly this set of people, so withholding them here
 * would be inconsistent rather than safer.
 */
const participantClassView = (c: ClassRecord) => ({
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

/**
 * The two states the reschedule conversation moves between.
 *
 * A student, parent or mentor asking for a different slot flips SCHEDULED →
 * RESCHEDULE_REQUESTED; withdrawing the request flips it back. Those are the
 * only two status values they may write, and only while the class is already in
 * one of them — so a finished or cancelled class cannot be reopened, and
 * COMPLETED can never be reached from this route at all.
 */
const RESCHEDULE_FLOW_STATUSES = new Set(['SCHEDULED', 'RESCHEDULE_REQUESTED']);

/**
 * Fields on `PUT /schedules/:id` that decide the timetable, who teaches, and how
 * many credit points a child is worth. ADMIN and SCHEDULER only.
 *
 * `creditsAwarded` is the sharp one. `creditsDiff` is computed against the
 * status the class had *before* the update, so a caller who could first set
 * COMPLETED and then post `creditsAwarded` minted the full amount every time,
 * with no ceiling and no limit on repeats. `meetingLink` is here too: rewriting
 * it points a child's lesson at a room of the caller's choosing.
 */
const TIMETABLE_UPDATE_FIELDS = [
  'startTime',
  'mentorId',
  'creditsAwarded',
  'meetingLink',
  'updateAll',
] as const;

/** The QA verdict on a delivered class. ADMIN and QA_AUDITOR only. */
const AUDIT_UPDATE_FIELDS = ['qaStatus', 'qaFeedback'] as const;

export const scheduleService = {
  async getMentorsWithSchedules(groupId?: string) {
    const where: any = {
      role: { name: 'TEACHER' },
      isActive: true,
    };
    if (groupId) {
      where.schedulerGroupId = groupId;
    }

    return db.user.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        qualifiedPrograms: true,
        mentorTypes: true,
        schedulerGroupId: true,
        mentorSchedules: {
          select: {
            id: true,
            weekday: true,
            startTime: true,
            endTime: true,
            scheduleType: true,
          },
        },
      },
      orderBy: { firstName: 'asc' },
    });
  },

  async listSchedules(
    filters: { studentId?: string; mentorId?: string; status?: string; groupId?: string },
    callerId?: string,
    callerRole?: string
  ) {
    const where: any = {
      studentId: filters.studentId || undefined,
      mentorId: filters.mentorId || undefined,
      status: filters.status || undefined,
    };

    if (filters.groupId) {
      where.OR = [
        { student: { schedulerGroupId: filters.groupId } },
        { mentor: { schedulerGroupId: filters.groupId } },
      ];
    }

    // The scope is decided here, from the caller's identity — never from the
    // query string. Omitting every filter used to return every class for every
    // child, names and emails included, to anyone holding a valid token.
    //
    // A caller-supplied filter is still honoured, but only ever as a further
    // AND on top of this: it can narrow what the caller already owns and can
    // never reach outside it.
    if (!isUnscopedStaffRole(callerRole)) {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      if (isMentorRole(callerRole)) {
        // Overwrites any supplied mentorId: the only mentor's timetable a
        // mentor may read is their own.
        where.mentorId = callerId;
      } else if (callerRole === 'STUDENT') {
        where.studentId = callerId;
      } else if (callerRole === 'PARENT') {
        // A PARENT's caller id is their ParentAccount id. ANDed with any
        // supplied studentId, so asking for another family's child matches
        // nothing rather than leaking it.
        where.student = { parentAccountId: callerId };
      } else {
        // Fails closed for every other role. Returned empty rather than 403 so
        // a staff dashboard that fetches this list incidentally still renders.
        return [];
      }
    }

    const schedules = await db.scheduledClass.findMany({
      where,
      include: {
        student: {
          select: {
            id: true,
            studentCode: true,
            firstName: true,
            lastName: true,
            email: true,
            avatarUrl: true,
            // Points and timezone travel with the class so a mentor's dashboard
            // can show a student's full record without a second round trip per
            // student — it already loads every class it needs.
            credits: true,
            timezone: true,
            schedulerGroupId: true,
          },
        },
        mentor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            schedulerGroupId: true,
          },
        },
        scheduledBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: { startTime: 'asc' },
    });

    const sessionIds = [...new Set(schedules.map((s) => s.sessionId).filter(Boolean))] as string[];
    const sessions = await db.session.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, title: true, order: true, credits: true, topics: true },
    });

    /* ── Who is attending a demo ─────────────────────────────────────────────
     * A demo class carries a bare `leadId` and no student, so every portal
     * printed a placeholder — the mentor's timetable said "Demo Prospect
     * Student" for a real child they were about to teach for ninety minutes.
     *
     * Resolved here rather than by each portal fetching the CRM: a mentor has
     * no business listing the sales pipeline, and this is already scoped to the
     * classes they are entitled to see. NAMES ONLY — deliberately no email or
     * phone, which is contact data the admin owns and a mentor does not need.
     * `Lead` has no relation to `ScheduledClass` (different schema, bare id),
     * hence the follow-up query rather than an `include`.
     * ───────────────────────────────────────────────────────────────────── */
    const leadIds = [...new Set(schedules.map((s) => s.leadId).filter(Boolean))] as string[];
    const leads =
      leadIds.length > 0
        ? await db.lead.findMany({
            where: { id: { in: leadIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              /* The CHILD's name, when the lead records one. Without these the
               * portals fall back to the parent's name — so converting a class
               * to a demo changed whose name the mentor saw on the card, for a
               * child who had not changed at all. */
              studentFirstName: true,
              studentLastName: true,
            },
          })
        : [];

    const now = Date.now();
    return schedules.map((s) => ({
      ...s,
      session: sessions.find((sess) => sess.id === s.sessionId) || null,
      lead: s.leadId ? leads.find((l) => l.id === s.leadId) || null : null,
      // Derived here rather than in each portal, so the student's attendance
      // tab and the mentor's student record can never disagree about whether a
      // class was missed.
      attendance: deriveAttendance(s, now),
    }));
  },

  /**
   * One class, for whoever is entitled to it.
   *
   * Used to take an id and nothing else, and answer with a top-level `include`.
   * A class id is a bare UUID travelling in every schedule list, so any holder of
   * any valid token who had ever seen one could read that class's `transcript`
   * and `reflectionAnswers` — the answer key for a quiz other children were
   * still about to sit. Two things were missing and both are restored here: who
   * is asking, and how much of the row the answer is allowed to contain.
   */
  async getScheduleById(id: string, callerId?: string, callerRole?: string) {
    const classSession = await loadClassRecord(id);

    // ADMIN and SCHEDULER run the timetable across the platform and QA_AUDITOR
    // audits it, so none of them is narrowed to one family. Everybody else has
    // to be in the room: the student, that student's parent, or the mentor who
    // taught it — the same test `getReflection` and `listDoubts` already run.
    if (!isUnscopedStaffRole(callerRole) && !isClassAuditorRole(callerRole)) {
      assertClassAccess(classSession, callerId, callerRole);
    }

    let session = null;
    if (classSession.sessionId) {
      session = await db.session.findUnique({
        where: { id: classSession.sessionId },
      });
    }

    // Passing the access check earns the class, not the audit material on it.
    // Only the roles whose job is reviewing a delivered lesson get the
    // transcript and the answer key; a SCHEDULER is trusted with the timetable
    // and still does not see either.
    return isClassAuditorRole(callerRole)
      ? { ...classSession, session }
      : { ...participantClassView(classSession), session: redactSessionAnswerKey(session, callerRole) };
  },

  async createSchedule(input: CreateScheduleInput, scheduledById?: string, callerRole?: string) {
    // Booking is a staff action. This route was open to any authenticated token,
    // which was the amplifier under the credit exploit: a mentor could invent a
    // class against any student, complete it, and award themselves credits on it,
    // repeating with a fresh slot each time. It also let anyone inject classes
    // into a stranger's timetable.
    //
    // Every real caller is already staff-only — /scheduler, /students, /customers
    // are allowlisted to ADMIN and SCHEDULER, and /qa and /dashboard to ADMIN.
    if (!isUnscopedStaffRole(callerRole)) {
      throw new AppError('Only an admin or scheduler can book a class', HTTP_STATUS.FORBIDDEN);
    }

    const classType = input.classType || 'REGULAR';

    // 1. Verify Student exists for REGULAR classes
    if (classType === 'REGULAR') {
      if (!input.studentId) {
        throw new AppError('Student ID is required for regular classes', HTTP_STATUS.BAD_REQUEST);
      }
      const student = await db.student.findUnique({ where: { id: input.studentId } });
      if (!student) {
        throw new AppError('Student account not found', HTTP_STATUS.NOT_FOUND);
      }
    } else if (classType === 'DEMO') {
      if (!input.leadId) {
        throw new AppError('Lead ID is required for demo classes', HTTP_STATUS.BAD_REQUEST);
      }
    }

    // 2. Verify Mentor exists
    const mentor = await db.user.findUnique({ where: { id: input.mentorId } });
    if (!mentor) {
      throw new AppError('Mentor not found', HTTP_STATUS.NOT_FOUND);
    }

    if (classType === 'DEMO') {
      const classStartTime = new Date(input.startTime);
      const classEndTime = new Date(classStartTime.getTime() + 90 * 60 * 1000); // 90 min duration

      // Check mentor conflicts
      const mentorConflicts = await db.scheduledClass.findFirst({
        where: {
          mentorId: input.mentorId,
          status: { not: 'CANCELLED' },
          startTime: { lt: classEndTime },
          endTime: { gt: classStartTime },
        },
      });

      if (mentorConflicts && !input.allowConflict) {
        throw new AppError(
          `Mentor has a scheduling conflict with another class on ${classStartTime.toLocaleDateString()} at ${classStartTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          HTTP_STATUS.CONFLICT
        );
      }

      // Check lead conflicts
      const leadConflicts = await db.scheduledClass.findFirst({
        where: {
          leadId: input.leadId,
          status: { not: 'CANCELLED' },
          startTime: { lt: classEndTime },
          endTime: { gt: classStartTime },
        },
      });

      if (leadConflicts && !input.allowConflict) {
        throw new AppError(
          `Lead already has a scheduled class on ${classStartTime.toLocaleDateString()} at ${classStartTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          HTTP_STATUS.CONFLICT
        );
      }

      if (input.allowConflict && (mentorConflicts || leadConflicts)) {
        logger.warn(
          `[Schedule] Demo class booked over a known clash by ${scheduledById ?? 'unknown'}: ` +
            `mentor=${input.mentorId} lead=${input.leadId} at ${classStartTime.toISOString()} ` +
            `(mentor busy: ${Boolean(mentorConflicts)}, lead busy: ${Boolean(leadConflicts)}).`
        );
      }

      return db.scheduledClass.create({
        data: {
          leadId: input.leadId,
          mentorId: input.mentorId,
          scheduledById: scheduledById || null,
          programId: input.programId,
          startTime: classStartTime,
          endTime: classEndTime,
          status: 'SCHEDULED',
          classType: 'DEMO',
          meetingLink: input.meetingLink || null,
        },
      });
    }

    // 3. Construct the slots and check overlaps/conflicts for all classes
    const classesToCreate = [];
    const baseStartTime = new Date(input.startTime);

    /*
     * How far apart consecutive sessions are placed.
     *
     * WEEKLY is the default and the shape of a normal programme: same weekday,
     * same time, one lesson a week. The other two exist because real timetables
     * are not always that — an intensive run over consecutive days, or a
     * catch-up block where a child sits several sessions in one afternoon.
     *
     * SAME_DAY stacks them back to back from the chosen start, so three
     * sessions from 13:00 land at 13:00, 14:30 and 16:00.
     */
    const CLASS_DURATION_MS = 90 * 60 * 1000;
    const cadence = input.cadence || 'WEEKLY';
    const stepMsFor = (index: number): number => {
      switch (cadence) {
        case 'SAME_DAY':
          return index * CLASS_DURATION_MS;
        case 'DAILY':
          return index * 24 * 60 * 60 * 1000;
        case 'WEEKLY':
        default:
          return index * 7 * 24 * 60 * 60 * 1000;
      }
    };

    for (let i = 0; i < input.sessions!.length; i++) {
      const session = input.sessions![i];
      const classStartTime = new Date(baseStartTime.getTime() + stepMsFor(i));
      const classEndTime = new Date(classStartTime.getTime() + CLASS_DURATION_MS);

      // Check mentor conflicts (ignore cancelled classes)
      const mentorConflicts = await db.scheduledClass.findFirst({
        where: {
          mentorId: input.mentorId,
          status: { not: 'CANCELLED' },
          startTime: { lt: classEndTime },
          endTime: { gt: classStartTime },
        },
      });

      if (mentorConflicts && !input.allowConflict) {
        throw new AppError(
          `Mentor has a scheduling conflict with another class on ${classStartTime.toLocaleDateString()} at ${classStartTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          HTTP_STATUS.CONFLICT
        );
      }

      // Check student conflicts (ignore cancelled classes)
      const studentConflicts = await db.scheduledClass.findFirst({
        where: {
          studentId: input.studentId!,
          status: { not: 'CANCELLED' },
          startTime: { lt: classEndTime },
          endTime: { gt: classStartTime },
        },
      });

      if (studentConflicts && !input.allowConflict) {
        throw new AppError(
          `Student has a scheduling conflict with another class on ${classStartTime.toLocaleDateString()} at ${classStartTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          HTTP_STATUS.CONFLICT
        );
      }

      if (input.allowConflict && (mentorConflicts || studentConflicts)) {
        // Every overridden week is logged separately — a scheduler who ticks
        // the box once may be stacking twelve classes, and "which ones" is the
        // question anyone reviewing this later will ask.
        logger.warn(
          `[Schedule] Class booked over a known clash by ${scheduledById ?? 'unknown'}: ` +
            `student=${input.studentId} mentor=${input.mentorId} at ${classStartTime.toISOString()} ` +
            `(mentor busy: ${Boolean(mentorConflicts)}, student busy: ${Boolean(studentConflicts)}).`
        );
      }

      classesToCreate.push({
        studentId: input.studentId!,
        mentorId: input.mentorId,
        scheduledById: scheduledById || null,
        programId: input.programId,
        sessionId: session.id,
        startTime: classStartTime,
        endTime: classEndTime,
        status: 'SCHEDULED',
        classType: 'REGULAR',
        meetingLink: session.meetingLink || input.meetingLink || null,
        autoRecording: input.autoRecording !== undefined ? input.autoRecording : true,
      });
    }

    // 4. Create all scheduled classes atomically inside a transaction
    await db.$transaction(
      classesToCreate.map((cls) => db.scheduledClass.create({ data: cls }))
    );

    return { count: classesToCreate.length };
  },

  /**
   * Edits one class.
   *
   * This route cannot be closed to students, parents and mentors — it is how all
   * three ask for a different slot — so the gate is per field rather than per
   * role. Three tiers:
   *
   *  - ADMIN / SCHEDULER own the timetable: slot, mentor, meeting link, status
   *    and credit points.
   *  - ADMIN / QA_AUDITOR own the QA verdict: `qaStatus`, `qaFeedback`.
   *  - The people in the room may ask to move the class and say why, and that
   *    is all: `rescheduleReason`, `rescheduleMessage`, and a status flip inside
   *    the SCHEDULED ⇄ RESCHEDULE_REQUESTED pair.
   *
   * The mentor of the class is intentionally *not* granted `status` or
   * `creditsAwarded` here. Marking a class complete is `completeClass`, which
   * refuses an already-completed class and so cannot be replayed; letting the
   * same act in through this route would hand back the unbounded repeat that
   * made the original hole worth exploiting. Points reach a student by one
   * other door only — `reviewReflection`, where the mentor marks the quiz — and
   * that one moves the difference against what it already awarded rather than
   * the whole total. `creditsAwarded` here stays an admin correction tool.
   */
  async updateSchedule(id: string, input: UpdateScheduleInput, callerId?: string, callerRole?: string) {
    const classSession = await loadClassRecord(id);

    const ownsTimetable = isUnscopedStaffRole(callerRole);
    const ownsAudit = isClassAuditorRole(callerRole);

    // Staff aside, you must be in the room before any field question is even
    // asked — otherwise a stranger with a class id could still post a reschedule
    // reason onto another family's lesson.
    if (!ownsTimetable && !ownsAudit) {
      assertClassAccess(classSession, callerId, callerRole);
    }

    // Refused loudly and all at once, rather than dropped quietly: a caller who
    // is told which field was rejected can fix the request, and a caller who is
    // silently ignored believes an edit landed that never did.
    const refused: string[] = [];
    if (!ownsTimetable) {
      for (const field of TIMETABLE_UPDATE_FIELDS) {
        if (input[field] !== undefined) refused.push(field);
      }
    }
    if (!ownsAudit) {
      for (const field of AUDIT_UPDATE_FIELDS) {
        if (input[field] !== undefined) refused.push(field);
      }
    }
    if (
      input.status !== undefined &&
      !ownsTimetable &&
      !(RESCHEDULE_FLOW_STATUSES.has(input.status) && RESCHEDULE_FLOW_STATUSES.has(classSession.status))
    ) {
      // Both ends are checked, so COMPLETED and CANCELLED are unreachable as a
      // destination and a class already in either one cannot be dragged back out.
      refused.push('status');
    }
    if (refused.length > 0) {
      throw new AppError(
        `You are not allowed to change: ${[...new Set(refused)].join(', ')}`,
        HTTP_STATUS.FORBIDDEN
      );
    }

    let startTime = classSession.startTime;
    let endTime = classSession.endTime;
    let status = input.status !== undefined ? input.status : classSession.status;
    if (status === 'COMPLETED' && new Date(startTime) > new Date()) {
      throw new AppError('Cannot complete or award points to a future class session', HTTP_STATUS.BAD_REQUEST);
    }
    // Use the new mentorId if provided, else keep existing
    const effectiveMentorId = input.mentorId || classSession.mentorId;

    if (input.startTime) {
      startTime = new Date(input.startTime);
      endTime = new Date(startTime.getTime() + 90 * 60 * 1000);

      // Check if mentor has a specific slot on this weekday and time to use accurate slot duration
      if (effectiveMentorId) {
        const weekday = startTime.getDay();
        const sh = String(startTime.getHours()).padStart(2, '0');
        const sm = String(startTime.getMinutes()).padStart(2, '0');
        const timeStr = `${sh}:${sm}`;
        const slot = await db.mentorSchedule.findFirst({
          where: { mentorId: effectiveMentorId, weekday, startTime: timeStr },
        });
        if (slot) {
          const [eh, em] = slot.endTime.split(':').map(Number);
          const computedEnd = new Date(startTime.getFullYear(), startTime.getMonth(), startTime.getDate(), eh, em);
          if (computedEnd > startTime) {
            endTime = computedEnd;
          }
        }
      }

      if (status === 'RESCHEDULE_REQUESTED') {
        status = 'SCHEDULED';
      }

      // Check conflicts for mentor (excluding this class)
      const potentialMentorConflicts = await db.scheduledClass.findMany({
        where: {
          id: { not: id },
          mentorId: effectiveMentorId,
          status: { not: 'CANCELLED' },
          startTime: { lt: endTime },
        },
      });

      const mentorConflicts = potentialMentorConflicts.find((c) => {
        const cStart = c.startTime;
        const cEnd = c.endTime;
        return cStart < endTime && cEnd > startTime;
      });

      /*
       * The override is staff-only, deliberately narrower than the flag itself.
       *
       * A parent, student or mentor may move a class — that is what the
       * reschedule flow is — but none of them may force one on top of another.
       * `ownsTimetable` is the same gate that guards startTime and mentorId, so
       * a participant who posts allowConflict simply has it ignored.
       */
      const overrideConflicts = ownsTimetable && input.allowConflict === true;

      if (mentorConflicts && !overrideConflicts) {
        throw new AppError('Mentor has a scheduling conflict with another class at this time', HTTP_STATUS.CONFLICT);
      }

      // Check conflicts for student (excluding this class)
      const potentialStudentConflicts = await db.scheduledClass.findMany({
        where: {
          id: { not: id },
          studentId: classSession.studentId,
          status: { not: 'CANCELLED' },
          startTime: { lt: endTime },
        },
      });

      const studentConflicts = potentialStudentConflicts.find((c) => {
        const cStart = c.startTime;
        const cEnd = c.endTime;
        return cStart < endTime && cEnd > startTime;
      });

      if (studentConflicts && !overrideConflicts) {
        throw new AppError('Student has a scheduling conflict with another class at this time', HTTP_STATUS.CONFLICT);
      }

      if (overrideConflicts && (mentorConflicts || studentConflicts)) {
        logger.warn(
          `[Schedule] Class ${id} moved onto a known clash by ${callerId ?? 'unknown'} (${callerRole ?? 'unknown role'}): ` +
            `new window ${startTime.toISOString()}–${endTime.toISOString()} ` +
            `(mentor busy: ${Boolean(mentorConflicts)}, student busy: ${Boolean(studentConflicts)}).`
        );
      }
    }

    if (input.meetingLink !== undefined && input.updateAll !== false) {
      // Only rewrite links on classes that have NOT run yet.
      //
      // This used to rewrite every class for the student+program unconditionally.
      // Scheduling a second session therefore overwrote the earlier class's link,
      // and since a recording is matched to the Meet room it was actually held in,
      // the earlier session's recording was orphaned — no class pointed at its room
      // any more. Past classes keep the room they were genuinely taught in.
      const notYetRun = {
        startTime: { gt: new Date() },
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      };

      if (classSession.studentId) {
        const { count } = await db.scheduledClass.updateMany({
          where: {
            studentId: classSession.studentId,
            programId: classSession.programId,
            ...notYetRun,
          },
          data: {
            meetingLink: input.meetingLink,
          },
        });
        logger.info(`[Schedule] Propagated meeting link to ${count} upcoming class(es); past classes left untouched.`);
      } else if (classSession.leadId) {
        const { count } = await db.scheduledClass.updateMany({
          where: {
            leadId: classSession.leadId,
            programId: classSession.programId,
            ...notYetRun,
          },
          data: {
            meetingLink: input.meetingLink,
          },
        });
        logger.info(`[Schedule] Propagated meeting link to ${count} upcoming demo class(es); past classes left untouched.`);
      }
    }

    let creditsDiff = 0;
    if (input.creditsAwarded !== undefined && classSession.status === 'COMPLETED') {
      const oldCredits = classSession.creditsAwarded || 0;
      const newCredits = Number(input.creditsAwarded);
      creditsDiff = newCredits - oldCredits;
    }

    // A class whose slot actually moved is "postponed" from then on. Recorded as
    // a counter rather than inferred from `status`, because rescheduling puts
    // the class straight back to SCHEDULED and the move would otherwise leave
    // no trace for the attendance view.
    const slotMoved =
      Boolean(input.startTime) &&
      new Date(classSession.startTime).getTime() !== new Date(startTime).getTime();

    const updatedClass = await db.scheduledClass.update({
      where: { id },
      data: {
        startTime,
        endTime,
        status,
        ...(slotMoved ? { rescheduledCount: { increment: 1 } } : {}),
        mentorId: effectiveMentorId,
        meetingLink: input.meetingLink !== undefined ? input.meetingLink : undefined,
        rescheduleReason: input.startTime ? null : (input.rescheduleReason !== undefined ? input.rescheduleReason : undefined),
        rescheduleMessage: input.startTime ? null : (input.rescheduleMessage !== undefined ? input.rescheduleMessage : undefined),
        qaStatus: input.qaStatus !== undefined ? input.qaStatus : undefined,
        qaFeedback: input.qaFeedback !== undefined ? input.qaFeedback : undefined,
        creditsAwarded: input.creditsAwarded !== undefined ? Number(input.creditsAwarded) : undefined,
      },
      include: {
        student: {
          select: { id: true, firstName: true, lastName: true },
        },
        mentor: {
          select: { firstName: true, lastName: true },
        },
        scheduledBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });

    // Keep Google Calendar in step with the new slot. Only when the time actually
    // moved — a status or credits edit should not touch anyone's calendar.
    if (input.startTime && updatedClass.meetingLink) {
      const timeChanged =
        new Date(classSession.startTime).getTime() !== new Date(updatedClass.startTime).getTime();
      if (timeChanged) {
        await rescheduleCalendarEvent(
          updatedClass.meetingLink,
          updatedClass.startTime,
          updatedClass.endTime
        );
      }
    }

    let session = null;
    if (updatedClass.sessionId) {
      session = await db.session.findUnique({
        where: { id: updatedClass.sessionId },
      });
    }

    if (creditsDiff !== 0 && updatedClass.studentId) {
      await db.student.update({
        where: { id: updatedClass.studentId },
        data: {
          credits: { increment: creditsDiff },
        },
      });

      await sendNotification(
        updatedClass.studentId,
        'Credits Adjusted',
        `Admin adjusted points for session "${session?.title || 'Class'}": ${creditsDiff > 0 ? '+' : ''}${creditsDiff} pts.`,
        'LOW'
      );
    }

    // Same narrowing as the read path. The write gate above stops a family
    // changing anything they should not, but until this was here a student could
    // PUT an empty body — every field undefined, nothing refused, no-op write —
    // and read back the full row, answer key and transcript included.
    if (isUnscopedStaffRole(callerRole) || isClassAuditorRole(callerRole)) {
      return { ...updatedClass, session };
    }
    return {
      ...participantClassView(updatedClass as unknown as ClassRecord),
      session: redactSessionAnswerKey(session, callerRole),
    };
  },

  /**
   * Removes a class, or — with `deleteAll` — every remaining SCHEDULED class for
   * that student and programme.
   *
   * ADMIN and SCHEDULER only. There is no participant tier: `deleteAll` wipes a
   * child's entire remaining timetable in one request with no undo and no trace,
   * and a single delete destroys the attendance record of a lesson that was
   * paid for. Nothing a family legitimately does needs either; asking to move a
   * class is `updateSchedule`, and cancelling one is a status a scheduler sets.
   */
  /**
   * Delete one class, or a whole programme's worth.
   *
   * `deleteAll` used to match `status: 'SCHEDULED'` only, so a programme whose
   * sessions had already run was reported as "deleted successfully" while every
   * completed class stayed exactly where it was — `deleteMany` returning a
   * count of zero is not an error, and nothing looked at the count. The only
   * way to actually clear one was to delete each session by hand.
   *
   * Now: everything that has NOT run goes, and completed classes go only when
   * the caller explicitly asks — deleting one destroys its recording link,
   * transcript, analysis and the report a parent may already have received.
   * Either way the real numbers come back so the caller can say what happened
   * instead of assuming.
   */
  async deleteSchedule(
    id: string,
    deleteAll = false,
    callerId?: string,
    callerRole?: string,
    includeCompleted = false
  ) {
    if (!isUnscopedStaffRole(callerRole)) {
      throw new AppError(
        'Only an administrator or scheduler can delete a scheduled class',
        callerId ? HTTP_STATUS.FORBIDDEN : HTTP_STATUS.UNAUTHORIZED
      );
    }

    const classSession = await loadClassRecord(id);

    if (deleteAll) {
      const who =
        classSession.classType === 'REGULAR' && classSession.studentId
          ? { studentId: classSession.studentId }
          : classSession.classType === 'DEMO' && classSession.leadId
            ? { leadId: classSession.leadId }
            : null;

      if (who) {
        const scope = { ...who, programId: classSession.programId };

        // Counted before the delete so the caller can report what was left
        // behind, rather than a bare success on a no-op.
        const completed = await db.scheduledClass.count({
          where: { ...scope, status: 'COMPLETED' },
        });

        const { count } = await db.scheduledClass.deleteMany({
          where: includeCompleted ? scope : { ...scope, status: { not: 'COMPLETED' } },
        });

        const keptCompleted = includeCompleted ? 0 : completed;
        logger.info(
          `[Schedule] Bulk delete by ${callerId ?? 'unknown'}: removed ${count} class(es) for ` +
            `${JSON.stringify(who)} on programme ${classSession.programId}` +
            `${keptCompleted > 0 ? `, kept ${keptCompleted} completed class(es)` : ''}.`
        );

        return { count, keptCompleted };
      }
    }

    await db.scheduledClass.delete({ where: { id: classSession.id } });
    return { count: 1, keptCompleted: 0 };
  },

  /**
   * Files an issue against a class the reporter was actually in.
   *
   * The relationship test is the point. A report surfaces on the QA screen next
   * to a disciplinary panel that can warn or blacklist the mentor, the student
   * and the parent account behind them — so without it, any token holder could
   * manufacture complaints against a mentor they had never met, or against a
   * child, simply by knowing a class id.
   */
  async createReport(input: { classId: string; reporterId: string; reporterRole: string; issueType: string; description: string }) {
    const classSession = await loadClassRecord(input.classId);

    // Staff may file on someone's behalf when a family reports a problem by
    // phone; everyone else has to have been in the room.
    if (!isUnscopedStaffRole(input.reporterRole) && !isClassAuditorRole(input.reporterRole)) {
      assertClassAccess(classSession, input.reporterId, input.reporterRole);
    }

    let reporterName = 'Unknown User';
    // `isMentorRole` rather than a literal 'TEACHER': a mentor reporting under
    // INSTRUCTOR is still a row in `user`, and matching only 'TEACHER' filed
    // their report as "Unknown User".
    if (isMentorRole(input.reporterRole) || input.reporterRole === 'ADMIN') {
      const user = await db.user.findUnique({ where: { id: input.reporterId } });
      if (user) {
        reporterName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
      }
    } else if (input.reporterRole === 'PARENT') {
      const parent = await db.parentAccount.findUnique({
        where: { id: input.reporterId },
        include: { profiles: true },
      });
      if (parent && parent.profiles.length > 0) {
        reporterName = `${parent.profiles[0].firstName} ${parent.profiles[0].lastName}`;
      } else if (parent) {
        reporterName = parent.email;
      }
    } else if (input.reporterRole === 'STUDENT') {
      const student = await db.student.findUnique({ where: { id: input.reporterId } });
      if (student) {
        reporterName = `${student.firstName} ${student.lastName}`;
      }
    }

    return db.sessionReport.create({
      data: {
        classId: input.classId,
        reporterId: input.reporterId,
        reporterRole: input.reporterRole,
        reporterName,
        issueType: input.issueType,
        description: input.description,
      },
      include: {
        class: { select: REPORT_CLASS_SELECT },
      },
    });
  },

  /**
   * The session reports the caller is entitled to.
   *
   * `reporterId` used to come straight off the query string and go straight into
   * `where`, so leaving it off returned every SessionReport on the platform —
   * and each row carried its class through a top-level `include`, which meant
   * the answer key, the transcript and the AI summary of every lesson ever
   * reported came with it. One unauthenticated-in-practice GET undid the whole
   * per-class reflection gate.
   *
   * Scope now comes from the caller, exactly as `listSchedules` does it: the
   * query string may narrow what you already own and can never reach outside it.
   */
  async listReports(reporterId?: string, callerId?: string, callerRole?: string) {
    const where: any = {};

    if (isClassAuditorRole(callerRole)) {
      // The QA queue is the whole point of the role; a supplied reporterId just
      // filters it.
      if (reporterId) where.reporterId = reporterId;
    } else {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      // Everyone else — student, parent, mentor, and every staff role that is
      // not QA — sees the reports they filed themselves and nothing more.
      // Asking for someone else's matches nothing rather than leaking it.
      if (reporterId && reporterId !== callerId) return [];
      where.reporterId = callerId;
    }

    return db.sessionReport.findMany({
      where,
      // Narrow for every caller, QA included. `qa/page.tsx` reads the slot, the
      // programme and the two names; `my-reports.tsx` reads less again. Nothing
      // reads the transcript here — an auditor who needs it opens the class
      // itself, where the tier is checked properly.
      include: {
        class: { select: REPORT_CLASS_SELECT },
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Rules on a filed report and tells the reporter what was decided.
   *
   * ADMIN and QA_AUDITOR only. This writes the verdict a family is shown and
   * fires a notification in QA's name, so an open version let any token holder
   * resolve away a complaint about a mentor — including a complaint about
   * themselves — and send the child's parent a message signed by the platform.
   */
  async updateReport(
    reportId: string,
    input: { status?: string; qaFeedback?: string },
    callerId?: string,
    callerRole?: string
  ) {
    if (!isClassAuditorRole(callerRole)) {
      throw new AppError(
        'Only QA can update a session report',
        callerId ? HTTP_STATUS.FORBIDDEN : HTTP_STATUS.UNAUTHORIZED
      );
    }

    const report = await db.sessionReport.findUnique({ where: { id: reportId } });
    if (!report) {
      throw new AppError('Session report not found', HTTP_STATUS.NOT_FOUND);
    }

    const updatedReport = await db.sessionReport.update({
      where: { id: reportId },
      data: {
        status: input.status !== undefined ? input.status : undefined,
        qaFeedback: input.qaFeedback !== undefined ? input.qaFeedback : undefined,
      },
      include: {
        class: { select: REPORT_CLASS_SELECT },
      },
    });

    // Notify the reporter
    if (input.status !== undefined) {
      const displayStatus = input.status === 'RESOLVED' ? 'Resolved' : input.status === 'INVESTIGATING' ? 'Under Investigation' : 'Open';
      const feedbackNote = input.qaFeedback ? ` Comments: "${input.qaFeedback}"` : '';
      await sendNotification(
        updatedReport.reporterId,
        `Report Status: ${displayStatus}`,
        `Your reported issue against the class session is now ${displayStatus.toLowerCase()}.${feedbackNote}`,
        'MEDIUM'
      );
    }

    return updatedReport;
  },

  /**
   * The mentor's "this class happened" button. It marks the class COMPLETED and
   * nothing else.
   *
   * It used to mint credits from a number on the request body. Points are now a
   * mentor's judgement on the *work*, awarded per answer in `reviewReflection`
   * once the student has actually submitted the quiz — so completing a class
   * awards nothing at all, and there is no amount to send here. The admin
   * correction path (`updateSchedule`'s `creditsAwarded`) is a separate thing
   * and still writes the column.
   */
  async completeClass(classId: string, callerId?: string, callerRole?: string) {
    const classSession = await db.scheduledClass.findUnique({
      where: { id: classId },
      include: {
        student: { select: STUDENT_CLASS_SELECT },
        mentor: { select: MENTOR_CLASS_SELECT },
      },
    });
    if (!classSession) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // Completion no longer carries an award, but it is still what unlocks the
    // reflection quiz — and the quiz is what the points hang off. Only the
    // mentor who taught the class may say it happened; ADMIN is allowed through
    // for support fixes. Without this a student could close out a class they
    // never attended and open the quiz they get paid for.
    if (callerRole !== 'ADMIN') {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      if (!isMentorRole(callerRole) || classSession.mentorId !== callerId) {
        throw new AppError('Only the mentor of this class can mark it complete', HTTP_STATUS.FORBIDDEN);
      }
    }

    if (classSession.status === 'COMPLETED') {
      throw new AppError('Class session has already been completed', HTTP_STATUS.BAD_REQUEST);
    }
    if (new Date(classSession.startTime) > new Date()) {
      throw new AppError('Cannot complete a future class session', HTTP_STATUS.BAD_REQUEST);
    }

    let session = null;
    if (classSession.sessionId) {
      session = await db.session.findUnique({
        where: { id: classSession.sessionId },
      });
    }

    // A single write, so no transaction: the student balance update that needed
    // one has moved to `reviewReflection`, where the points are now decided.
    //
    // `completedAt` is stamped here and nowhere else. It is the anchor for the
    // whole post-class pipeline: the recording is searched for a fixed delay
    // after this instant, never after `endTime` (which is when the slot was
    // booked to end) and never after `updatedAt` (which moves whenever anything
    // on the row changes, including the report cron's own writes).
    const completedAt = new Date();
    const updatedClass = await db.scheduledClass.update({
      where: { id: classId },
      data: { status: 'COMPLETED', completedAt },
      include: {
        student: { select: STUDENT_CLASS_SELECT },
        mentor: { select: MENTOR_CLASS_SELECT },
      },
    });

    // Starts the recording clock in integration-service. Deliberately not
    // awaited for its result path — see markMeetingClassCompleted; if it fails
    // the report cron re-drives it on its next pass.
    void markMeetingClassCompleted({
      meetingLink: updatedClass.meetingLink,
      studentId: updatedClass.studentId,
      sessionId: updatedClass.sessionId,
      programId: updatedClass.programId,
      startTime: updatedClass.startTime,
      completedAt,
    });

    if (updatedClass.studentId) {
      // 1. Notify Student — the quiz is what is waiting for them, not a payout.
      await sendNotification(
        updatedClass.studentId,
        'Class Completed — Quiz Unlocked',
        `Your mentor marked "${session?.title || 'Session'}" complete. Answer the quiz to earn your points.`,
        'MEDIUM'
      );

      // 2. Notify Parent
      if (updatedClass.student?.parentAccountId) {
        await sendNotification(
          updatedClass.student.parentAccountId,
          'Student Completed Session',
          `${updatedClass.student.firstName} completed the session "${session?.title || 'Session'}". Points follow once the mentor marks the reflection quiz.`,
          'LOW'
        );
      }
    }

    return {
      ...updatedClass,
      session,
    };
  },

  /**
   * Records that a Meet room emptied after a real meeting, for whichever class
   * was using that link.
   *
   * Called by integration-service's presence poller, which can see the room but
   * cannot reach the auth schema to write this itself. Deliberately narrow:
   * it stamps `actualEndedAt` and nothing else. It does not set status, award
   * credits or notify anyone — a robot noticing an empty room is evidence the
   * class happened, not a decision that it went well.
   *
   * Idempotent, and only ever applies to the class whose slot the meeting fell
   * in: one Meet link can be shared by all 40 sessions of a programme, so
   * matching on link alone would stamp the wrong week.
   */
  async markRoomEnded(meetingLink: string, endedAt: Date) {
    if (!meetingLink) return { updated: 0 };

    // The class must have been *running* when the room emptied: started already,
    // and not so long finished that this is clearly a different session.
    //
    // Matching merely "near" the timestamp is not enough. One Meet link is shared
    // by every session of a programme, so a loose window lets a second, older
    // class match once the correct one has been stamped — which is exactly what
    // happened: a 19:10 room-end landed on a class scheduled for 20:00.
    const OVERRUN_GRACE_MS = 60 * 60 * 1000;

    const candidates = await db.scheduledClass.findMany({
      where: {
        meetingLink,
        status: { notIn: ['CANCELLED'] },
        startTime: { lte: endedAt },
        endTime: { gte: new Date(endedAt.getTime() - OVERRUN_GRACE_MS) },
      },
      select: { id: true, startTime: true, actualEndedAt: true },
      orderBy: { startTime: 'desc' },
    });

    // Only ever the single most recent class that was live at that moment. If it
    // is already stamped, this is a repeat report from the 30-second poller and
    // there is nothing to do — never fall through to an earlier class.
    const target = candidates[0];
    if (!target || target.actualEndedAt) return { updated: 0 };

    await db.scheduledClass.update({
      where: { id: target.id },
      data: { actualEndedAt: endedAt },
    });

    logger.info(
      `[Presence] Class ${target.id} recorded as actually ended at ${endedAt.toISOString()} ` +
      `(room ${meetingLink} emptied). Status left untouched for the mentor to confirm.`
    );
    return { updated: 1, classId: target.id };
  },

  async rateClass(id: string, rating: number, feedback?: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({ where: { id } });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // Only the student who sat the class may rate it. The feedback text is
    // stored on that family's record and the score moves the mentor's average,
    // so an unowned write is both a data-integrity problem and a way to brigade
    // a mentor. ADMIN is allowed through for support fixes.
    if (callerRole !== 'ADMIN') {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      if (callerRole !== 'STUDENT' || scheduledClass.studentId !== callerId) {
        throw new AppError('You can only rate your own class', HTTP_STATUS.FORBIDDEN);
      }
    }

    // You can only rate a class that actually took place. A slot whose time has
    // merely elapsed is not evidence the class ran, and rating a mentor for a
    // lesson that never happened would quietly corrupt their average. Either the
    // mentor marking it complete or the Meet room emptying after a real meeting
    // counts as evidence.
    if (deriveAttendance(scheduledClass) !== 'ATTENDED') {
      throw new AppError(
        scheduledClass.status === 'CANCELLED'
          ? 'This class was cancelled and cannot be rated'
          : 'You can rate a mentor once the class has finished',
        HTTP_STATUS.BAD_REQUEST
      );
    }
    // Narrowed on the way out. A bare `update` returns every scalar on the row —
    // transcript, reflectionAnswers, qaFeedback — which handed a student the same
    // payload `getScheduleById` deliberately withholds from them. Gating the write
    // is only half the job when the response is the leak.
    const rated = await db.scheduledClass.update({
      where: { id },
      data: {
        studentRating: rating,
        studentFeedback: feedback || undefined,
      },
    });
    return participantClassView(rated as unknown as ClassRecord);
  },

  // ── Post-class reflection ───────────────────────────────────────────────────

  /**
   * The mentor fires the quiz DURING the session. The student portal polls
   * quiz status and pops the quiz up when it sees the stamp, so mentor and
   * student can go through it together on the call. Relaunching restamps —
   * the student portal keys its popup on the timestamp, so a fresh stamp
   * pops the quiz again for a student who closed it.
   */
  async launchQuiz(classId: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: { id: true, mentorId: true, status: true, reflectionSubmittedAt: true },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // Only this class's mentor, or an admin — a launch makes a modal appear on
    // a child's screen, so it is not a thing any authenticated caller may do.
    const role = (callerRole ?? '').toUpperCase();
    if (!(role === 'ADMIN' || (isMentorRole(role) && scheduledClass.mentorId === callerId))) {
      throw new AppError('Only the class mentor or an admin can launch the quiz.', HTTP_STATUS.FORBIDDEN);
    }
    if (scheduledClass.reflectionSubmittedAt) {
      throw new AppError('The student has already submitted this quiz.', HTTP_STATUS.BAD_REQUEST);
    }
    if (scheduledClass.status === 'CANCELLED') {
      throw new AppError('This class was cancelled.', HTTP_STATUS.BAD_REQUEST);
    }

    const updated = await db.scheduledClass.update({
      where: { id: classId },
      data: { quizLaunchedAt: new Date() },
      select: { quizLaunchedAt: true },
    });
    return { launchedAt: updated.quizLaunchedAt };
  },

  /**
   * The RAW transcript the summary was generated from — for verifying what the
   * pipeline actually heard when a report looks wrong. Mentor-of-class or
   * admin only: it is a verbatim record of a child's session.
   */
  async getRawTranscript(classId: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: { id: true, mentorId: true, transcript: true, transcriptionStatus: true, updatedAt: true },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }
    const role = (callerRole ?? '').toUpperCase();
    if (!(role === 'ADMIN' || (isMentorRole(role) && scheduledClass.mentorId === callerId))) {
      throw new AppError('Only the class mentor or an admin can read the raw transcript.', HTTP_STATUS.FORBIDDEN);
    }
    return {
      transcript: scheduledClass.transcript ?? null,
      length: scheduledClass.transcript?.length ?? 0,
      transcriptionStatus: scheduledClass.transcriptionStatus,
    };
  },

  /**
   * Lightweight poll target: has the quiz been launched, and has the student
   * submitted? Polled every few seconds by the student portal during a live
   * class and by the mentor's panel after a launch, so it reads one row and
   * nothing else.
   */
  async getQuizStatus(classId: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        studentId: true,
        mentorId: true,
        quizLaunchedAt: true,
        reflectionSubmittedAt: true,
        reflectionScore: true,
        reflectionMaxScore: true,
        reflectionBadge: true,
        student: { select: { parentAccountId: true } },
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }
    assertClassAccess(scheduledClass as any, callerId, callerRole);

    return {
      launched: Boolean(scheduledClass.quizLaunchedAt),
      launchedAt: scheduledClass.quizLaunchedAt,
      submitted: Boolean(scheduledClass.reflectionSubmittedAt),
      submittedAt: scheduledClass.reflectionSubmittedAt,
      score: scheduledClass.reflectionScore,
      maxScore: scheduledClass.reflectionMaxScore,
      badge: scheduledClass.reflectionBadge,
    };
  },

  /**
   * The quiz a student must answer for a given class, plus whatever they have
   * already submitted. Questions come from the curriculum session; a session
   * with no custom quiz falls back to its text prompts, then to the platform
   * defaults, so there is always something to answer.
   */
  async getReflection(classId: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        studentId: true,
        mentorId: true,
        sessionId: true,
        status: true,
        startTime: true,
        endTime: true,
        reflectionAnswers: true,
        reflectionSubmittedAt: true,
        reflectionScore: true,
        reflectionMaxScore: true,
        reflectionBadge: true,
        reflectionReviewedAt: true,
        reflectionReviewedById: true,
        reflectionMentorNote: true,
        student: { select: { parentAccountId: true } },
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // The same three-way ownership test `listDoubts` runs. Two separate things
    // ride on it: `answers` holds the child's free text, and — for a caller who
    // clears `canSeeAnswerKey` below — the payload carries the marking scheme
    // for a quiz other children have not sat yet. It also carries the mentor's
    // per-answer points and remarks about this one child.
    assertClassAccess(scheduledClass, callerId, callerRole);

    const session = scheduledClass.sessionId
      ? await db.session.findUnique({
          where: { id: scheduledClass.sessionId },
          select: { title: true, order: true, reflectionQuestions: true, reflectionQuiz: true, topics: true },
        })
      : null;

    const quiz = effectiveReflectionQuiz(session?.reflectionQuiz, session?.reflectionQuestions);

    return {
      classId: scheduledClass.id,
      studentId: scheduledClass.studentId,
      sessionId: scheduledClass.sessionId,
      sessionTitle: session?.title ?? null,
      sessionOrder: session?.order ?? null,
      // `questions` keeps the plain-string shape older clients read; `quiz`
      // carries the typed version with images, options and points.
      //
      // The answer key used to be stripped unconditionally, on the grounds that
      // reviewers read the graded answers instead — but nothing is graded at
      // submit any more, so the mentor marking an MCQ has no other way to know
      // which option was intended and cannot mark it fairly. `canSeeAnswerKey`
      // is the shared rule: staff and mentors keep the key, the student sitting
      // the quiz and their parent still get it stripped. The ownership gate
      // above already refused everyone who was not in this room.
      questions: effectiveReflectionQuestions(session?.reflectionQuestions ?? null),
      quiz: canSeeAnswerKey(callerRole) ? quiz : stripAnswerKey(quiz),
      // Each entry carries the mentor's award and remark for that answer once
      // they have marked it, which is how the student is shown *why* they got
      // the points. Never the answer key — see `ReflectionAnswerEntry`.
      answers: (scheduledClass.reflectionAnswers as ReflectionEntry[] | null) ?? null,
      submittedAt: scheduledClass.reflectionSubmittedAt,
      // Null until a mentor marks the quiz. Submitting scores nothing, so
      // "submitted, waiting for your mentor" is submittedAt set with these null.
      score: scheduledClass.reflectionScore,
      maxScore: scheduledClass.reflectionMaxScore,
      badge: scheduledClass.reflectionBadge,
      awaitingReview: Boolean(scheduledClass.reflectionSubmittedAt && !scheduledClass.reflectionReviewedAt),
      // The mentor's sign-off, and the reply they wrote to what the student
      // said. `reviewReflection` has always stored these, but until now no
      // student-facing endpoint returned them, so the note was written and
      // never delivered — the notification promised a reply the student had
      // nowhere to read.
      reviewedAt: scheduledClass.reflectionReviewedAt,
      reviewedById: scheduledClass.reflectionReviewedById,
      mentorNote: scheduledClass.reflectionMentorNote,
    };
  },

  /**
   * Stores a student's reflection. It scores nothing.
   *
   * The snapshot is taken against the server's copy of the quiz — question text,
   * type and worth are copied in — so a client cannot invent prompts, inflate
   * what a question was worth, or have a later admin edit silently reword what
   * it was asked. What it deliberately does *not* do is mark any of it:
   * `reflectionScore`, `reflectionMaxScore` and `reflectionBadge` are left null
   * and every answer is stored unmarked, because the points are the mentor's
   * judgement and the badge follows their total. The student sees "submitted,
   * waiting for your mentor" until `reviewReflection` runs.
   */
  async submitReflection(
    classId: string,
    responses: ReflectionResponse[],
    callerId?: string,
    callerRole?: string
  ) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        studentId: true,
        sessionId: true,
        status: true,
        startTime: true,
        endTime: true,
        actualEndedAt: true,
        rescheduledCount: true,
        reflectionSubmittedAt: true,
        quizLaunchedAt: true,
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // One attempt per class.
    //
    // The lock predates mentor marking — a graded response used to hand back
    // `correct` per question, which made unlimited resubmission an answer
    // oracle. Nothing is graded at submit any more, so that particular loop is
    // closed either way, but the lock stays for a plainer reason: the mentor
    // marks these exact answers, and a student who could overwrite them after
    // the marking started would be revising work someone is part-way through
    // paying for. ADMIN can still overwrite to fix a genuine mistake.
    if (callerRole !== 'ADMIN' && scheduledClass.reflectionSubmittedAt) {
      throw new AppError(
        'You have already submitted this quiz — ask your mentor if you need it reopened',
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Only the student who attended may answer. ADMIN is allowed through for
    // support fixes; every other role is rejected outright.
    const isAdmin = callerRole === 'ADMIN';
    if (!isAdmin) {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      if (scheduledClass.studentId !== callerId) {
        throw new AppError('You can only submit a reflection for your own class', HTTP_STATUS.FORBIDDEN);
      }
    }

    // You can only reflect on a class you actually attended. Two things prove
    // that: the mentor marked it complete, or the Meet room was used and then
    // emptied. A slot whose clock simply ran out proves nothing — it is
    // indistinguishable from the student never turning up — so it is refused.
    // ADMIN bypasses for support fixes.
    if (callerRole !== 'ADMIN') {
      if (scheduledClass.status === 'CANCELLED') {
        throw new AppError('This class was cancelled', HTTP_STATUS.BAD_REQUEST);
      }
      // The quiz opens once the class has STARTED — or the mentor has launched
      // it live — and no longer waits for the mentor to mark the class
      // complete. The live-quiz flow depends on this: the mentor fires the
      // quiz mid-session, while the class is still SCHEDULED, and the student
      // answers it on the call.
      const started = scheduledClass.startTime.getTime() <= Date.now();
      if (!started && !scheduledClass.quizLaunchedAt) {
        throw new AppError('This class has not started yet', HTTP_STATUS.BAD_REQUEST);
      }
    }

    const session = scheduledClass.sessionId
      ? await db.session.findUnique({
          where: { id: scheduledClass.sessionId },
          select: { reflectionQuestions: true, reflectionQuiz: true },
        })
      : null;

    const quiz = effectiveReflectionQuiz(session?.reflectionQuiz, session?.reflectionQuestions);
    const snapshot = snapshotReflection(quiz, responses);

    if (snapshot.answeredCount === 0) {
      throw new AppError('Answer at least one question before submitting', HTTP_STATUS.BAD_REQUEST);
    }

    const updated = await db.$transaction(async (tx) => {
      // Only ADMIN reaches this with a submission already on the row, and
      // replacing the answers throws away the marks attached to them. Whatever
      // the mentor had already paid out for those answers is taken back with
      // them: leaving the credits behind while zeroing the record of them would
      // make the next evaluation award the full amount a second time, which is
      // the unbounded-minting bug this whole path is written to avoid.
      const current = await tx.scheduledClass.findUnique({
        where: { id: classId },
        select: { studentId: true, reflectionAnswers: true },
      });
      const clawback = mentorAwardedTotal(current?.reflectionAnswers as ReflectionAnswerEntry[] | null);

      const row = await tx.scheduledClass.update({
        where: { id: classId },
        data: {
          reflectionAnswers: snapshot.entries as any,
          reflectionSubmittedAt: new Date(),
          // Score, max and badge stay null on purpose. Writing 0 here would make
          // "not marked yet" indistinguishable from "marked and scored nothing" —
          // `getStudentOverview` counts any number as a marked quiz.
          reflectionScore: null,
          reflectionMaxScore: null,
          reflectionBadge: null,
          // A sign-off belongs to the answers it was given for. These are new
          // answers, so the class goes back into the marking queue.
          reflectionReviewedAt: null,
          reflectionReviewedById: null,
          reflectionMentorNote: null,
        },
        select: {
          id: true,
          reflectionAnswers: true,
          reflectionSubmittedAt: true,
          reflectionScore: true,
          reflectionMaxScore: true,
          reflectionBadge: true,
        },
      });

      if (clawback > 0 && current?.studentId) {
        await tx.student.update({
          where: { id: current.studentId },
          data: { credits: { decrement: clawback } },
        });
        logger.warn(
          `[Reflection] Class ${classId} resubmitted over a marked reflection — reclaimed ${clawback} credit points`
        );
      }

      return row;
    });

    logger.info(
      `[Reflection] Student ${scheduledClass.studentId} submitted reflection for class ${classId} ` +
      `— ${snapshot.answeredCount}/${snapshot.entries.length} answered, awaiting mentor marking`
    );
    // The score/max/badge keys are kept (null) so the client shape does not
    // change; `awaitingReview` is what it should actually be reading.
    return {
      ...updated,
      badge: null,
      answeredCount: snapshot.answeredCount,
      pointsAvailable: snapshot.maxScore,
      awaitingReview: true,
    };
  },

  /**
   * The mentor's evaluation of a submitted reflection: points per answer, an
   * optional remark on each, an optional overall note, and the sign-off.
   *
   * This is where a reflection is actually marked. Nothing scores the quiz at
   * submit, so the mentor's per-answer awards *are* the score: their sum is
   * `reflectionScore`, the sum of what the questions are worth is
   * `reflectionMaxScore`, and the badge follows from the two on the same
   * Gold/Silver/Bronze thresholds as before. The awarded total is then added to
   * the student's credit balance — the points are the reward, and completing a
   * class no longer pays anything on its own.
   *
   * `marks` is optional. Omitting it keeps the endpoint's original behaviour —
   * a sign-off and a note, no score and no credits — which is what an older
   * client posting only `{ note }` gets.
   *
   * Re-marking is expected: a mentor may fix a number they got wrong, or mark
   * the quiz in passes. So the credit movement is a *difference* against what
   * the entries were already carrying, never the whole total again.
   */
  async reviewReflection(
    classId: string,
    note?: string,
    marks?: ReflectionMentorMark[],
    callerId?: string,
    callerRole?: string
  ) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        studentId: true,
        mentorId: true,
        sessionId: true,
        reflectionSubmittedAt: true,
        student: { select: { firstName: true, parentAccountId: true } },
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // Only the mentor who taught this class may mark it. ADMIN is allowed
    // through for support fixes; every other role — including other mentors on
    // the platform — is rejected outright. Unchanged by the move to
    // mentor-awarded points: the same person who signs off is the one who pays.
    if (callerRole !== 'ADMIN') {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      if (!isMentorRole(callerRole) || scheduledClass.mentorId !== callerId) {
        throw new AppError('Only the mentor of this class can review its reflection', HTTP_STATUS.FORBIDDEN);
      }
    }

    // Marks have nothing to attach to before the student has answered.
    if (!scheduledClass.reflectionSubmittedAt) {
      throw new AppError('There is no submitted reflection to review yet', HTTP_STATUS.BAD_REQUEST);
    }

    const trimmedNote = typeof note === 'string' ? note.trim() : '';
    const evaluating = Array.isArray(marks) && marks.length > 0;
    const reviewedAt = new Date();

    const { updated, awarded, creditsDiff } = await db.$transaction(async (tx) => {
      // Read inside the transaction. The baseline for the credit difference has
      // to be the row as it is at the moment of the write — reading it before
      // the transaction and incrementing after is the race a double-clicked
      // Save wins, and it pays twice.
      const current = await tx.scheduledClass.findUnique({
        where: { id: classId },
        select: { studentId: true, reflectionAnswers: true, reflectionScore: true },
      });
      if (!current) {
        throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
      }

      const data: Record<string, unknown> = {
        reflectionReviewedAt: reviewedAt,
        reflectionReviewedById: callerId ?? null,
        // Reviewing with an empty note clears the old one: leaving a previous
        // reply attached to a fresh sign-off would misattribute it.
        reflectionMentorNote: trimmedNote || null,
      };

      let evaluated: ReturnType<typeof applyMentorMarks> | null = null;
      if (evaluating) {
        try {
          // Validation lives in the shared helper and reads the ceiling off the
          // *stored* entries, which the server wrote at submit. A ceiling taken
          // from the request would be a number the client chooses.
          evaluated = applyMentorMarks(
            current.reflectionAnswers as ReflectionAnswerEntry[] | null,
            marks as ReflectionMentorMark[],
            reviewedAt
          );
        } catch (err) {
          throw new AppError((err as Error).message, HTTP_STATUS.BAD_REQUEST);
        }
        data.reflectionAnswers = evaluated.entries as any;
        data.reflectionScore = evaluated.score;
        data.reflectionMaxScore = evaluated.maxScore;
        data.reflectionBadge = evaluated.badge?.id ?? null;
      }

      // Compare-and-set on the score this evaluation was computed against, so a
      // second concurrent save of the same marking finds the row already moved
      // and is refused rather than crediting on top of the first.
      const applied = await tx.scheduledClass.updateMany({
        where: { id: classId, reflectionScore: current.reflectionScore },
        data: data as any,
      });
      if (applied.count === 0) {
        throw new AppError(
          'This reflection was marked by someone else a moment ago — reload it and try again',
          HTTP_STATUS.CONFLICT
        );
      }

      const row = await tx.scheduledClass.findUnique({
        where: { id: classId },
        select: {
          id: true,
          reflectionAnswers: true,
          reflectionSubmittedAt: true,
          reflectionScore: true,
          reflectionMaxScore: true,
          reflectionBadge: true,
          reflectionReviewedAt: true,
          reflectionReviewedById: true,
          reflectionMentorNote: true,
        },
      });
      if (!row) {
        throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
      }

      // The difference, never the total. `previousScore` is what the stored
      // entries were already marked at, so re-saving an unchanged evaluation
      // moves 0, raising an answer from 3 to 5 moves +2, and lowering it moves
      // -2. Awarding `evaluated.score` here instead would mint the whole quiz
      // again on every edit — the same shape of bug the admin `creditsAwarded`
      // path was fixed for.
      const diff = evaluated ? evaluated.score - evaluated.previousScore : 0;
      if (diff !== 0 && current.studentId) {
        await tx.student.update({
          where: { id: current.studentId },
          data: { credits: { increment: diff } },
        });
      }

      return { updated: row, awarded: evaluated, creditsDiff: diff };
    });

    if (scheduledClass.studentId) {
      const scoreLine = awarded ? ` You scored ${awarded.score}/${awarded.maxScore}.` : '';
      const pointsLine =
        creditsDiff > 0
          ? ` +${creditsDiff} credit points have been added to your balance.`
          : creditsDiff < 0
            ? ` Your balance was corrected by ${creditsDiff} credit points.`
            : '';
      await sendNotification(
        scheduledClass.studentId,
        awarded ? 'Your mentor marked your quiz' : 'Your mentor reviewed your quiz',
        (trimmedNote
          ? `Your mentor left you a note: "${trimmedNote}"`
          : 'Your mentor has gone through your reflection answers.') + scoreLine + pointsLine,
        awarded ? 'MEDIUM' : 'LOW'
      );

      // The parent used to hear about points when the class was completed. That
      // notification was removed with the award, so this is where they hear now.
      if (awarded && creditsDiff !== 0 && scheduledClass.student?.parentAccountId) {
        await sendNotification(
          scheduledClass.student.parentAccountId,
          'Quiz Marked',
          `${scheduledClass.student.firstName ?? 'Your child'} scored ${awarded.score}/${awarded.maxScore} on their reflection quiz (${creditsDiff > 0 ? '+' : ''}${creditsDiff} credit points).`,
          'LOW'
        );
      }
    }

    logger.info(
      `[Reflection] Class ${classId} ${awarded ? 'marked' : 'signed off'} by ${callerId ?? 'unknown caller'}` +
        (awarded
          ? ` — ${awarded.score}/${awarded.maxScore}${awarded.badge ? ` (${awarded.badge.id})` : ''}, ` +
            `${awarded.markedCount}/${awarded.totalCount} answers marked, credits ${creditsDiff >= 0 ? '+' : ''}${creditsDiff}`
          : '')
    );

    // `creditsDelta`, not `creditsAwarded`: it is how far the balance moved this
    // time, which on a revision is the difference and can be negative. The
    // column of that name is the admin correction tool and means something else.
    return {
      ...updated,
      badge: awarded?.badge ?? null,
      creditsDelta: creditsDiff,
      markedCount: awarded?.markedCount ?? 0,
      totalCount: awarded?.totalCount ?? 0,
    };
  },

  // ── Class doubts ────────────────────────────────────────────────────────────

  /**
   * Records a question the student had after a class.
   *
   * Tied to a class on purpose: "I didn't follow that bit" is only answerable if
   * the mentor knows which lesson it came from.
   */
  async createDoubt(classId: string, question: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: { id: true, studentId: true, mentorId: true, sessionId: true, status: true },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // Deliberately no ADMIN bypass, unlike the other gates in this file: the row
    // is stored and shown to the mentor as the student's own words, so nobody —
    // not the parent, not the mentor, not support — may author one for them.
    if (!callerId) {
      throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
    }
    if (callerRole !== 'STUDENT' || scheduledClass.studentId !== callerId) {
      throw new AppError('You can only ask a question about your own class', HTTP_STATUS.FORBIDDEN);
    }

    if (scheduledClass.status === 'CANCELLED') {
      throw new AppError('This class was cancelled', HTTP_STATUS.BAD_REQUEST);
    }

    const text = typeof question === 'string' ? question.trim() : '';
    if (!text) {
      throw new AppError('Type your question before sending it', HTTP_STATUS.BAD_REQUEST);
    }
    if (text.length > DOUBT_QUESTION_MAX) {
      throw new AppError(`A question can be at most ${DOUBT_QUESTION_MAX} characters`, HTTP_STATUS.BAD_REQUEST);
    }

    const doubt = await db.classDoubt.create({
      data: { classId, studentId: callerId, question: text },
    });

    if (scheduledClass.mentorId) {
      const session = scheduledClass.sessionId
        ? await db.session.findUnique({ where: { id: scheduledClass.sessionId }, select: { title: true } })
        : null;
      await sendNotification(
        scheduledClass.mentorId,
        'New question from a student',
        `A student asked a question about "${session?.title || 'their class'}". It is waiting in your doubts inbox.`,
        'MEDIUM'
      );
    }

    logger.info(`[Doubt] Student ${callerId} raised a doubt on class ${classId}`);
    return doubt;
  },

  /** Every question raised against one class, newest first. */
  async listDoubts(classId: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        studentId: true,
        mentorId: true,
        student: { select: { parentAccountId: true } },
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // The same relationship test `getStudentOverview` runs, narrowed to a single
    // class: the student who sat it, their parent, the mentor who taught it.
    // Shared with `getReflection`, which gates on exactly the same thing.
    assertClassAccess(scheduledClass, callerId, callerRole);

    return db.classDoubt.findMany({
      where: { classId },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * The mentor's queue of unanswered questions across every class they teach.
   *
   * Each row carries its lesson and its student, because a question read out of
   * context cannot be answered — and a mentor working through a backlog should
   * not have to open a class page per question to find out what it is about.
   */
  async listDoubtInbox(callerId?: string, callerRole?: string) {
    const isAdmin = callerRole === 'ADMIN';
    if (!isAdmin) {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      if (!isMentorRole(callerRole)) {
        throw new AppError('Only mentors can read the doubts inbox', HTTP_STATUS.FORBIDDEN);
      }
    }

    const doubts = await db.classDoubt.findMany({
      // Scoped through the class's mentor rather than the doubt itself: a doubt
      // belongs to a lesson, and whoever taught that lesson owns answering it.
      // ADMIN sees the whole platform's backlog.
      where: {
        status: 'OPEN',
        ...(isAdmin ? {} : { class: { mentorId: callerId } }),
      },
      include: {
        class: {
          select: {
            id: true,
            startTime: true,
            endTime: true,
            status: true,
            classType: true,
            programId: true,
            sessionId: true,
            mentorId: true,
            meetingLink: true,
            reflectionSubmittedAt: true,
            student: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const sessionIds = [...new Set(doubts.map((d) => d.class.sessionId).filter(Boolean))] as string[];
    const sessions = sessionIds.length
      ? await db.session.findMany({
          where: { id: { in: sessionIds } },
          select: { id: true, title: true, order: true },
        })
      : [];
    const sessionById = new Map(sessions.map((s) => [s.id, s]));

    return doubts.map((d) => {
      const session = d.class.sessionId ? sessionById.get(d.class.sessionId) : undefined;
      return {
        id: d.id,
        classId: d.classId,
        studentId: d.studentId,
        question: d.question,
        status: d.status,
        answer: d.answer,
        answeredAt: d.answeredAt,
        answeredById: d.answeredById,
        answeredByName: d.answeredByName,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        // Safe to read the author off the class: `createDoubt` only ever lets the
        // owning student write one, so the two student ids cannot diverge.
        student: d.class.student,
        class: {
          id: d.class.id,
          startTime: d.class.startTime,
          endTime: d.class.endTime,
          status: d.class.status,
          classType: d.class.classType,
          programId: d.class.programId,
          sessionId: d.class.sessionId,
          sessionTitle: session?.title ?? null,
          sessionOrder: session?.order ?? null,
          mentorId: d.class.mentorId,
          meetingLink: d.class.meetingLink,
          reflectionSubmittedAt: d.class.reflectionSubmittedAt,
        },
      };
    });
  },

  /** The mentor's reply. Re-answering an answered doubt overwrites it. */
  async answerDoubt(doubtId: string, answer: string, callerId?: string, callerRole?: string) {
    const doubt = await db.classDoubt.findUnique({
      where: { id: doubtId },
      include: { class: { select: { id: true, mentorId: true, studentId: true, sessionId: true } } },
    });
    if (!doubt) {
      throw new AppError('Question not found', HTTP_STATUS.NOT_FOUND);
    }

    if (callerRole !== 'ADMIN') {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      if (!isMentorRole(callerRole) || doubt.class.mentorId !== callerId) {
        throw new AppError('Only the mentor of this class can answer its questions', HTTP_STATUS.FORBIDDEN);
      }
    }

    const text = typeof answer === 'string' ? answer.trim() : '';
    if (!text) {
      throw new AppError('Type an answer before sending it', HTTP_STATUS.BAD_REQUEST);
    }
    if (text.length > DOUBT_ANSWER_MAX) {
      throw new AppError(`An answer can be at most ${DOUBT_ANSWER_MAX} characters`, HTTP_STATUS.BAD_REQUEST);
    }

    // Resolved server-side and never taken from the body: this name is shown to
    // the student as the person who replied, so a caller must not get to choose it.
    let answeredByName = 'Your mentor';
    if (callerId) {
      const user = await db.user.findUnique({
        where: { id: callerId },
        select: { firstName: true, lastName: true, email: true },
      });
      if (user) {
        answeredByName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
      }
    }

    const updated = await db.classDoubt.update({
      where: { id: doubtId },
      data: {
        answer: text,
        answeredAt: new Date(),
        answeredById: callerId ?? null,
        answeredByName,
        status: 'ANSWERED',
      },
    });

    await sendNotification(
      doubt.studentId,
      'Your question was answered',
      `${answeredByName} replied to the question you asked about your class.`,
      'MEDIUM'
    );

    logger.info(`[Doubt] Doubt ${doubtId} on class ${doubt.classId} answered by ${callerId ?? 'unknown caller'}`);
    return updated;
  },

  /**
   * Everything known about one student's journey on a programme: attendance per
   * class, reflection answers and scores, points, and progress against the
   * curriculum.
   *
   * Exists so a mentor can answer a parent's question without piecing it
   * together from three different screens. Deliberately spans *all* the
   * student's classes rather than only the caller's, since a substitute mentor
   * covering one week should still see the full picture.
   */
  async getStudentOverview(studentId: string, callerId?: string, callerRole?: string) {
    const student = await db.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        studentCode: true,
        firstName: true,
        lastName: true,
        email: true,
        avatarUrl: true,
        credits: true,
        timezone: true,
        isActive: true,
        createdAt: true,
        parentAccountId: true,
        parentAccount: {
          select: {
            id: true,
            email: true,
            paymentApproved: true,
            selectedPlanType: true,
            profiles: { select: { firstName: true, lastName: true, phone: true, relationship: true } },
          },
        },
      },
    });
    if (!student) {
      throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);
    }

    const classes = await db.scheduledClass.findMany({
      where: { studentId },
      include: {
        mentor: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { startTime: 'asc' },
    });

    // A mentor may read the record of any student they actually teach; the
    // student and their parent may read their own. Everyone else is refused,
    // including other mentors on the platform.
    if (callerRole !== 'ADMIN') {
      const permitted =
        // `isMentorRole`, not a literal 'TEACHER': a mentor arriving under
        // INSTRUCTOR was being refused their own student's record.
        (isMentorRole(callerRole) && classes.some((c) => c.mentorId === callerId)) ||
        (callerRole === 'STUDENT' && callerId === studentId) ||
        (callerRole === 'PARENT' && callerId === student.parentAccountId);
      if (!permitted) {
        throw new AppError('You do not have access to this student record', HTTP_STATUS.FORBIDDEN);
      }
    }

    const sessionIds = [...new Set(classes.map((c) => c.sessionId).filter(Boolean))] as string[];
    const programIds = [...new Set(classes.map((c) => c.programId).filter(Boolean))] as string[];
    const classIds = classes.map((c) => c.id);

    const [sessions, programs, doubts] = await Promise.all([
      sessionIds.length
        ? db.session.findMany({
            where: { id: { in: sessionIds } },
            select: { id: true, title: true, order: true, credits: true, programId: true, topics: true },
          })
        : Promise.resolve([]),
      programIds.length
        ? db.program.findMany({
            where: { id: { in: programIds } },
            select: { id: true, title: true, _count: { select: { sessions: true } } },
          })
        : Promise.resolve([]),
      classIds.length
        ? db.classDoubt.findMany({
            where: { classId: { in: classIds } },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
    ]);

    const sessionById = new Map(sessions.map((s) => [s.id, s]));

    // Grouped in memory rather than per class: one query for the whole timeline.
    const doubtsByClass = new Map<string, (typeof doubts)[number][]>();
    for (const d of doubts) {
      const existing = doubtsByClass.get(d.classId);
      if (existing) existing.push(d);
      else doubtsByClass.set(d.classId, [d]);
    }

    const now = Date.now();

    const timeline = classes.map((c) => {
      const session = c.sessionId ? sessionById.get(c.sessionId) : undefined;
      const answers = (c.reflectionAnswers as ReflectionEntry[] | null) ?? null;
      const classDoubts = doubtsByClass.get(c.id) ?? [];
      return {
        id: c.id,
        programId: c.programId,
        sessionId: c.sessionId,
        sessionTitle: session?.title ?? null,
        sessionOrder: session?.order ?? null,
        startTime: c.startTime,
        endTime: c.endTime,
        status: c.status,
        classType: c.classType,
        attendance: deriveAttendance(c, now),
        actualEndedAt: c.actualEndedAt,
        rescheduledCount: c.rescheduledCount,
        rescheduleReason: c.rescheduleReason,
        creditsAwarded: c.creditsAwarded,
        studentRating: c.studentRating,
        studentFeedback: c.studentFeedback,
        mentor: c.mentor,
        meetingLink: c.meetingLink,
        recordingUrl: c.recordingUrl,
        // Parents read the AI summary of a finished class here; it is the one
        // view of the lesson they get without sitting through the recording.
        classSummary: c.classSummary,
        transcriptionStatus: c.transcriptionStatus,
        // Lets the caller fetch this one class's recordings from
        // integration-service without ever being handed the full archive.
        // Only issued for classes that have actually finished.
        mediaGrant:
          isOver(c, now) && extractMeetCode(c.meetingLink)
            ? createClassMediaGrant(c.id, extractMeetCode(c.meetingLink) as string)
            : null,
        reflection: {
          submittedAt: c.reflectionSubmittedAt,
          score: c.reflectionScore,
          maxScore: c.reflectionMaxScore,
          badge: c.reflectionBadge,
          answers,
          pending: owesReflection(c, now),
          // Submitted and nobody has marked it yet. Score/badge are null in that
          // state — nothing is scored until a mentor says so — so this is what
          // tells "waiting for the mentor" apart from "marked and scored zero".
          awaitingReview: Boolean(c.reflectionSubmittedAt && !c.reflectionReviewedAt),
          // The mentor's sign-off: it is also when the points were decided, so
          // this doubles as "has this quiz been marked".
          reviewedAt: c.reflectionReviewedAt,
          reviewedById: c.reflectionReviewedById,
          mentorNote: c.reflectionMentorNote,
        },
        doubts: {
          total: classDoubts.length,
          open: classDoubts.filter((d) => d.status === 'OPEN').length,
          items: classDoubts.map((d) => ({
            id: d.id,
            question: d.question,
            status: d.status,
            answer: d.answer,
            answeredAt: d.answeredAt,
            answeredByName: d.answeredByName,
            createdAt: d.createdAt,
          })),
        },
      };
    });

    const tally = (state: string) => timeline.filter((t) => t.attendance === state).length;
    const reflectionsDone = timeline.filter((t) => t.reflection.submittedAt);
    const scored = reflectionsDone.filter((t) => typeof t.reflection.score === 'number' && t.reflection.maxScore);
    const ratings = timeline.filter((t) => typeof t.studentRating === 'number');

    // Curriculum reach: the furthest session order actually completed.
    const reachedOrder = timeline
      .filter((t) => t.attendance === 'ATTENDED' && typeof t.sessionOrder === 'number')
      .reduce((max, t) => Math.max(max, t.sessionOrder as number), 0);

    const curriculumTotal = programs.reduce((sum, p) => sum + (p._count?.sessions ?? 0), 0);

    return {
      student: {
        ...student,
        parentName: student.parentAccount?.profiles?.[0]
          ? `${student.parentAccount.profiles[0].firstName} ${student.parentAccount.profiles[0].lastName}`.trim()
          : null,
      },
      programs: programs.map((p) => ({ id: p.id, title: p.title, sessionCount: p._count?.sessions ?? 0 })),
      stats: {
        totalScheduled: timeline.length,
        attended: tally('ATTENDED'),
        missed: tally('MISSED'),
        postponed: tally('POSTPONED'),
        cancelled: tally('CANCELLED'),
        upcoming: tally('UPCOMING'),
        points: student.credits,
        reachedOrder,
        curriculumTotal,
        reflectionsSubmitted: reflectionsDone.length,
        reflectionsPending: timeline.filter((t) => t.reflection.pending).length,
        reflectionsReviewed: reflectionsDone.filter((t) => t.reflection.reviewedAt).length,
        // A real queue now, not a formality: an unmarked quiz has earned the
        // student nothing yet, so this is the count of work owed to them.
        reflectionsAwaitingReview: reflectionsDone.filter((t) => t.reflection.awaitingReview).length,
        doubtsTotal: timeline.reduce((sum, t) => sum + t.doubts.total, 0),
        doubtsOpen: timeline.reduce((sum, t) => sum + t.doubts.open, 0),
        // Average of the score percentages, not of the raw scores — quizzes can
        // be worth different totals, so raw averages would be meaningless.
        // Over *marked* quizzes only: a submitted-but-unmarked one has a null
        // score and no percentage to average, and counting it as zero would
        // punish the student for the mentor not having got to it yet.
        averageQuizPercent: scored.length
          ? Math.round(
              scored.reduce(
                (sum, t) => sum + ((t.reflection.score as number) / (t.reflection.maxScore as number)) * 100,
                0
              ) / scored.length
            )
          : null,
        badges: {
          GOLD: reflectionsDone.filter((t) => t.reflection.badge === 'GOLD').length,
          SILVER: reflectionsDone.filter((t) => t.reflection.badge === 'SILVER').length,
          BRONZE: reflectionsDone.filter((t) => t.reflection.badge === 'BRONZE').length,
        },
        averageRatingGiven: ratings.length
          ? Number((ratings.reduce((sum, t) => sum + (t.studentRating as number), 0) / ratings.length).toFixed(1))
          : null,
      },
      timeline,
    };
  },
};

/**
 * One answered prompt, snapshotted at submit time and marked afterwards.
 *
 * The read-side, tolerant twin of `ReflectionAnswerEntry` in
 * `@futurespark/constants` — kept because rows written before the quiz existed
 * hold only `question` and `answer`, and rows written before mentor marking
 * carry the old auto-grader's `correct` and `pointsEarned`. Everything else is
 * optional so all of them still deserialise, and readers must treat every
 * optional field as possibly absent. Keep it in step with the constants type.
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
