import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

// ── Validation Helpers ─────────────────────────────────────────

const isValidEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// ── Register Schema ────────────────────────────────────────────

export interface RegisterInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

export const validateRegister = (data: any): RegisterInput => {
  const errors: string[] = [];

  if (!data.email || typeof data.email !== 'string') {
    errors.push('Email is required and must be a string');
  } else if (!isValidEmail(data.email)) {
    errors.push('Email format is invalid');
  }

  if (!data.password || typeof data.password !== 'string') {
    errors.push('Password is required and must be a string');
  } else if (data.password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }

  if (data.firstName !== undefined && typeof data.firstName !== 'string') {
    errors.push('First name must be a string');
  }

  if (data.lastName !== undefined && typeof data.lastName !== 'string') {
    errors.push('Last name must be a string');
  }

  if (errors.length > 0) {
    throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);
  }

  return {
    email: data.email.toLowerCase().trim(),
    password: data.password,
    firstName: data.firstName?.trim(),
    lastName: data.lastName?.trim(),
  };
};

// ── Login Schema ───────────────────────────────────────────────

export interface LoginInput {
  email: string;
  password: string;
}

export const validateLogin = (data: any): LoginInput => {
  const errors: string[] = [];

  if (!data.email || typeof data.email !== 'string') {
    errors.push('Email is required');
  }

  if (!data.password || typeof data.password !== 'string') {
    errors.push('Password is required');
  }

  if (errors.length > 0) {
    throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);
  }

  return {
    email: data.email.toLowerCase().trim(),
    password: data.password,
  };
};

// ── Refresh Token Schema ───────────────────────────────────────

export interface RefreshInput {
  refreshToken: string;
}

export const validateRefresh = (data: any): RefreshInput => {
  if (!data.refreshToken || typeof data.refreshToken !== 'string') {
    throw new AppError('Refresh token is required', HTTP_STATUS.BAD_REQUEST);
  }
  return { refreshToken: data.refreshToken };
};

// ── Logout Schema ──────────────────────────────────────────────

export interface LogoutInput {
  refreshToken: string;
}

export const validateLogout = (data: any): LogoutInput => {
  if (!data.refreshToken || typeof data.refreshToken !== 'string') {
    throw new AppError('Refresh token is required', HTTP_STATUS.BAD_REQUEST);
  }
  return { refreshToken: data.refreshToken };
};

// ── Complete FTL Schema ────────────────────────────────────────

export interface CompleteFtlInput {
  currentPassword: string;
  newPassword: string;
  firstName?: string;
  lastName?: string;
}

export const validateCompleteFtl = (data: any): CompleteFtlInput => {
  const errors: string[] = [];

  if (!data.currentPassword || typeof data.currentPassword !== 'string') {
    errors.push('Current password is required');
  }

  if (!data.newPassword || typeof data.newPassword !== 'string') {
    errors.push('New password is required');
  } else if (data.newPassword.length < 8) {
    errors.push('New password must be at least 8 characters long');
  }

  if (data.firstName !== undefined && typeof data.firstName !== 'string') {
    errors.push('First name must be a string');
  }

  if (data.lastName !== undefined && typeof data.lastName !== 'string') {
    errors.push('Last name must be a string');
  }

  if (errors.length > 0) {
    throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);
  }

  return {
    currentPassword: data.currentPassword,
    newPassword: data.newPassword,
    firstName: data.firstName?.trim(),
    lastName: data.lastName?.trim(),
  };
};
