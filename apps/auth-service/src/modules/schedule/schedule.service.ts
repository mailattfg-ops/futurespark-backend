import { db } from '../../database/datasource';
import { CreateScheduleInput, UpdateScheduleInput } from './schedule.schema';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';
import { sendNotification } from '../notification-helper';

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
            firstName: true,
            lastName: true,
            email: true,
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
      select: { id: true, title: true, credits: true },
    });

    return schedules.map((s) => ({
      ...s,
      session: sessions.find((sess) => sess.id === s.sessionId) || null,
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
    const status = input.status !== undefined ? input.status : classSession.status;
    if (status === 'COMPLETED' && new Date(startTime) > new Date()) {
      throw new AppError('Cannot complete or award points to a future class session', HTTP_STATUS.BAD_REQUEST);
    }
    // Use the new mentorId if provided, else keep existing
    const effectiveMentorId = input.mentorId || classSession.mentorId;

    if (input.startTime) {
      startTime = new Date(input.startTime);
      endTime = new Date(startTime.getTime() + 90 * 60 * 1000); // 90 min duration

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
      if (classSession.studentId) {
        await db.scheduledClass.updateMany({
          where: {
            studentId: classSession.studentId,
            programId: classSession.programId,
          },
          data: {
            meetingLink: input.meetingLink,
          },
        });
      } else if (classSession.leadId) {
        await db.scheduledClass.updateMany({
          where: {
            leadId: classSession.leadId,
            programId: classSession.programId,
          },
          data: {
            meetingLink: input.meetingLink,
          },
        });
      }
    }

    let creditsDiff = 0;
    if (input.creditsAwarded !== undefined && classSession.status === 'COMPLETED') {
      const oldCredits = classSession.creditsAwarded || 0;
      const newCredits = Number(input.creditsAwarded);
      creditsDiff = newCredits - oldCredits;
    }

    const updatedClass = await db.scheduledClass.update({
      where: { id },
      data: {
        startTime,
        endTime,
        status,
        mentorId: effectiveMentorId,
        meetingLink: input.meetingLink !== undefined ? input.meetingLink : undefined,
        rescheduleReason: input.rescheduleReason !== undefined ? input.rescheduleReason : undefined,
        rescheduleMessage: input.rescheduleMessage !== undefined ? input.rescheduleMessage : undefined,
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

  async rateClass(id: string, rating: number, feedback?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({ where: { id } });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }
    return db.scheduledClass.update({
      where: { id },
      data: {
        studentRating: rating,
        studentFeedback: feedback || undefined,
      },
    });
  },
};
