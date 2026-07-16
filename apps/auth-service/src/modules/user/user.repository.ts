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
        roleId: data.roleId,
        qualifiedPrograms: data.qualifiedPrograms || [],
        requiresFtlReset: data.requiresFtlReset ?? false,
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
        isActive: data.isActive,
        qualifiedPrograms: data.qualifiedPrograms,
        roleId: data.roleId,
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
    const [users, total] = await Promise.all([
      db.user.findMany({ where, skip, take: limit, include: { role: true }, orderBy: { createdAt: 'desc' } }),
      db.user.count({ where }),
    ]);
    return { users, total };
  },

  async resetPassword(id: string, passwordHash: string) {
    return db.user.update({
      where: { id },
      data: {
        passwordHash,
        requiresFtlReset: true,
      },
      include: { role: true },
    });
  },
};