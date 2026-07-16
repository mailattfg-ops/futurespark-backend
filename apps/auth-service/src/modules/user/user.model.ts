import { User as PrismaUser, Role as PrismaRole } from '../../../prisma/client';

export type User = PrismaUser & { role?: PrismaRole | null };
export type UserWithoutPassword = Omit<User, 'passwordHash'>;

export interface PublicUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  isActive: boolean;
  qualifiedPrograms: string[];
  createdAt: Date;
}