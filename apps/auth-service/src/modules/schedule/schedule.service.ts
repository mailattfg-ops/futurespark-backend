import { db } from '../../database/datasource';
import { CreateScheduleInput, UpdateScheduleInput } from './schedule.schema';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export const scheduleService = {
  async getMentorsWithSchedules() {
    return db.user.findMany({
      where: {
        role: { name: 'TEACHER' },
        isActive: true,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        qualifiedPrograms: true,
        mentorTypes: true,
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

  async listSchedules(filters: { studentId?: string; mentorId?: string; status?: string }) {
    return db.scheduledClass.findMany({
      where: {
        studentId: filters.studentId || undefined,
        mentorId: filters.mentorId || undefined,
        status: filters.status || undefined,
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        mentor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
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

    return classSession;
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
        meetingLink: input.meetingLink || null,
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

    return db.scheduledClass.update({
      where: { id },
      data: {
        startTime,
        endTime,
        status,
        mentorId: effectiveMentorId,
        meetingLink: input.meetingLink !== undefined ? input.meetingLink : undefined,
        rescheduleReason: input.rescheduleReason !== undefined ? input.rescheduleReason : undefined,
        rescheduleMessage: input.rescheduleMessage !== undefined ? input.rescheduleMessage : undefined,
      },
      include: {
        student: {
          select: { firstName: true, lastName: true },
        },
        mentor: {
          select: { firstName: true, lastName: true },
        },
        scheduledBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
  },

  async deleteSchedule(id: string) {
    const classSession = await this.getScheduleById(id);
    return db.scheduledClass.delete({ where: { id: classSession.id } });
  },
};
