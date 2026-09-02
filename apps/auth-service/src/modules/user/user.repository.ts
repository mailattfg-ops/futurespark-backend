import { db } from '../../database/datasource';
import { CreateUserInput, UpdateUserInput } from './user.schema';

export const userRepository = {
  async create(data: CreateUserInput & { passwordHash: string; requiresFtlReset?: boolean }) {
    return db.user.create({
      data: {
        email: data.email,
        passwordHash: data.passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone ?? null,
        roleId: data.roleId,
        qualifiedPrograms: data.qualifiedPrograms || [],
        mentorTypes: data.mentorTypes || ['REGULAR'],
        requiresFtlReset: data.requiresFtlReset ?? false,
        qualifications: data.qualifications,
        experience: data.experience,
        state: data.state,
        country: data.country,
        timezone: data.timezone ?? 'Asia/Kolkata',
      },
      include: { role: true },
    });
  },

  async findById(id: string) {
    return db.user.findUnique({
      where: { id },
      include: { role: true },
    });
  },

  async findByEmail(email: string) {
    return db.user.findUnique({
      where: { email },
      include: { role: true },
    });
  },

  async update(id: string, data: UpdateUserInput) {
    return db.user.update({
      where: { id },
      data: {
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        // Empty string clears the number; undefined leaves it untouched.
        phone: data.phone !== undefined ? data.phone.trim() || null : undefined,
        // Was accepted by the validator but never written here, so a staff
        // profile photo silently reverted on the next page load.
        avatarUrl: data.avatarUrl !== undefined ? data.avatarUrl || null : undefined,
        isActive: data.isActive,
        qualifiedPrograms: data.qualifiedPrograms,
        roleId: data.roleId,
        mentorTypes: data.mentorTypes,
        qualifications: data.qualifications,
        experience: data.experience,
        state: data.state,
        country: data.country,
        timezone: data.timezone,
      },
      include: { role: true },
    });
  },

  async delete(id: string) {
    return db.user.delete({
      where: { id },
      include: { role: true },
    });
  },

  async findAll(page: number, limit: number, filters?: { role?: string; isNotRole?: string }) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (filters?.role) {
      where.role = { name: filters.role };
    }
    if (filters?.isNotRole) {
      where.role = { name: { not: filters.isNotRole } };
    }

    const include: any = { role: true };
    if (filters?.role === 'TEACHER') {
      include.scheduledClasses = {
        include: {
          reports: true,
        },
      };
    }

    const [users, total] = await Promise.all([
      db.user.findMany({ where, skip, take: limit, include, orderBy: { createdAt: 'desc' } }),
      db.user.count({ where }),
    ]);
    return { users, total };
  },

  async resetPassword(id: string, passwordHash: string) {
    return db.user.update({
      where: { id },
      data: {
        passwordHash,
        requiresFtlReset: false,
      },
      include: { role: true },
    });
  },
};