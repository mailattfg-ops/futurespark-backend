import { hashPassword } from '@futurespark/authentication';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';
import { userRepository } from './user.repository';
import { CreateUserInput, UpdateUserInput, ListUsersQuery } from './user.schema';
import { UserWithoutPassword, PublicUser } from './user.model';
import type { PaginatedResponse } from '@futurespark/types';

const sanitize = (user: any): UserWithoutPassword => {
  const { passwordHash, ...rest } = user;
  return rest;
};

export const userService = {
  async createUser(input: CreateUserInput): Promise<UserWithoutPassword> {
    const existing = await userRepository.findByEmail(input.email);
    if (existing) throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);

    const passwordHash = hashPassword(input.password);
    const user = await userRepository.create({ ...input, passwordHash });
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
    const { users, total } = await userRepository.findAll(query.page, query.limit);
    return {
      data: users.map(sanitize) as PublicUser[],
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  },
};