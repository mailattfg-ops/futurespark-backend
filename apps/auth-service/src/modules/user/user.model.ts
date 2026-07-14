import { User as PrismaUser } from '../../../prisma/client';

export type User = PrismaUser;
export type UserWithoutPassword = Omit<User, 'passwordHash'>;
export type PublicUser = Pick<User, 'id' | 'email' | 'firstName' | 'lastName' | 'role' | 'isActive' | 'createdAt'>;