import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export interface CreatePilotLeadInput {
  parentName: string;
  studentName: string;
  studentGrade: string;
  parentEmail: string;
  parentPhone: string;
  presentCountry: string;
  preferredLanguage: string;
  hearAbout?: string;
  preferredSlotDate?: string;
  preferredSlotTime?: string;
  preferredTimezone?: string;
  telecallerNotes?: string;
  /** The browser pixel's Lead event id, so Meta deduplicates it against CAPI. */
  eventId?: string;
}

export interface UpdatePilotLeadInput {
  parentName?: string;
  studentName?: string;
  studentGrade?: string;
  parentEmail?: string;
  parentPhone?: string;
  presentCountry?: string;
  preferredLanguage?: string;
  hearAbout?: string;
  status?: 'NEW' | 'CONTACTED' | 'INTERESTED' | 'DEMO_SCHEDULED' | 'ENROLLED' | 'LOST';
  preferredSlotDate?: string;
  preferredSlotTime?: string;
  preferredTimezone?: string;
  telecallerNotes?: string;
}

const VALID_STATUSES = ['NEW', 'CONTACTED', 'INTERESTED', 'DEMO_SCHEDULED', 'ENROLLED', 'LOST'];
const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const validateCreatePilotLead = (data: any): CreatePilotLeadInput => {
  const errors: string[] = [];

  const parentName = data.parentName || data.firstName;
  const studentName = data.studentName || data.studentFirstName;
  const parentEmail = data.parentEmail || data.email;
  const parentPhone = data.parentPhone || data.phone;
  const studentGrade = data.studentGrade || data.grade || 'Grade 6';
  const presentCountry = data.presentCountry || data.country || 'India';
  const preferredLanguage = data.preferredLanguage || data.language || 'English';

  if (!parentName || typeof parentName !== 'string' || !parentName.trim()) {
    errors.push('Parent / Guardian Name is required');
  }
  if (!studentName || typeof studentName !== 'string' || !studentName.trim()) {
    errors.push("Student's Name is required");
  }
  if (!parentEmail || typeof parentEmail !== 'string') {
    errors.push('Parent Email Address is required');
  } else if (!isValidEmail(parentEmail.trim())) {
    errors.push('Invalid email format');
  }
  if (!parentPhone || typeof parentPhone !== 'string' || !parentPhone.trim()) {
    errors.push('Parent WhatsApp Number is required');
  }

  if (errors.length > 0) {
    throw new AppError(errors.join(', '), HTTP_STATUS.BAD_REQUEST);
  }

  return {
    parentName: String(parentName).trim(),
    studentName: String(studentName).trim(),
    studentGrade: String(studentGrade).trim(),
    parentEmail: String(parentEmail).trim(),
    parentPhone: String(parentPhone).trim(),
    presentCountry: String(presentCountry).trim(),
    preferredLanguage: String(preferredLanguage).trim(),
    hearAbout: data.hearAbout ? String(data.hearAbout).trim() : undefined,
    preferredSlotDate: data.preferredSlotDate || data.preferredDays?.[0] || undefined,
    preferredSlotTime: data.preferredSlotTime || data.preferredTime || undefined,
    preferredTimezone: data.preferredTimezone || undefined,
    telecallerNotes: data.telecallerNotes ? String(data.telecallerNotes).trim() : undefined,
    eventId: typeof data.eventId === 'string' && data.eventId.trim() ? data.eventId.trim() : undefined,
  };
};

export const validateUpdatePilotLead = (data: any): UpdatePilotLeadInput => {
  const errors: string[] = [];

  if (data.status && !VALID_STATUSES.includes(data.status)) {
    errors.push(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  if (data.parentEmail && !isValidEmail(data.parentEmail.trim())) {
    errors.push('Invalid email format');
  }

  if (errors.length > 0) {
    throw new AppError(errors.join(', '), HTTP_STATUS.BAD_REQUEST);
  }

  return data;
};
