import { db } from '../../database/datasource';
import { notifyInternal, formatWhen } from '../shared/internal-notify';
import { CreateScheduleInput, UpdateScheduleInput } from './schedule.schema';
import { AppError } from '@futurespark/middleware';
import {
  HTTP_STATUS,
  effectiveReflectionQuestions,
  effectiveReflectionQuiz,
  effectiveSessionTopics,
  snapshotReflection,
  DEFAULT_REFLECTION_POINTS,
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
import {
  isOver,
  isMentorRole,
  isUnscopedStaffRole,
  isWallDisplayRole,
  isClassAuditorRole,
  redactSessionAnswerKey,
  assertClassAccess,
  STUDENT_CLASS_SELECT,
  MENTOR_CLASS_SELECT,
  REPORT_CLASS_SELECT,
  DOUBT_QUESTION_MAX,
  DOUBT_ANSWER_MAX,
  RESCHEDULE_FLOW_STATUSES,
  TIMETABLE_UPDATE_FIELDS,
  AUDIT_UPDATE_FIELDS,
  loadClassRecord,
  participantClassView,
  type ClassRecord,
  type ReflectionEntry,
} from './schedule.helpers';

import { reflectionService } from './schedule.reflection.service';
import { doubtService } from './schedule.doubt.service';
import { logger } from '@futurespark/logger';
import { sendNotification } from '../notification-helper';
import { rescheduleCalendarEvent, markMeetingClassCompleted } from '../calendar-helper';

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
    if (!isUnscopedStaffRole(callerRole) && !isWallDisplayRole(callerRole)) {
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
      const classEndTime = new Date(classStartTime.getTime() + (input.durationMinutes ?? 90) * 60 * 1000);

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
    const CLASS_DURATION_MS = (input.durationMinutes ?? 90) * 60 * 1000;
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

    /* No internal message on booking, by design: the approved templates for
     * regular sessions are a REMINDER (24h / 1h / 10m before, sent by
     * reminder.cron.ts) and a reschedule notice. There is no "just booked"
     * body, and firing the reminder template here would tell the team a class
     * "begins in 3 weeks" the moment it is created. */

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
      /* The class keeps ITS length across a reschedule. Forcing 90 here made
       * every move silently stretch a 70-minute class back to an hour and a
       * half — undoing the duration it was deliberately booked with. */
      const durationMs =
        classSession.endTime && classSession.startTime
          ? Math.max(30 * 60 * 1000, new Date(classSession.endTime).getTime() - new Date(classSession.startTime).getTime())
          : 90 * 60 * 1000;
      endTime = new Date(startTime.getTime() + durationMs);

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

    /* Move the room BEFORE the class, and never quietly. A refusal now stops
     * the reschedule; a busy Zoom seat re-homes the room onto a free host,
     * which means this class gets a NEW join link. */
    let rehomedLink: string | null = null;
    let notice: string | null = null;
    const linkToMove = input.meetingLink !== undefined ? input.meetingLink : classSession.meetingLink;
    // On EVERY save that carries a time, not only when the class's own time
    // changed: the room is compared against the Meeting table on the other
    // side, so a class that already diverged (moved in the app, refused by
    // Zoom under the old code) heals on its next plain save. In sync = no-op.
    // Past classes are left alone — nothing should re-book a room that ran.
    if (input.startTime && linkToMove && startTime.getTime() > Date.now()) {
      // One room is often booked for a whole programme. The old room is
      // released only when this class was its sole remaining user.
      const sharedBy = await db.scheduledClass.count({
        where: { id: { not: id }, meetingLink: linkToMove, status: { not: 'CANCELLED' } },
      });
      const moved = await rescheduleCalendarEvent(linkToMove, startTime, endTime, undefined, sharedBy === 0);
      if (moved.rehomed && moved.meetingLink) {
        rehomedLink = moved.meetingLink;
        notice =
          'The Zoom host for this class was busy at the new time, so the class now has a NEW join link on a free host. ' +
          `Share the new link with the family${sharedBy === 0 ? ' — the old one has been cancelled.' : '; the old room still serves the other sessions.'}`;
      }
    }

    /* Re-pointing a class at another curriculum session — the mis-filed
     * class case. Guarded to the SAME programme: crossing programmes would
     * detach the class from its student's enrolment, quizzes and report
     * curriculum, which is a delete-and-rebook, not an edit. Staff only. */
    let nextSessionId: string | undefined;
    if (input.sessionId !== undefined && input.sessionId !== classSession.sessionId) {
      if (!isUnscopedStaffRole(callerRole)) {
        throw new AppError('Only staff can move a class to a different session', HTTP_STATUS.FORBIDDEN);
      }
      const target = await db.session.findUnique({
        where: { id: input.sessionId },
        select: { id: true, programId: true, title: true },
      });
      if (!target) throw new AppError('That session does not exist', HTTP_STATUS.NOT_FOUND);
      if (target.programId !== classSession.programId) {
        throw new AppError(
          'That session belongs to a different programme. To move a class across programmes, cancel and rebook it.',
          HTTP_STATUS.BAD_REQUEST
        );
      }
      nextSessionId = target.id;
    }

    const updatedClass = await db.scheduledClass.update({
      where: { id },
      data: {
        startTime,
        endTime,
        status,
        ...(nextSessionId ? { sessionId: nextSessionId } : {}),
        ...(slotMoved ? { rescheduledCount: { increment: 1 } } : {}),
        mentorId: effectiveMentorId,
        meetingLink: rehomedLink ?? (input.meetingLink !== undefined ? input.meetingLink : undefined),
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

    /* Ops ping when the SLOT actually moved — not on a QA note or a credits
     * tweak, which also come through this method. Never awaited. */
    if (slotMoved) {
      const isDemo = updatedClass.classType === 'DEMO';
      const when = formatWhen(updatedClass.startTime);
      void notifyInternal(
        isDemo ? 'DEMO_RESCHEDULED' : 'SESSION_RESCHEDULED',
        {
          studentName:
            `${updatedClass.student?.firstName ?? ''} ${updatedClass.student?.lastName ?? ''}`.trim() || 'Student',
          level: (updatedClass.student as any)?.level ?? '-',
          topic: session?.title ?? 'Class session',
          mentorName:
            `${updatedClass.mentor?.firstName ?? ''} ${updatedClass.mentor?.lastName ?? ''}`.trim() || 'Unassigned',
          meetingLink: updatedClass.meetingLink ?? 'To be shared',
          // Demo bodies carry grade/country/contact; a demo booked in-app has
          // no lead row attached here, so these read as unset rather than wrong.
          grade: '-',
          country: (updatedClass.student as any)?.country ?? '-',
          parentContact: '-',
          ...when,
        },
        updatedClass.mentorId
      );
    }

    // Same narrowing as the read path. The write gate above stops a family
    // changing anything they should not, but until this was here a student could
    // PUT an empty body — every field undefined, nothing refused, no-op write —
    // and read back the full row, answer key and transcript included.
    if (isUnscopedStaffRole(callerRole) || isClassAuditorRole(callerRole)) {
      return { ...updatedClass, session, ...(notice ? { notice } : {}) };
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
  /**
   * The meeting links of classes running around now.
   *
   * One room is reused for every session of a programme, so the meeting row a
   * link belongs to keeps the date of the FIRST class booked on it. The
   * presence pollers window on that row's own start/end time, which means a
   * reused room reports presence only on its original day and every later
   * class on the same link renders as "cannot confirm anyone joined" - never
   * green, never the red no-show warning.
   *
   * This answers "which rooms should be watched" from the timetable instead,
   * which is the thing that actually moves.
   */
  async activeMeetingLinks(): Promise<string[]> {
    const now = Date.now();
    const rows = await db.scheduledClass.findMany({
      where: {
        meetingLink: { not: null },
        status: { not: 'CANCELLED' },
        // Mirrors the pollers' window: joined-early through overrun.
        startTime: { lte: new Date(now + 30 * 60 * 1000) },
        endTime: { gte: new Date(now - 60 * 60 * 1000) },
      },
      select: { meetingLink: true },
    });
    return [...new Set(rows.map((r) => r.meetingLink).filter((l): l is string => !!l))];
  },

  /**
   * The one class held in a given room at a given moment.
   *
   * A recording knows the room it came from and when it was made; it does NOT
   * know whose lesson it was. Integration-service used to answer that from the
   * meeting row the recording hangs off — but one room serves every session of
   * a programme, so that row carries the studentId, sessionId and slot of the
   * FIRST class ever booked there. Every later recording was therefore
   * transcribed and summarised against session one's material and session
   * one's clock, which is how a Budgeting recording came back headed
   * "Orientation" and dated three weeks earlier.
   *
   * Refuses when two classes could match: writing a summary onto the wrong
   * child's lesson is worse than writing none.
   */
  async classInRoomAt(meetingLink: string, at: Date) {
    if (!meetingLink || Number.isNaN(at.getTime())) return null;

    // The room opens half an hour early and classes overrun; the same window
    // presence and the admin's recording matcher use.
    const EARLY_MS = 30 * 60 * 1000;
    const OVERRUN_MS = 60 * 60 * 1000;

    const matches = await db.scheduledClass.findMany({
      where: {
        meetingLink,
        status: { not: 'CANCELLED' },
        startTime: { lte: new Date(at.getTime() + EARLY_MS) },
        endTime: { gte: new Date(at.getTime() - OVERRUN_MS) },
      },
      select: {
        id: true,
        studentId: true,
        mentorId: true,
        sessionId: true,
        programId: true,
        startTime: true,
        endTime: true,
        // Carried so integration-service can show THIS lesson's summary
        // without a second, differently-gated request.
        classSummary: true,
        transcript: true,
      },
      take: 5,
    });

    if (matches.length !== 1) {
      logger.warn(
        `[Recording] ${matches.length} classes match room ${meetingLink} at ${at.toISOString()}; ` +
        'refusing to guess which lesson the recording belongs to.'
      );
      return null;
    }
    return matches[0];
  },

  /** WhatsApp numbers of the staff who run the timetable. Internal callers only. */
  async staffNotifyNumbers(): Promise<string[]> {
    const staff = await db.user.findMany({
      where: { isActive: true, phone: { not: null }, role: { name: { in: ['ADMIN', 'SCHEDULER'] } } },
      select: { phone: true },
    });
    return [...new Set(staff.map((s) => s.phone?.trim()).filter((p): p is string => !!p))];
  },

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
      select: { id: true, startTime: true, endTime: true, actualEndedAt: true },
      orderBy: { startTime: 'desc' },
    });

    /* Two classes booked into the SAME room at the SAME time cannot be told
     * apart by presence: the room reports one set of occupants and there is no
     * way to know whose class they are in. Stamping either one records a class
     * as having taken place on the strength of somebody else's attendance —
     * and `actualEndedAt` is evidence, so the dashboard then shows a class
     * nobody joined as completed and `rateClass` opens against its mentor.
     *
     * Refuse instead. The double-booking is a scheduling fault to fix, not
     * something to paper over with a coin flip. */
    const liveThen = candidates.filter((c) => c.startTime <= endedAt && c.endTime >= endedAt);
    if (liveThen.length > 1) {
      logger.warn(
        `[Presence] Room ${meetingLink} emptied while ${liveThen.length} classes were booked into it ` +
        `at once (${liveThen.map((c) => c.id).join(', ')}). Not attributing the end to any of them.`
      );
      return { updated: 0 };
    }

    // Only ever the single most recent class that was live at that moment. If it
    // is already stamped, this is a repeat report from the 30-second poller and
    // there is nothing to do — never fall through to an earlier class.
    const target = liveThen[0] ?? candidates[0];
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


  // ── Reflection methods (see schedule.reflection.service.ts) ───────────────
  ...reflectionService,

  // ── Doubt & submission methods (see schedule.doubt.service.ts) ─────────────
  ...doubtService,

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

// ReflectionEntry is now defined in and exported from schedule.helpers.ts
export type { ReflectionEntry } from './schedule.helpers';

