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
            weekday: true,
            startTime: true,
            endTime: true,
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
    // 1. Verify Student exists
    const student = await db.student.findUnique({ where: { id: input.studentId } });
    if (!student) {
      throw new AppError('Student account not found', HTTP_STATUS.NOT_FOUND);
    }

    // 2. Verify Mentor exists
    const mentor = await db.user.findUnique({ where: { id: input.mentorId } });
    if (!mentor) {
      throw new AppError('Mentor not found', HTTP_STATUS.NOT_FOUND);
    }

    // 3. Verify Mentor qualification (Optional warning only, don't throw error to allow manual staff override)
    // const isQualified = mentor.qualifiedPrograms.includes(input.programId);

    // 4. Calculate start and end times
    const startTime = new Date(input.startTime);
    const endTime = new Date(startTime.getTime() + 90 * 60 * 1000); // 90 min duration

    // 5. Verify weekly availability (Bypassed: allow manual scheduling regardless of weekly slots)
    /*
    const classWeekday = startTime.getDay();
    const classStartMins = startTime.getHours() * 60 + startTime.getMinutes();
    const classEndMins = classStartMins + 90;

    const daySchedules = await db.mentorSchedule.findMany({
      where: { mentorId: input.mentorId, weekday: classWeekday },
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

    // 6. Check mentor scheduling overlaps
    const mentorConflicts = await db.scheduledClass.findFirst({
      where: {
        mentorId: input.mentorId,
        status: { not: 'CANCELLED' },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
      },
    });

    if (mentorConflicts) {
      throw new AppError('Mentor has a scheduling conflict with another class at this time', HTTP_STATUS.CONFLICT);
    }

    // 7. Check student scheduling overlaps
    const studentConflicts = await db.scheduledClass.findFirst({
      where: {
        studentId: input.studentId,
        status: { not: 'CANCELLED' },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
      },
    });

    if (studentConflicts) {
      throw new AppError('Student has a scheduling conflict with another class at this time', HTTP_STATUS.CONFLICT);
    }

    // 8. Create the scheduled class
    return db.scheduledClass.create({
      data: {
        studentId: input.studentId,
        mentorId: input.mentorId,
        scheduledById: scheduledById || null,
        programId: input.programId,
        sessionId: input.sessionId,
        startTime,
        endTime,
        status: 'SCHEDULED',
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

    return db.scheduledClass.update({
      where: { id },
      data: {
        startTime,
        endTime,
        status,
        mentorId: effectiveMentorId,
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
