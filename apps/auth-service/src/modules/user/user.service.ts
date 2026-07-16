import { hashPassword } from '@futurespark/authentication';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';
import { db } from '../../database/datasource';
import { userRepository } from './user.repository';
import { CreateUserInput, UpdateUserInput, ListUsersQuery } from './user.schema';
import { UserWithoutPassword, PublicUser } from './user.model';
import type { PaginatedResponse } from '@futurespark/types';

const sanitize = (user: any): UserWithoutPassword => {
  const { passwordHash, ...rest } = user;
  return rest;
};

const sanitizePublic = (user: any): PublicUser => {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role?.name || null,
    isActive: user.isActive,
    qualifiedPrograms: user.qualifiedPrograms || [],
    mentorTypes: user.mentorTypes || [],
    createdAt: user.createdAt,
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
    const student = await db.student.create({
      data: {
        parentAccountId: parentId,
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
      },
    });
    return student;
  },

  async listAllStudents() {
    const students = await db.student.findMany({
      include: {
        parentAccount: {
          include: {
            profiles: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return students;
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

    return await db.parentAccount.update({
      where: { id: parentId },
      data: {
        email: input.email || undefined,
        isActive: input.isActive !== undefined ? input.isActive : undefined
      }
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
        isActive: input.isActive !== undefined ? input.isActive : undefined
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

  async addMentorSchedule(mentorId: string, input: { weekday: number; startTime: string }) {
    const mentor = await db.user.findUnique({ where: { id: mentorId } });
    if (!mentor) throw new AppError('Mentor not found', HTTP_STATUS.NOT_FOUND);

    const { weekday, startTime } = input;

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
        throw new AppError(
          `Conflict: overlaps existing slot ${slot.startTime}–${slot.endTime} on this day`,
          HTTP_STATUS.CONFLICT,
        );
      }
    }

    return db.mentorSchedule.create({
      data: { mentorId, weekday, startTime, endTime },
    });
  },

  async deleteMentorSchedule(scheduleId: string) {
    const slot = await db.mentorSchedule.findUnique({ where: { id: scheduleId } });
    if (!slot) throw new AppError('Schedule slot not found', HTTP_STATUS.NOT_FOUND);
    await db.mentorSchedule.delete({ where: { id: scheduleId } });
    return { id: scheduleId };
  },
};