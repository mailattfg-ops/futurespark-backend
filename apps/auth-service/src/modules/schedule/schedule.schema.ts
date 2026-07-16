import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export interface CreateScheduleInput {
  studentId: string;
  mentorId: string;
  programId: string;
  sessionId: string;
  startTime: string;
}

export const validateCreateSchedule = (data: any): CreateScheduleInput => {
  const errors: string[] = [];

  if (!data.studentId || typeof data.studentId !== 'string') {
    errors.push('Student ID is required and must be a string');
  }

  if (!data.mentorId || typeof data.mentorId !== 'string') {
    errors.push('Mentor ID is required and must be a string');
  }

  if (!data.programId || typeof data.programId !== 'string') {
    errors.push('Program ID is required and must be a string');
  }

  if (!data.sessionId || typeof data.sessionId !== 'string') {
    errors.push('Session ID is required and must be a string');
  }

  if (!data.startTime || typeof data.startTime !== 'string' || isNaN(Date.parse(data.startTime))) {
    errors.push('Start time is required and must be a valid date string');
  }

  if (errors.length > 0) {
    throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);
  }

  return {
    studentId: data.studentId.trim(),
    mentorId: data.mentorId.trim(),
    programId: data.programId.trim(),
    sessionId: data.sessionId.trim(),
    startTime: data.startTime.trim(),
  };
};

export interface UpdateScheduleInput {
  status?: string;
  startTime?: string;
  mentorId?: string;
}

export const validateUpdateSchedule = (data: any): UpdateScheduleInput => {
  const errors: string[] = [];

  if (data.status !== undefined) {
    if (typeof data.status !== 'string' || !['SCHEDULED', 'COMPLETED', 'CANCELLED'].includes(data.status)) {
      errors.push('Status must be SCHEDULED, COMPLETED, or CANCELLED');
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
  };
};
