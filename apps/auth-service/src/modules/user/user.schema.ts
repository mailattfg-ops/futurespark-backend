import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// ── Create User ────────────────────────────────────────────────

export interface CreateUserInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

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

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    email: data.email.toLowerCase().trim(),
    password: data.password,
    firstName: data.firstName?.trim(),
    lastName: data.lastName?.trim(),
  };
};

// ── Update User ────────────────────────────────────────────────

export interface UpdateUserInput {
  email?: string;
  firstName?: string;
  lastName?: string;
  isActive?: boolean;
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

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    email: data.email?.toLowerCase().trim(),
    firstName: data.firstName?.trim(),
    lastName: data.lastName?.trim(),
    isActive: data.isActive,
  };
};

// ── List Users (Pagination) ────────────────────────────────────

export interface ListUsersQuery {
  page: number;
  limit: number;
}

export const validateListUsers = (query: any): ListUsersQuery => {
  const page = parseInt(query.page, 10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 20, 100);
  return { page: Math.max(page, 1), limit };
};