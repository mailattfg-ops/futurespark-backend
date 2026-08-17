import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export interface CreateLeadInput {
  /** The PARENT — the contact who enquired. */
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  /** The CHILD who will attend. Optional: a web enquiry may not name them. */
  studentFirstName?: string;
  studentLastName?: string;
  source?: string;
  status?: string;
  programId?: string;
  notes?: string;
  demoClass?: boolean;
  assignedAdvisorId?: string;
  preferredDays?: string[];
  preferredTime?: string;
  preferredTimezone?: string;
  paymentAmount?: number;
  paymentTxnRef?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  paymentVerifiedBy?: string;
  paymentVerifiedAt?: Date | string;
  telecallerNotes?: string;
}

const VALID_STATUSES = [
  'NEW',
  'CONTACTED',
  'INTERESTED',
  'DEMO_SCHEDULED',
  'ADMISSION_PENDING',
  'PAYMENT_SUBMITTED',
  'ENROLLED',
  'LOST',
];
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

  if (!data.phone || typeof data.phone !== 'string' || !data.phone.trim()) {
    errors.push('Phone number is required');
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
  if (data.studentFirstName !== undefined && typeof data.studentFirstName !== 'string') {
    errors.push("Student's first name must be a string");
  }
  if (data.studentLastName !== undefined && typeof data.studentLastName !== 'string') {
    errors.push("Student's last name must be a string");
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    firstName: data.firstName.trim(),
    lastName: data.lastName.trim(),
    email: data.email.trim().toLowerCase(),
    phone: data.phone?.trim() || undefined,
    // Empty string collapses to undefined so a blank form field stores NULL
    // rather than '' — readers test for a missing student name, and '' would
    // pass that test and then render as nothing at all.
    studentFirstName: data.studentFirstName?.trim() || undefined,
    studentLastName: data.studentLastName?.trim() || undefined,
    source: data.source?.trim() || 'Website',
    status: data.status || 'NEW',
    programId: data.programId || undefined,
    notes: data.notes?.trim() || undefined,
    demoClass: data.demoClass !== undefined ? data.demoClass : false,
    assignedAdvisorId: data.assignedAdvisorId,
    preferredDays: Array.isArray(data.preferredDays) ? data.preferredDays : [],
    preferredTime: data.preferredTime,
    preferredTimezone: data.preferredTimezone || 'Asia/Kolkata',
    paymentAmount: data.paymentAmount,
    paymentTxnRef: data.paymentTxnRef,
    paymentMethod: data.paymentMethod,
    paymentStatus: data.paymentStatus || 'NONE',
    telecallerNotes: data.telecallerNotes,
  };
};

export interface UpdateLeadInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  studentFirstName?: string;
  studentLastName?: string;
  source?: string;
  status?: string;
  programId?: string;
  notes?: string;
  demoClass?: boolean;
  assignedAdvisorId?: string;
  preferredDays?: string[];
  preferredTime?: string;
  preferredTimezone?: string;
  paymentAmount?: number;
  paymentTxnRef?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  paymentVerifiedBy?: string;
  paymentVerifiedAt?: Date | string;
  telecallerNotes?: string;
}

export const validateUpdateLead = (data: any): UpdateLeadInput => {
  const errors: string[] = [];

  if (data.firstName !== undefined && typeof data.firstName !== 'string') errors.push('First name must be a string');
  if (data.lastName !== undefined && typeof data.lastName !== 'string') errors.push('Last name must be a string');
  if (data.email !== undefined) {
    if (typeof data.email !== 'string') errors.push('Email must be a string');
    else if (!isValidEmail(data.email)) errors.push('Invalid email format');
  }
  if (data.phone !== undefined && (typeof data.phone !== 'string' || !data.phone.trim())) {
    errors.push('Phone number cannot be empty');
  }
  if (data.source !== undefined && typeof data.source !== 'string') errors.push('Source must be a string');
  if (data.status !== undefined && (typeof data.status !== 'string' || !VALID_STATUSES.includes(data.status))) {
    errors.push('Invalid lead status');
  }
  if (data.programId !== undefined && typeof data.programId !== 'string') errors.push('Program ID must be a string');
  if (data.notes !== undefined && typeof data.notes !== 'string') errors.push('Notes must be a string');
  if (data.demoClass !== undefined && typeof data.demoClass !== 'boolean') errors.push('demoClass must be a boolean');
  if (data.studentFirstName !== undefined && typeof data.studentFirstName !== 'string') {
    errors.push("Student's first name must be a string");
  }
  if (data.studentLastName !== undefined && typeof data.studentLastName !== 'string') {
    errors.push("Student's last name must be a string");
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    firstName: data.firstName?.trim(),
    lastName: data.lastName?.trim(),
    email: data.email?.trim().toLowerCase(),
    phone: data.phone?.trim(),
    // `?? undefined` and not `|| undefined`: clearing the field sends '', and
    // the service maps '' to null so a wrongly-entered student name can
    // actually be removed. `||` would silently discard the clear.
    studentFirstName: data.studentFirstName !== undefined ? data.studentFirstName.trim() : undefined,
    studentLastName: data.studentLastName !== undefined ? data.studentLastName.trim() : undefined,
    source: data.source?.trim(),
    status: data.status,
    programId: data.programId,
    notes: data.notes?.trim(),
    demoClass: data.demoClass,
    assignedAdvisorId: data.assignedAdvisorId,
    preferredDays: Array.isArray(data.preferredDays) ? data.preferredDays : undefined,
    preferredTime: data.preferredTime,
    preferredTimezone: data.preferredTimezone,
    paymentAmount: data.paymentAmount,
    paymentTxnRef: data.paymentTxnRef,
    paymentMethod: data.paymentMethod,
    paymentStatus: data.paymentStatus,
    paymentVerifiedBy: data.paymentVerifiedBy,
    paymentVerifiedAt: data.paymentVerifiedAt,
    telecallerNotes: data.telecallerNotes?.trim(),
  };
};
