import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export interface CreateLeadInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  source?: string;
  status?: string;
  programId?: string;
  notes?: string;
  demoClass?: boolean;
}

const VALID_STATUSES = ['NEW', 'CONTACTED', 'INTERESTED', 'ENROLLED', 'LOST'];
const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const validateCreateLead = (data: any): CreateLeadInput => {
  const errors: string[] = [];

  if (!data.firstName || typeof data.firstName !== 'string') {
    errors.push('First name is required');
  }
  if (!data.lastName || typeof data.lastName !== 'string') {
    errors.push('Last name is required');
  }
  if (!data.email || typeof data.email !== 'string') {
    errors.push('Email is required');
  } else if (!isValidEmail(data.email)) {
    errors.push('Invalid email format');
  }

  if (data.phone !== undefined && typeof data.phone !== 'string') {
    errors.push('Phone must be a string');
  }
  if (data.source !== undefined && typeof data.source !== 'string') {
    errors.push('Source must be a string');
  }
  if (data.status !== undefined && (typeof data.status !== 'string' || !VALID_STATUSES.includes(data.status))) {
    errors.push('Invalid lead status');
  }
  if (data.programId !== undefined && typeof data.programId !== 'string') {
    errors.push('Program ID must be a string');
  }
  if (data.notes !== undefined && typeof data.notes !== 'string') {
    errors.push('Notes must be a string');
  }
  if (data.demoClass !== undefined && typeof data.demoClass !== 'boolean') {
    errors.push('demoClass must be a boolean');
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    firstName: data.firstName.trim(),
    lastName: data.lastName.trim(),
    email: data.email.trim().toLowerCase(),
    phone: data.phone?.trim() || undefined,
    source: data.source?.trim() || 'Website',
    status: data.status || 'NEW',
    programId: data.programId || undefined,
    notes: data.notes?.trim() || undefined,
    demoClass: data.demoClass !== undefined ? data.demoClass : false,
  };
};

export interface UpdateLeadInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  source?: string;
  status?: string;
  programId?: string;
  notes?: string;
  demoClass?: boolean;
}

export const validateUpdateLead = (data: any): UpdateLeadInput => {
  const errors: string[] = [];

  if (data.firstName !== undefined && typeof data.firstName !== 'string') errors.push('First name must be a string');
  if (data.lastName !== undefined && typeof data.lastName !== 'string') errors.push('Last name must be a string');
  if (data.email !== undefined) {
    if (typeof data.email !== 'string') errors.push('Email must be a string');
    else if (!isValidEmail(data.email)) errors.push('Invalid email format');
  }
  if (data.phone !== undefined && typeof data.phone !== 'string') errors.push('Phone must be a string');
  if (data.source !== undefined && typeof data.source !== 'string') errors.push('Source must be a string');
  if (data.status !== undefined && (typeof data.status !== 'string' || !VALID_STATUSES.includes(data.status))) {
    errors.push('Invalid lead status');
  }
  if (data.programId !== undefined && typeof data.programId !== 'string') errors.push('Program ID must be a string');
  if (data.notes !== undefined && typeof data.notes !== 'string') errors.push('Notes must be a string');
  if (data.demoClass !== undefined && typeof data.demoClass !== 'boolean') errors.push('demoClass must be a boolean');

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    firstName: data.firstName?.trim(),
    lastName: data.lastName?.trim(),
    email: data.email?.trim().toLowerCase(),
    phone: data.phone?.trim(),
    source: data.source?.trim(),
    status: data.status,
    programId: data.programId,
    notes: data.notes?.trim(),
    demoClass: data.demoClass,
  };
};
