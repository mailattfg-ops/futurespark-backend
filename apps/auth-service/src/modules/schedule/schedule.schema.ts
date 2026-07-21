import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export interface CreateScheduleInput {
  studentId?: string;
  mentorId: string;
  programId: string;
  startTime: string;
  sessions?: { id: string; order: number }[];
  classType?: string;
  leadId?: string;
}

export const validateCreateSchedule = (data: any): CreateScheduleInput => {
  const errors: string[] = [];
  const classType = data.classType || 'REGULAR';

  if (classType === 'REGULAR') {
    if (!data.studentId || typeof data.studentId !== 'string') {
      errors.push('Student ID is required for regular classes');
    }
    if (!Array.isArray(data.sessions) || data.sessions.length === 0) {
      errors.push('Sessions list is required for regular classes');
    } else {
      data.sessions.forEach((s: any, idx: number) => {
        if (!s || !s.id || typeof s.id !== 'string') {
          errors.push(`Session at index ${idx} must contain a valid string id`);
        }
        if (!s || typeof s.order !== 'number') {
          errors.push(`Session at index ${idx} must contain a numeric order number`);
        }
      });
    }
  } else if (classType === 'DEMO') {
    if (!data.leadId || typeof data.leadId !== 'string') {
      errors.push('Lead ID is required for demo classes');
    }
  } else {
    errors.push('Invalid class type');
  }

  if (!data.mentorId || typeof data.mentorId !== 'string') {
    errors.push('Mentor ID is required and must be a string');
  }

  if (!data.programId || typeof data.programId !== 'string') {
    errors.push('Program ID is required and must be a string');
  }

  if (!data.startTime || typeof data.startTime !== 'string' || isNaN(Date.parse(data.startTime))) {
    errors.push('Start time is required and must be a valid date string');
  }

  if (errors.length > 0) {
    throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);
  }

  return {
    studentId: data.studentId ? data.studentId.trim() : undefined,
    mentorId: data.mentorId.trim(),
    programId: data.programId.trim(),
    startTime: data.startTime.trim(),
    classType,
    leadId: data.leadId ? data.leadId.trim() : undefined,
    sessions: data.sessions
      ? data.sessions.map((s: any) => ({
          id: s.id.trim(),
          order: s.order,
        }))
      : undefined,
  };
};

export interface UpdateScheduleInput {
  status?: string;
  startTime?: string;
  mentorId?: string;
  rescheduleReason?: string | null;
  rescheduleMessage?: string | null;
}

export const validateUpdateSchedule = (data: any): UpdateScheduleInput => {
  const errors: string[] = [];

  if (data.status !== undefined) {
    if (typeof data.status !== 'string' || !['SCHEDULED', 'COMPLETED', 'CANCELLED', 'RESCHEDULE_REQUESTED'].includes(data.status)) {
      errors.push('Status must be SCHEDULED, COMPLETED, CANCELLED, or RESCHEDULE_REQUESTED');
    }
  }

  if (data.startTime !== undefined) {
    if (typeof data.startTime !== 'string' || isNaN(Date.parse(data.startTime))) {
      errors.push('Start time must be a valid date string');
    }
  }

  if (data.mentorId !== undefined) {
    if (typeof data.mentorId !== 'string' || data.mentorId.trim() === '') {
      errors.push('Mentor ID must be a non-empty string');
    }
  }

  if (errors.length > 0) {
    throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);
  }

  return {
    status: data.status,
    startTime: data.startTime,
    mentorId: data.mentorId?.trim(),
    rescheduleReason: data.rescheduleReason === null ? null : (typeof data.rescheduleReason === 'string' ? data.rescheduleReason.trim() : undefined),
    rescheduleMessage: data.rescheduleMessage === null ? null : (typeof data.rescheduleMessage === 'string' ? data.rescheduleMessage.trim() : undefined),
  };
};
