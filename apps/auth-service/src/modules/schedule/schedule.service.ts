import { db } from '../../database/datasource';
import { CreateScheduleInput, UpdateScheduleInput } from './schedule.schema';
import { AppError } from '@futurespark/middleware';
import {
  HTTP_STATUS,
  effectiveReflectionQuestions,
  effectiveReflectionQuiz,
  effectiveSessionTopics,
  gradeReflection,
  deriveAttendance,
  owesReflection,
  stripAnswerKey,
  createClassMediaGrant,
  extractMeetCode,
  ReflectionResponse,
} from '@futurespark/constants';

/** A class is finished if it was completed, the room emptied, or its slot ran out. */
const isOver = (c: { status: string; endTime: Date; actualEndedAt: Date | null }, nowMs: number): boolean =>
  c.status === 'COMPLETED' || Boolean(c.actualEndedAt) || c.endTime.getTime() <= nowMs;
import { logger } from '@futurespark/logger';
import { sendNotification } from '../notification-helper';
import { rescheduleCalendarEvent } from '../calendar-helper';

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

  async listSchedules(filters: { studentId?: string; mentorId?: string; status?: string; groupId?: string }) {
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

    const now = Date.now();
    return schedules.map((s) => ({
      ...s,
      session: sessions.find((sess) => sess.id === s.sessionId) || null,
      // Derived here rather than in each portal, so the student's attendance
      // tab and the mentor's student record can never disagree about whether a
      // class was missed.
      attendance: deriveAttendance(s, now),
    }));
  },

  async getScheduleById(id: string) {
    const classSession = await db.scheduledClass.findUnique({
      where: { id },
      include: {
        student: true,
        mentor: true,
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

    let session = null;
    if (classSession.sessionId) {
      session = await db.session.findUnique({
        where: { id: classSession.sessionId },
      });
    }

    return {
      ...classSession,
      session,
    };
  },

  async createSchedule(input: CreateScheduleInput, scheduledById?: string) {
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

      if (mentorConflicts) {
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

      if (leadConflicts) {
        throw new AppError(
          `Lead already has a scheduled class on ${classStartTime.toLocaleDateString()} at ${classStartTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          HTTP_STATUS.CONFLICT
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

    // 3. Construct all the week-by-week slots and check overlaps/conflicts for all classes
    const classesToCreate = [];
    const baseStartTime = new Date(input.startTime);

    for (let i = 0; i < input.sessions!.length; i++) {
      const session = input.sessions![i];
      // Increment date by i weeks (7 days * i)
      const classStartTime = new Date(baseStartTime.getTime() + i * 7 * 24 * 60 * 60 * 1000);
      const classEndTime = new Date(classStartTime.getTime() + 90 * 60 * 1000); // 90 min duration

      // Check mentor conflicts (ignore cancelled classes)
      const mentorConflicts = await db.scheduledClass.findFirst({
        where: {
          mentorId: input.mentorId,
          status: { not: 'CANCELLED' },
          startTime: { lt: classEndTime },
          endTime: { gt: classStartTime },
        },
      });

      if (mentorConflicts) {
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

      if (studentConflicts) {
        throw new AppError(
          `Student has a scheduling conflict with another class on ${classStartTime.toLocaleDateString()} at ${classStartTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          HTTP_STATUS.CONFLICT
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

  async updateSchedule(id: string, input: UpdateScheduleInput) {
    const classSession = await this.getScheduleById(id);

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
      endTime = new Date(startTime.getTime() + 90 * 60 * 1000); // 90 min duration

      if (status === 'RESCHEDULE_REQUESTED') {
        status = 'SCHEDULED';
      }

      // Verify Weekly availability of the mentor (Bypassed: allow manual scheduling regardless of weekly slots)
      /*
      const classWeekday = startTime.getDay();
      const classStartMins = startTime.getHours() * 60 + startTime.getMinutes();
      const classEndMins = classStartMins + 90;

      const daySchedules = await db.mentorSchedule.findMany({
        where: { mentorId: classSession.mentorId, weekday: classWeekday },
      });

      if (daySchedules.length === 0) {
        throw new AppError('Mentor has no weekly availability scheduled for this weekday', HTTP_STATUS.BAD_REQUEST);
      }

      let isAvailable = false;
      for (const slot of daySchedules) {
        const [sh, sm] = slot.startTime.split(':').map(Number);
        const [eh, em] = slot.endTime.split(':').map(Number);
        const slotStartMins = sh * 60 + sm;
        const slotEndMins = eh * 60 + em;

        if (classStartMins >= slotStartMins && classEndMins <= slotEndMins) {
          isAvailable = true;
          break;
        }
      }

      if (!isAvailable) {
        throw new AppError("The selected time slot is outside the mentor's scheduled availability on this day", HTTP_STATUS.BAD_REQUEST);
      }
      */

      // Check conflicts for mentor (excluding this class)
      const mentorConflicts = await db.scheduledClass.findFirst({
        where: {
          id: { not: id },
          mentorId: effectiveMentorId,
          status: { not: 'CANCELLED' },
          startTime: { lt: endTime },
          endTime: { gt: startTime },
        },
      });

      if (mentorConflicts) {
        throw new AppError('Mentor has a scheduling conflict with another class at this time', HTTP_STATUS.CONFLICT);
      }

      // Check conflicts for student (excluding this class)
      const studentConflicts = await db.scheduledClass.findFirst({
        where: {
          id: { not: id },
          studentId: classSession.studentId,
          status: { not: 'CANCELLED' },
          startTime: { lt: endTime },
          endTime: { gt: startTime },
        },
      });

      if (studentConflicts) {
        throw new AppError('Student has a scheduling conflict with another class at this time', HTTP_STATUS.CONFLICT);
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

    return {
      ...updatedClass,
      session,
    };
  },

  async deleteSchedule(id: string, deleteAll = false) {
    const classSession = await this.getScheduleById(id);

    if (deleteAll) {
      if (classSession.classType === 'REGULAR' && classSession.studentId) {
        return db.scheduledClass.deleteMany({
          where: {
            studentId: classSession.studentId,
            programId: classSession.programId,
            status: 'SCHEDULED',
          },
        });
      } else if (classSession.classType === 'DEMO' && classSession.leadId) {
        return db.scheduledClass.deleteMany({
          where: {
            leadId: classSession.leadId,
            programId: classSession.programId,
            status: 'SCHEDULED',
          },
        });
      }
    }

    return db.scheduledClass.delete({ where: { id: classSession.id } });
  },

  async createReport(input: { classId: string; reporterId: string; reporterRole: string; issueType: string; description: string }) {
    const classSession = await this.getScheduleById(input.classId);
    if (!classSession) {
      throw new AppError('Scheduled class not found', HTTP_STATUS.NOT_FOUND);
    }

    let reporterName = 'Unknown User';
    if (input.reporterRole === 'TEACHER' || input.reporterRole === 'ADMIN') {
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
        class: {
          include: {
            student: true,
            mentor: true,
          },
        },
      },
    });
  },

  async listReports(reporterId?: string) {
    return db.sessionReport.findMany({
      where: reporterId ? { reporterId } : undefined,
      include: {
        class: {
          include: {
            student: true,
            mentor: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  async updateReport(reportId: string, input: { status?: string; qaFeedback?: string }) {
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
        class: {
          include: {
            student: true,
            mentor: true,
          },
        },
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

  async completeClass(classId: string, credits: number) {
    const classSession = await db.scheduledClass.findUnique({
      where: { id: classId },
      include: {
        student: true,
        mentor: true,
      },
    });
    if (!classSession) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }
    if (classSession.status === 'COMPLETED') {
      throw new AppError('Class session has already been completed', HTTP_STATUS.BAD_REQUEST);
    }
    if (new Date(classSession.startTime) > new Date()) {
      throw new AppError('Cannot complete or award points to a future class session', HTTP_STATUS.BAD_REQUEST);
    }

    let session = null;
    if (classSession.sessionId) {
      session = await db.session.findUnique({
        where: { id: classSession.sessionId },
      });
    }

    return db.$transaction(async (tx) => {
      const updatedClass = await tx.scheduledClass.update({
        where: { id: classId },
        data: {
          status: 'COMPLETED',
          creditsAwarded: credits,
        },
        include: {
          student: true,
          mentor: true,
        },
      });

      if (updatedClass.studentId) {
        await tx.student.update({
          where: { id: updatedClass.studentId },
          data: {
            credits: { increment: credits },
          },
        });

        // 1. Notify Student
        await sendNotification(
          updatedClass.studentId,
          'Class Completed & Credits Awarded!',
          `You earned +${credits} credit points for completing "${session?.title || 'Session'}"!`,
          'MEDIUM'
        );

        // 2. Notify Parent
        if (updatedClass.student?.parentAccountId) {
          await sendNotification(
            updatedClass.student.parentAccountId,
            'Student Completed Session',
            `${updatedClass.student.firstName} completed the session "${session?.title || 'Session'}" and was awarded +${credits} credit points.`,
            'LOW'
          );
        }
      }

      return {
        ...updatedClass,
        session,
      };
    });
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

  async rateClass(id: string, rating: number, feedback?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({ where: { id } });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
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
    return db.scheduledClass.update({
      where: { id },
      data: {
        studentRating: rating,
        studentFeedback: feedback || undefined,
      },
    });
  },

  // ── Post-class reflection ───────────────────────────────────────────────────

  /**
   * The quiz a student must answer for a given class, plus whatever they have
   * already submitted. Questions come from the curriculum session; a session
   * with no custom quiz falls back to its text prompts, then to the platform
   * defaults, so there is always something to answer.
   */
  async getReflection(classId: string) {
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
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

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
      // The answer key is stripped unconditionally here: this endpoint exists to
      // serve the person about to sit the quiz. Reviewers read the graded
      // answers instead, which already carry correct/incorrect per question.
      questions: effectiveReflectionQuestions(session?.reflectionQuestions ?? null),
      quiz: stripAnswerKey(quiz),
      topics: effectiveSessionTopics(session?.topics),
      answers: (scheduledClass.reflectionAnswers as ReflectionEntry[] | null) ?? null,
      submittedAt: scheduledClass.reflectionSubmittedAt,
      score: scheduledClass.reflectionScore,
      maxScore: scheduledClass.reflectionMaxScore,
      badge: scheduledClass.reflectionBadge,
    };
  },

  /**
   * Stores and grades a student's reflection.
   *
   * Grading happens against the server's copy of the quiz and the question text
   * is snapshotted alongside each answer, so a client cannot invent prompts,
   * award itself points, or have a later admin edit silently reword what it was
   * asked.
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
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
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
      // Mirrors `owesReflection`: only a class the mentor has marked COMPLETE can
      // take answers. `deriveAttendance` is deliberately not used here — it also
      // reports ATTENDED once the Meet room empties, which would let a student
      // submit against a class the mentor has not closed out yet.
      if (scheduledClass.status !== 'COMPLETED') {
        throw new AppError(
          scheduledClass.endTime.getTime() > Date.now()
            ? 'This class has not finished yet'
            : 'Your mentor has not marked this class complete yet — the quiz opens once they do',
          HTTP_STATUS.BAD_REQUEST
        );
      }
    }

    const session = scheduledClass.sessionId
      ? await db.session.findUnique({
          where: { id: scheduledClass.sessionId },
          select: { reflectionQuestions: true, reflectionQuiz: true },
        })
      : null;

    const quiz = effectiveReflectionQuiz(session?.reflectionQuiz, session?.reflectionQuestions);
    const graded = gradeReflection(quiz, responses);

    if (graded.answeredCount === 0) {
      throw new AppError('Answer at least one question before submitting', HTTP_STATUS.BAD_REQUEST);
    }

    const updated = await db.scheduledClass.update({
      where: { id: classId },
      data: {
        reflectionAnswers: graded.entries as any,
        reflectionSubmittedAt: new Date(),
        reflectionScore: graded.score,
        reflectionMaxScore: graded.maxScore,
        reflectionBadge: graded.badge?.id ?? null,
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

    logger.info(
      `[Reflection] Student ${scheduledClass.studentId} submitted reflection for class ${classId} ` +
      `— ${graded.score}/${graded.maxScore}${graded.badge ? ` (${graded.badge.id})` : ''}`
    );
    return { ...updated, badge: graded.badge, answeredCount: graded.answeredCount };
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
        (callerRole === 'TEACHER' && classes.some((c) => c.mentorId === callerId)) ||
        (callerRole === 'STUDENT' && callerId === studentId) ||
        (callerRole === 'PARENT' && callerId === student.parentAccountId);
      if (!permitted) {
        throw new AppError('You do not have access to this student record', HTTP_STATUS.FORBIDDEN);
      }
    }

    const sessionIds = [...new Set(classes.map((c) => c.sessionId).filter(Boolean))] as string[];
    const programIds = [...new Set(classes.map((c) => c.programId).filter(Boolean))] as string[];

    const [sessions, programs] = await Promise.all([
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
    ]);

    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const now = Date.now();

    const timeline = classes.map((c) => {
      const session = c.sessionId ? sessionById.get(c.sessionId) : undefined;
      const answers = (c.reflectionAnswers as ReflectionEntry[] | null) ?? null;
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
        // Average of the score percentages, not of the raw scores — quizzes can
        // be worth different totals, so raw averages would be meaningless.
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
 * One answered prompt, snapshotted at submit time.
 *
 * Rows written before the quiz existed hold only `question` and `answer`; the
 * rest is optional so those still deserialise. Readers must treat every
 * optional field as possibly absent.
 */
export interface ReflectionEntry {
  question: string;
  answer: string;
  questionId?: string;
  type?: string;
  selectedOptionId?: string | null;
  correct?: boolean | null;
  pointsEarned?: number;
  pointsPossible?: number;
}
