import { hashPassword } from '@futurespark/authentication';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';
import { db } from '../../database/datasource';
import { userRepository } from './user.repository';
import { CreateUserInput, UpdateUserInput, ListUsersQuery } from './user.schema';
import { UserWithoutPassword, PublicUser } from './user.model';
import type { PaginatedResponse } from '@futurespark/types';
import { sendNotification } from '../notification-helper';

/**
 * FIXED       — bookable only in the weekly slots the mentor has published.
 * FLEXIBLE    — open to any slot; the weekly grid becomes a preference, not a limit.
 * UNAVAILABLE — not taking new classes (leave, notice period, etc).
 */
export const MENTOR_AVAILABILITY_MODES = ['FIXED', 'FLEXIBLE', 'UNAVAILABLE'];

/**
 * Mentors now edit their own weekly slots from the teacher portal, so a TEACHER
 * caller is confined to their own rows. Staff callers are left alone — they
 * have always managed everyone's grid from the admin scheduler.
 */
const assertOwnSlotIfTeacher = (mentorId: string, caller?: { id?: string; role?: string }) => {
  if (caller?.role !== 'TEACHER') return;
  if (!caller.id) throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
  if (caller.id !== mentorId) {
    throw new AppError('You can only change your own availability slots', HTTP_STATUS.FORBIDDEN);
  }
};

const sanitize = (user: any): UserWithoutPassword => {
  const { passwordHash, ...rest } = user;
  return rest;
};

const sanitizePublic = (user: any): PublicUser => {
  let rating: number | undefined;
  let ratingCount: number | undefined;
  let warnings: string[] | undefined;
  let feedbacks: any[] | undefined;

  if (user.role?.name === 'TEACHER' && user.scheduledClasses) {
    const completedClasses = user.scheduledClasses.filter((c: any) => c.status === 'COMPLETED');
    const ratedClasses = completedClasses.filter((c: any) => c.studentRating !== null && c.studentRating !== undefined);
    
    // Base rating defaults to 5.0 if no student rating exists yet
    const baseRating = ratedClasses.length > 0
      ? ratedClasses.reduce((acc: number, c: any) => acc + c.studentRating, 0) / ratedClasses.length
      : 5.0;

    // QA Audit & Report deductions
    const qaFailures = user.scheduledClasses.filter((c: any) => c.qaStatus === 'FAILED').length;
    const qaFlags = user.scheduledClasses.filter((c: any) => c.qaStatus === 'FLAGGED').length;
    const totalReports = user.scheduledClasses.reduce((acc: number, c: any) => acc + (c.reports?.length || 0), 0);

    const deduction = (qaFailures * 0.5) + (qaFlags * 0.25) + (totalReports * 0.2);
    
    // Clamp rating between 1.0 and 5.0
    rating = Math.max(1.0, Math.min(5.0, Number((baseRating - deduction).toFixed(2))));
    ratingCount = ratedClasses.length;

    warnings = user.warnings || [];
    feedbacks = user.scheduledClasses
      .filter((c: any) => 
        (c.studentRating !== null && c.studentRating !== undefined) || 
        c.qaStatus === 'FAILED' || 
        c.qaStatus === 'FLAGGED' || 
        (c.reports && c.reports.length > 0)
      )
      .map((c: any) => ({
        classId: c.id,
        startTime: c.startTime,
        studentRating: c.studentRating,
        studentFeedback: c.studentFeedback,
        qaStatus: c.qaStatus,
        qaFeedback: c.qaFeedback,
        reports: c.reports?.map((r: any) => ({
          id: r.id,
          reporterName: r.reporterName,
          reporterRole: r.reporterRole,
          issueType: r.issueType,
          description: r.description,
          createdAt: r.createdAt
        })) || []
      }));
  }

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role?.name || null,
    isActive: user.isActive,
    qualifiedPrograms: user.qualifiedPrograms || [],
    mentorTypes: user.mentorTypes || [],
    qualifications: user.qualifications || null,
    experience: user.experience || null,
    state: user.state || null,
    country: user.country || null,
    timezone: user.timezone || 'Asia/Kolkata',
    createdAt: user.createdAt,
    rating,
    ratingCount,
    warnings,
    feedbacks,
  };
};

