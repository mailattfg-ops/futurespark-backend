import { db } from '../../database/datasource';
import { CreateUserInput, UpdateUserInput } from './user.schema';

export const userRepository = {
  async create(data: CreateUserInput & { passwordHash: string }) {
    return db.user.create({
      data: {
        email: data.email,
        passwordHash: data.passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
      },
    });
  },

  async findById(id: string) {
    return db.user.findUnique({ where: { id } });
  },

  async findByEmail(email: string) {
    return db.user.findUnique({ where: { email } });
  },

  async update(id: string, data: UpdateUserInput) {
    return db.user.update({ where: { id }, data });
  },

  async delete(id: string) {
    return db.user.delete({ where: { id } });
  },

  async findAll(page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      db.user.findMany({ skip, take: limit, orderBy: { createdAt: 'desc' } }),
      db.user.count(),
    ]);
    return { users, total };
  },
};