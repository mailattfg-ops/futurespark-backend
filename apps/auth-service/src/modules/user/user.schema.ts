import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// ── Create User ────────────────────────────────────────────────

export interface CreateUserInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  roleId?: string;
  qualifiedPrograms?: string[];
  mentorTypes?: string[];
}

const VALID_ROLES = ['STUDENT', 'ADMIN', 'TEACHER', 'QA_AUDITOR', 'SCHEDULER', 'WAREHOUSE_ADMIN', 'FINANCE_ADMIN'];
const VALID_MENTOR_TYPES = ['REGULAR', 'DEMO'];

export const validateCreateUser = (data: any): CreateUserInput => {
  const errors: string[] = [];

  if (!data.email || typeof data.email !== 'string') {
    errors.push('Email is required');
  } else if (!isValidEmail(data.email)) {
    errors.push('Invalid email format');
  }

  if (!data.password || typeof data.password !== 'string') {
    errors.push('Password is required');
  } else if (data.password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  if (data.firstName !== undefined && typeof data.firstName !== 'string') {
    errors.push('First name must be a string');
  }
  if (data.lastName !== undefined && typeof data.lastName !== 'string') {
    errors.push('Last name must be a string');
  }
  if (data.roleId !== undefined && typeof data.roleId !== 'string') {
    errors.push('Role ID must be a string');
  }
  if (data.qualifiedPrograms !== undefined && !Array.isArray(data.qualifiedPrograms)) {
    errors.push('Qualified programs must be an array of strings');
  }
  if (data.mentorTypes !== undefined) {
    if (!Array.isArray(data.mentorTypes)) {
      errors.push('mentorTypes must be an array');
    } else if (data.mentorTypes.some((t: any) => !VALID_MENTOR_TYPES.includes(t))) {
      errors.push('mentorTypes elements must be REGULAR or DEMO');
    }
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    email: data.email.toLowerCase().trim(),
    password: data.password,
    firstName: data.firstName?.trim(),
    lastName: data.lastName?.trim(),
    roleId: data.roleId,
    qualifiedPrograms: data.qualifiedPrograms,
    mentorTypes: data.mentorTypes,
  };
};

// ── Update User ────────────────────────────────────────────────

export interface UpdateUserInput {
  email?: string;
  firstName?: string;
  lastName?: string;
  isActive?: boolean;
  roleId?: string;
  qualifiedPrograms?: string[];
  mentorTypes?: string[];
}

export const validateUpdateUser = (data: any): UpdateUserInput => {
  const errors: string[] = [];

  if (data.email !== undefined) {
    if (typeof data.email !== 'string') errors.push('Email must be a string');
    else if (!isValidEmail(data.email)) errors.push('Invalid email format');
  }

  if (data.firstName !== undefined && typeof data.firstName !== 'string') {
    errors.push('First name must be a string');
  }
  if (data.lastName !== undefined && typeof data.lastName !== 'string') {
    errors.push('Last name must be a string');
  }
  if (data.isActive !== undefined && typeof data.isActive !== 'boolean') {
    errors.push('isActive must be a boolean');
  }
  if (data.roleId !== undefined && typeof data.roleId !== 'string') {
    errors.push('Role ID must be a string');
  }
  if (data.qualifiedPrograms !== undefined && !Array.isArray(data.qualifiedPrograms)) {
    errors.push('Qualified programs must be an array of strings');
  }
  if (data.mentorTypes !== undefined) {
    if (!Array.isArray(data.mentorTypes)) {
      errors.push('mentorTypes must be an array');
    } else if (data.mentorTypes.some((t: any) => !['REGULAR', 'DEMO'].includes(t))) {
      errors.push('mentorTypes elements must be REGULAR or DEMO');
    }
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    email: data.email?.toLowerCase().trim(),
    firstName: data.firstName?.trim(),
    lastName: data.lastName?.trim(),
    isActive: data.isActive,
    roleId: data.roleId,
    qualifiedPrograms: data.qualifiedPrograms,
    mentorTypes: data.mentorTypes,
  };
};

export interface ListUsersQuery {
  page: number;
  limit: number;
  role?: string;
  isNotRole?: string;
}

export const validateListUsers = (query: any): ListUsersQuery => {
  const page = parseInt(query.page, 10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 100, 100);
  const role = typeof query.role === 'string' && VALID_ROLES.includes(query.role) ? query.role : undefined;
  const isNotRole = typeof query.isNotRole === 'string' && VALID_ROLES.includes(query.isNotRole) ? query.isNotRole : undefined;
  return { page: Math.max(page, 1), limit, role, isNotRole };
};