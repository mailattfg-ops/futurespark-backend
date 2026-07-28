import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export interface CreateGroupInput {
  name: string;
  description?: string;
  schedulerId?: string | null;
  maxMentors?: number;
  maxStudents?: number;
}

export const validateCreateGroup = (data: any): CreateGroupInput => {
  const errors: string[] = [];

  if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
    errors.push('Group name is required');
  }

  if (data.description !== undefined && typeof data.description !== 'string') {
    errors.push('Description must be a string');
  }

  if (data.schedulerId !== undefined && data.schedulerId !== null && typeof data.schedulerId !== 'string') {
    errors.push('Scheduler ID must be a string or null');
  }

  if (data.maxMentors !== undefined && (typeof data.maxMentors !== 'number' || data.maxMentors <= 0)) {
    errors.push('maxMentors must be a positive number');
  }

  if (data.maxStudents !== undefined && (typeof data.maxStudents !== 'number' || data.maxStudents <= 0)) {
    errors.push('maxStudents must be a positive number');
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    name: data.name.trim(),
    description: data.description?.trim(),
    schedulerId: data.schedulerId || null,
    maxMentors: data.maxMentors || 50,
    maxStudents: data.maxStudents || 100,
  };
};

export interface UpdateGroupInput {
  name?: string;
  description?: string;
  schedulerId?: string | null;
  maxMentors?: number;
  maxStudents?: number;
}

export const validateUpdateGroup = (data: any): UpdateGroupInput => {
  const errors: string[] = [];

  if (data.name !== undefined) {
    if (typeof data.name !== 'string' || !data.name.trim()) {
      errors.push('Name must be a non-empty string');
    }
  }

  if (data.description !== undefined && typeof data.description !== 'string') {
    errors.push('Description must be a string');
  }

  if (data.schedulerId !== undefined && data.schedulerId !== null && typeof data.schedulerId !== 'string') {
    errors.push('Scheduler ID must be a string or null');
  }

  if (data.maxMentors !== undefined && (typeof data.maxMentors !== 'number' || data.maxMentors <= 0)) {
    errors.push('maxMentors must be a positive number');
  }

  if (data.maxStudents !== undefined && (typeof data.maxStudents !== 'number' || data.maxStudents <= 0)) {
    errors.push('maxStudents must be a positive number');
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    name: data.name?.trim(),
    description: data.description?.trim(),
    schedulerId: data.schedulerId,
    maxMentors: data.maxMentors,
    maxStudents: data.maxStudents,
  };
};

export interface UpdateMembersInput {
  mentorIdsToAdd?: string[];
  mentorIdsToRemove?: string[];
  studentIdsToAdd?: string[];
  studentIdsToRemove?: string[];
}

export const validateUpdateMembers = (data: any): UpdateMembersInput => {
  const errors: string[] = [];

  if (data.mentorIdsToAdd !== undefined && !Array.isArray(data.mentorIdsToAdd)) {
    errors.push('mentorIdsToAdd must be an array of strings');
  }
  if (data.mentorIdsToRemove !== undefined && !Array.isArray(data.mentorIdsToRemove)) {
    errors.push('mentorIdsToRemove must be an array of strings');
  }
  if (data.studentIdsToAdd !== undefined && !Array.isArray(data.studentIdsToAdd)) {
    errors.push('studentIdsToAdd must be an array of strings');
  }
  if (data.studentIdsToRemove !== undefined && !Array.isArray(data.studentIdsToRemove)) {
    errors.push('studentIdsToRemove must be an array of strings');
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    mentorIdsToAdd: data.mentorIdsToAdd,
    mentorIdsToRemove: data.mentorIdsToRemove,
    studentIdsToAdd: data.studentIdsToAdd,
    studentIdsToRemove: data.studentIdsToRemove,
  };
};