export const userService = {
  async createUser(input: CreateUserInput): Promise<UserWithoutPassword> {
    const existing = await userRepository.findByEmail(input.email);
    if (existing) throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);

    const passwordHash = hashPassword(input.password);
    const user = await userRepository.create({ ...input, passwordHash, requiresFtlReset: true });
    return sanitize(user);
  },

  async getUserById(id: string): Promise<UserWithoutPassword> {
    const user = await userRepository.findById(id);
    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);
    return sanitize(user);
  },

  async updateUser(id: string, input: UpdateUserInput): Promise<UserWithoutPassword> {
    const user = await userRepository.findById(id);
    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);

    if (input.email && input.email !== user.email) {
      const existing = await userRepository.findByEmail(input.email);
      if (existing) throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);
    }

    const updated = await userRepository.update(id, input);
    return sanitize(updated);
  },

  async deleteUser(id: string): Promise<UserWithoutPassword> {
    const user = await userRepository.findById(id);
    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);
    const deleted = await userRepository.delete(id);
    return sanitize(deleted);
  },

  async listUsers(query: ListUsersQuery): Promise<PaginatedResponse<PublicUser>> {
    const { users, total } = await userRepository.findAll(query.page, query.limit, {
      role: query.role,
      isNotRole: query.isNotRole,
    });
    return {
      data: users.map(sanitizePublic),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  },

  async resetUserPassword(id: string, password: string): Promise<UserWithoutPassword> {
    const user = await userRepository.findById(id);
    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);

    const passwordHash = hashPassword(password);
    const updated = await userRepository.resetPassword(id, passwordHash);
    return sanitize(updated);
  },

  async listCustomers() {
    const customers = await db.parentAccount.findMany({
      include: {
        profiles: true,
        students: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return customers;
  },

  async getCustomerById(id: string) {
    const parent = await db.parentAccount.findUnique({
      where: { id },
      include: {
        profiles: true,
        students: true,
      },
    });
    if (!parent) throw new AppError('Customer not found', HTTP_STATUS.NOT_FOUND);
    return parent;
  },

  async createCustomer(input: any) {
    const existing = await db.user.findUnique({ where: { email: input.email } });
    if (existing) throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);

    const existingParent = await db.parentAccount.findUnique({
      where: { email: input.email },
      include: {
        profiles: true,
        students: true,
      },
    });
    if (existingParent) return existingParent;

    const existingStudent = await db.student.findUnique({ where: { email: input.email } });
    if (existingStudent) throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);

    const passwordHash = hashPassword(input.password);
    const parentAccount = await db.parentAccount.create({
      data: {
        email: input.email,
        passwordHash,
        programId: input.programId || null,
        requiresFtlReset: true,
        profiles: {
          createMany: {
            data: input.profiles || [],
          },
        },
      },
      include: {
        profiles: true,
        students: true,
      },
    });
    return parentAccount;
  },

  async deleteCustomer(id: string) {
    const parent = await db.parentAccount.findUnique({ where: { id } });
    if (!parent) throw new AppError('Customer not found', HTTP_STATUS.NOT_FOUND);

    await db.parentAccount.delete({ where: { id } });
    return { id };
  },

  async createStudentForParent(parentId: string, input: any) {
    const parent = await db.parentAccount.findUnique({ where: { id: parentId } });
    if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);

    const existing = await db.user.findUnique({
      where: { email: input.email },
      include: { role: true },
    });
    if (existing) {
      if (existing.role && existing.role.name === 'STUDENT') {
        // Delete legacy student user profile from the User table to avoid duplicate keys conflict
        await db.user.delete({ where: { id: existing.id } });
      } else {
        throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);
      }
    }

    const existingParent = await db.parentAccount.findUnique({ where: { email: input.email } });
    if (existingParent) throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);

    const existingStudent = await db.student.findUnique({ where: { email: input.email } });
    if (existingStudent) {
      return existingStudent;
    }

    const passwordHash = hashPassword(input.password);
    const normalizedEmail = input.email.toLowerCase().trim();

    // Check if this is the first student profile for this parent
    const studentCount = await db.student.count({
      where: { parentAccountId: parentId }
    });

    const isFirstStudent = studentCount === 0;
    const isParentPaid = !!parent.paymentApproved;

    // Generate unique 4-digit student code (e.g. STU-0001)
    const totalCount = await db.student.count();
    let nextNum = totalCount + 1;
    let studentCode = `STU-${String(nextNum).padStart(4, '0')}`;
    while (await db.student.findUnique({ where: { studentCode } })) {
      nextNum++;
      studentCode = `STU-${String(nextNum).padStart(4, '0')}`;
    }

    const student = await db.student.create({
      data: {
        parentAccountId: parentId,
        studentCode,
        email: normalizedEmail,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        paymentApproved: isParentPaid && isFirstStudent,
        requiresFtlReset: true,
      },
    });
    return student;
  },

  async listAllStudents() {
    let students = await db.student.findMany({
      include: {
        parentAccount: {
          select: {
            id: true,
            email: true,
            programId: true,
            paymentApproved: true,
            selectedPlanType: true,
            paidInstallmentIds: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Auto-assign studentCode to existing students who don't have one yet
    for (let i = 0; i < students.length; i++) {
      if (!students[i].studentCode) {
        const assignedCode = `STU-${String(i + 1).padStart(4, '0')}`;
        try {
          const updated = await db.student.update({
            where: { id: students[i].id },
            data: { studentCode: assignedCode },
          });
          students[i].studentCode = updated.studentCode;
        } catch {
          // If collision occurs, find next available number
          let num = i + 1;
          let candidate = `STU-${String(num).padStart(4, '0')}`;
          while (await db.student.findUnique({ where: { studentCode: candidate } })) {
            num++;
            candidate = `STU-${String(num).padStart(4, '0')}`;
          }
          const updated = await db.student.update({
            where: { id: students[i].id },
            data: { studentCode: candidate },
          });
          students[i].studentCode = updated.studentCode;
        }
      }
    }

    // Sort descending by createdAt for display
    return students.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  async deleteStudent(id: string) {
    const student = await db.student.findUnique({ where: { id } });
    if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);

    await db.student.delete({ where: { id } });
    return { id };
  },

  async createParentProfile(parentId: string, input: any) {
    const parent = await db.parentAccount.findUnique({
      where: { id: parentId },
      include: { profiles: true }
    });
    if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);

    if (parent.profiles.length >= 2) {
      throw new AppError('Parent account already has 2 profiles maximum', HTTP_STATUS.BAD_REQUEST);
    }

    const profile = await db.parentProfile.create({
      data: {
        parentAccountId: parentId,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone || null,
        relationship: input.relationship
      }
    });
    return profile;
  },

  async resetParentPassword(parentId: string, passwordHashRaw: string) {
    const parent = await db.parentAccount.findUnique({ where: { id: parentId } });
    if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);

    const passwordHash = hashPassword(passwordHashRaw);
    return await db.parentAccount.update({
      where: { id: parentId },
      data: { passwordHash }
    });
  },

  async updateParentAccount(parentId: string, input: any) {
    const parent = await db.parentAccount.findUnique({ where: { id: parentId } });
    if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);

    if (input.email && input.email !== parent.email) {
      const existing = await db.parentAccount.findUnique({ where: { email: input.email } });
      if (existing) throw new AppError('Email already in use by another parent account', HTTP_STATUS.CONFLICT);
    }

    const dataToUpdate: any = {
      email: input.email || undefined,
      isActive: input.isActive !== undefined ? input.isActive : undefined,
      programId: input.programId !== undefined ? input.programId : undefined,
      paymentApproved: input.paymentApproved !== undefined ? input.paymentApproved : undefined,
      selectedPlanType: input.selectedPlanType !== undefined ? input.selectedPlanType : undefined,
      paidInstallmentIds: input.paidInstallmentIds !== undefined ? input.paidInstallmentIds : undefined,
      // Empty string clears the photo; undefined leaves it untouched.
      avatarUrl: input.avatarUrl !== undefined ? input.avatarUrl || null : undefined,
    };

    // If programId is changed and not explicitly setting paymentApproved, reset it to false
    if (input.programId !== undefined && input.programId !== parent.programId && input.paymentApproved === undefined) {
      dataToUpdate.paymentApproved = false;
    }

    return await db.parentAccount.update({
      where: { id: parentId },
      data: dataToUpdate
    });
  },

  async updateParentProfile(profileId: string, input: any) {
    const profile = await db.parentProfile.findUnique({ where: { id: profileId } });
    if (!profile) throw new AppError('Parent profile not found', HTTP_STATUS.NOT_FOUND);

    return await db.parentProfile.update({
      where: { id: profileId },
      data: {
        firstName: input.firstName || undefined,
        lastName: input.lastName || undefined,
        phone: input.phone !== undefined ? input.phone : undefined,
        relationship: input.relationship || undefined
      }
    });
  },

  async resetStudentPassword(studentId: string, passwordHashRaw: string) {
    const student = await db.student.findUnique({ where: { id: studentId } });
    if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);

    const passwordHash = hashPassword(passwordHashRaw);
    return await db.student.update({
      where: { id: studentId },
      data: { passwordHash }
    });
  },

  /**
   * Look up a single student by id.
   *
   * Students live in their own table, not in `User`, so `GET /users/:id` 404s for
   * a studentId. Callers that only had that route silently fell back to whatever
   * default they carried — which is how the placeholder name "Zoha" ended up
   * printed in real AI class summaries.
   */
  async getStudentById(studentId: string) {
    const student = await db.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        studentCode: true,
        firstName: true,
        lastName: true,
        email: true,
        avatarUrl: true,
        isActive: true,
        timezone: true,
        credits: true,
      },
    });
    if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);
    return student;
  },

  async updateStudent(studentId: string, input: any) {
    const student = await db.student.findUnique({ where: { id: studentId } });
    if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);

    if (input.email && input.email !== student.email) {
      const existing = await db.student.findUnique({ where: { email: input.email } });
      if (existing) throw new AppError('Email already in use by another student account', HTTP_STATUS.CONFLICT);
    }

    return await db.student.update({
      where: { id: studentId },
      data: {
        firstName: input.firstName || undefined,
        lastName: input.lastName || undefined,
        email: input.email || undefined,
        isActive: input.isActive !== undefined ? input.isActive : undefined,
        paymentApproved: input.paymentApproved !== undefined ? input.paymentApproved : undefined,
        credits: input.credits !== undefined ? Number(input.credits) : undefined,
        timezone: input.timezone || undefined,
        // Empty string clears the photo; undefined leaves it untouched.
        avatarUrl: input.avatarUrl !== undefined ? input.avatarUrl || null : undefined,
      }
    });
  },

  // ── Mentor Schedule ────────────────────────────────────────────────────────

  async getMentorSchedules(mentorId: string) {
    const mentor = await db.user.findUnique({ where: { id: mentorId } });
    if (!mentor) throw new AppError('Mentor not found', HTTP_STATUS.NOT_FOUND);

    return db.mentorSchedule.findMany({
      where: { mentorId },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });
  },

  async addMentorSchedule(
    mentorId: string,
    input: { weekday: number; startTime: string; scheduleType?: string },
    caller?: { id?: string; role?: string }
  ) {
    assertOwnSlotIfTeacher(mentorId, caller);

    const mentor = await db.user.findUnique({ where: { id: mentorId } });
    if (!mentor) throw new AppError('Mentor not found', HTTP_STATUS.NOT_FOUND);

    const { weekday, startTime, scheduleType = 'REGULAR' } = input;
    if (!['REGULAR', 'DEMO'].includes(scheduleType)) {
      throw new AppError('Invalid scheduleType. Must be REGULAR or DEMO', HTTP_STATUS.BAD_REQUEST);
    }

    // Parse startTime "HH:MM" and compute endTime (+90 min)
    const [startHH, startMM] = startTime.split(':').map(Number);
    if (isNaN(startHH) || isNaN(startMM)) {
      throw new AppError('Invalid startTime format. Use HH:MM (24-hr)', HTTP_STATUS.BAD_REQUEST);
    }
    const startMinutes = startHH * 60 + startMM;
    const endMinutes = startMinutes + 90;
    if (endMinutes > 24 * 60) {
      throw new AppError('Time slot exceeds midnight — choose an earlier start time', HTTP_STATUS.BAD_REQUEST);
    }
    const endHH = Math.floor(endMinutes / 60);
    const endMM = endMinutes % 60;
    const endTime = `${String(endHH).padStart(2, '0')}:${String(endMM).padStart(2, '0')}`;

    // Conflict check: any existing slot on same weekday that overlaps [startMinutes, endMinutes)
    const existingSlots = await db.mentorSchedule.findMany({ where: { mentorId, weekday } });

    for (const slot of existingSlots) {
      const [eHH, eMM] = slot.startTime.split(':').map(Number);
      const [xHH, xMM] = slot.endTime.split(':').map(Number);
      const existStart = eHH * 60 + eMM;
      const existEnd = xHH * 60 + xMM;

      // Overlap if new start < existEnd AND new end > existStart
      if (startMinutes < existEnd && endMinutes > existStart) {
        const typeStr = slot.scheduleType.toLowerCase();
        throw new AppError(
          `Conflict: overlaps existing ${typeStr} slot ${slot.startTime}–${slot.endTime} on this day`,
          HTTP_STATUS.CONFLICT,
        );
      }
    }

    return db.mentorSchedule.create({
      data: { mentorId, weekday, startTime, endTime, scheduleType },
    });
  },

  async deleteMentorSchedule(scheduleId: string, caller?: { id?: string; role?: string }) {
    const slot = await db.mentorSchedule.findUnique({ where: { id: scheduleId } });
    if (!slot) throw new AppError('Schedule slot not found', HTTP_STATUS.NOT_FOUND);
    assertOwnSlotIfTeacher(slot.mentorId, caller);
    await db.mentorSchedule.delete({ where: { id: scheduleId } });
    return { id: scheduleId };
  },

  // ── Mentor Availability ────────────────────────────────────────────────────
  // A mentor declares *how* they are available; the weekly MentorSchedule rows
  // say *when*. FLEXIBLE means "book me any slot" and makes the weekly grid
  // advisory rather than binding, which is why the two are stored separately.

  async getMentorAvailability(mentorId: string) {
    const mentor = await db.user.findUnique({
      where: { id: mentorId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        timezone: true,
        availabilityMode: true,
        availabilityNote: true,
        availabilityUpdatedAt: true,
      },
    });
    if (!mentor) throw new AppError('Mentor not found', HTTP_STATUS.NOT_FOUND);

    const slots = await db.mentorSchedule.findMany({
      where: { mentorId },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });

    return { ...mentor, slots };
  },

  async updateMentorAvailability(
    mentorId: string,
    input: { availabilityMode?: string; availabilityNote?: string | null },
    caller: { id?: string; role?: string }
  ) {
    // A mentor edits only their own availability; staff may edit anyone's.
    const isStaff = caller.role === 'ADMIN' || caller.role === 'SCHEDULER';
    if (!isStaff) {
      if (!caller.id) throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      if (caller.id !== mentorId) {
        throw new AppError('You can only update your own availability', HTTP_STATUS.FORBIDDEN);
      }
    }

    const mentor = await db.user.findUnique({ where: { id: mentorId }, select: { id: true } });
    if (!mentor) throw new AppError('Mentor not found', HTTP_STATUS.NOT_FOUND);

    const data: any = { availabilityUpdatedAt: new Date() };

    if (input.availabilityMode !== undefined) {
      if (!MENTOR_AVAILABILITY_MODES.includes(input.availabilityMode)) {
        throw new AppError(
          `availabilityMode must be one of: ${MENTOR_AVAILABILITY_MODES.join(', ')}`,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      data.availabilityMode = input.availabilityMode;
    }

    if (input.availabilityNote !== undefined) {
      const note = typeof input.availabilityNote === 'string' ? input.availabilityNote.trim() : '';
      if (note.length > 500) {
        throw new AppError('Availability note must be 500 characters or fewer', HTTP_STATUS.BAD_REQUEST);
      }
      data.availabilityNote = note || null;
    }

    await db.user.update({ where: { id: mentorId }, data });
    return this.getMentorAvailability(mentorId);
  },

  async warnUser(targetId: string, targetRole: string, reason: string) {
    const logEntry = `[Warning] ${new Date().toISOString()}: ${reason}`;
    await sendNotification(targetId, 'Formal Disciplinary Warning', `A formal warning has been logged against your account: "${reason}"`, 'HIGH');

    if (targetRole === 'TEACHER' || targetRole === 'ADMIN' || targetRole === 'MENTOR') {
      const user = await db.user.findUnique({ where: { id: targetId } });
      if (!user) throw new AppError('Mentor/User not found', HTTP_STATUS.NOT_FOUND);
      return db.user.update({
        where: { id: targetId },
        data: {
          warningCount: { increment: 1 },
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'PARENT') {
      const parent = await db.parentAccount.findUnique({ where: { id: targetId } });
      if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);
      return db.parentAccount.update({
        where: { id: targetId },
        data: {
          warningCount: { increment: 1 },
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'STUDENT') {
      const student = await db.student.findUnique({ where: { id: targetId } });
      if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);
      return db.student.update({
        where: { id: targetId },
        data: {
          warningCount: { increment: 1 },
          warnings: { push: logEntry },
        },
      });
    } else {
      throw new AppError('Invalid target role', HTTP_STATUS.BAD_REQUEST);
    }
  },

  async blacklistUser(targetId: string, targetRole: string, reason: string) {
    const logEntry = `[Blacklisted] ${new Date().toISOString()}: ${reason}`;
    await sendNotification(targetId, 'Account Deactivated', `Your account has been deactivated: "${reason}"`, 'HIGH');

    if (targetRole === 'TEACHER' || targetRole === 'ADMIN' || targetRole === 'MENTOR') {
      const user = await db.user.findUnique({ where: { id: targetId } });
      if (!user) throw new AppError('Mentor/User not found', HTTP_STATUS.NOT_FOUND);
      
      // Revoke refresh tokens
      await db.refreshToken.deleteMany({ where: { userId: targetId } });
      
      return db.user.update({
        where: { id: targetId },
        data: {
          isActive: false,
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'PARENT') {
      const parent = await db.parentAccount.findUnique({ where: { id: targetId } });
      if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);
      
      // Revoke refresh tokens
      await db.refreshToken.deleteMany({ where: { parentAccountId: targetId } });
      
      return db.parentAccount.update({
        where: { id: targetId },
        data: {
          isActive: false,
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'STUDENT') {
      const student = await db.student.findUnique({ where: { id: targetId } });
      if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);
      
      // Revoke refresh tokens
      await db.refreshToken.deleteMany({ where: { studentId: targetId } });
      
      return db.student.update({
        where: { id: targetId },
        data: {
          isActive: false,
          warnings: { push: logEntry },
        },
      });
    } else {
      throw new AppError('Invalid target role', HTTP_STATUS.BAD_REQUEST);
    }
  },

  async unblacklistUser(targetId: string, targetRole: string) {
    const logEntry = `[Unblacklisted] ${new Date().toISOString()}`;
    await sendNotification(targetId, 'Account Reactivated', 'Your account access has been fully reinstated by the QA Auditor.', 'HIGH');

    if (targetRole === 'TEACHER' || targetRole === 'ADMIN' || targetRole === 'MENTOR') {
      const user = await db.user.findUnique({ where: { id: targetId } });
      if (!user) throw new AppError('Mentor/User not found', HTTP_STATUS.NOT_FOUND);
      return db.user.update({
        where: { id: targetId },
        data: {
          isActive: true,
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'PARENT') {
      const parent = await db.parentAccount.findUnique({ where: { id: targetId } });
      if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);
      return db.parentAccount.update({
        where: { id: targetId },
        data: {
          isActive: true,
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'STUDENT') {
      const student = await db.student.findUnique({ where: { id: targetId } });
      if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);
      return db.student.update({
        where: { id: targetId },
        data: {
          isActive: true,
          warnings: { push: logEntry },
        },
      });
    } else {
      throw new AppError('Invalid target role', HTTP_STATUS.BAD_REQUEST);
    }
  },

  async getUserQAInfo(targetId: string, targetRole: string) {
    if (targetRole === 'TEACHER' || targetRole === 'ADMIN' || targetRole === 'MENTOR') {
      const user = await db.user.findUnique({ where: { id: targetId } });
      if (!user) return null;
      return {
        id: user.id,
        isActive: user.isActive,
        warningCount: user.warningCount,
        warnings: user.warnings,
      };
    } else if (targetRole === 'PARENT') {
      const parent = await db.parentAccount.findUnique({
        where: { id: targetId },
        include: { profiles: true }
      });
      if (!parent) return null;
      const name = parent.profiles[0] 
        ? `${parent.profiles[0].firstName} ${parent.profiles[0].lastName}` 
        : parent.email;
      return {
        id: parent.id,
        isActive: parent.isActive,
        warningCount: parent.warningCount,
        warnings: parent.warnings,
        name,
      };
    } else if (targetRole === 'STUDENT') {
      const student = await db.student.findUnique({ where: { id: targetId } });
      if (!student) return null;
      return {
        id: student.id,
        isActive: student.isActive,
        warningCount: student.warningCount,
        warnings: student.warnings,
      };
    }
    return null;
  },
};