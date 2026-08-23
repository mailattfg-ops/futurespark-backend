import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export interface CreateScheduleInput {
  studentId?: string;
  mentorId: string;
  programId: string;
  startTime: string;
  sessions?: { id: string; order: number; meetingLink?: string | null }[];
  classType?: string;
  leadId?: string;
  meetingLink?: string;
  autoRecording?: boolean;
  recordingUrl?: string;
  /**
   * Book the class even though the mentor, student or lead is already busy.
   *
   * Set only by a scheduler who has been shown the clash and chosen to go
   * ahead — catch-up lessons, two programmes deliberately stacked, a slot the
   * timetable does not know has freed up.
   */
  allowConflict?: boolean;
  /**
   * How consecutive sessions are spaced.
   *
   * WEEKLY (the default, and what every existing caller gets by omitting it)
   * puts one lesson a week on the same weekday. DAILY runs them on consecutive
   * days. SAME_DAY stacks them back to back from the chosen start time.
   */
  cadence?: 'WEEKLY' | 'DAILY' | 'SAME_DAY';
}

export const SCHEDULE_CADENCES = ['WEEKLY', 'DAILY', 'SAME_DAY'] as const;

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
    // Only a literal true is consent — a stray "false" string from a form post
    // must never read as permission to double-book a child.
    allowConflict: data.allowConflict === true || data.allowConflict === 'true',
    // Anything unrecognised falls back to WEEKLY, which is the shape every
    // existing caller already gets.
    cadence: SCHEDULE_CADENCES.includes(data.cadence) ? data.cadence : 'WEEKLY',
    leadId: data.leadId ? data.leadId.trim() : undefined,
    meetingLink: typeof data.meetingLink === 'string' && data.meetingLink.trim() !== '' ? data.meetingLink.trim() : undefined,
    sessions: data.sessions
      ? data.sessions.map((s: any) => ({
          id: s.id.trim(),
          order: s.order,
          meetingLink: typeof s.meetingLink === 'string' && s.meetingLink.trim() !== '' ? s.meetingLink.trim() : undefined,
        }))
      : undefined,
  };
};

export interface UpdateScheduleInput {
  status?: string;
  startTime?: string;
  mentorId?: string;
  meetingLink?: string | null;
  updateAll?: boolean;
  rescheduleReason?: string | null;
  rescheduleMessage?: string | null;
  qaStatus?: string;
  qaFeedback?: string | null;
  creditsAwarded?: number;
  /**
   * Move the class onto a slot where the mentor or student is already busy.
   *
   * A control flag, not an editable field, so it is absent from
   * TIMETABLE_UPDATE_FIELDS. The service honours it only for staff who own the
   * timetable — a participant who sends it has it ignored rather than refused.
   */
  allowConflict?: boolean;
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

  if (data.qaStatus !== undefined) {
    if (typeof data.qaStatus !== 'string' || !['PENDING', 'PASSED', 'FAILED', 'FLAGGED'].includes(data.qaStatus)) {
      errors.push('qaStatus must be PENDING, PASSED, FAILED, or FLAGGED');
    }
  }

  if (data.creditsAwarded !== undefined && typeof data.creditsAwarded !== 'number') {
    errors.push('creditsAwarded must be a number');
  }

  if (errors.length > 0) {
    throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);
  }

  return {
    status: data.status,
    startTime: data.startTime,
    mentorId: data.mentorId?.trim(),
    meetingLink: data.meetingLink === null ? null : (typeof data.meetingLink === 'string' ? data.meetingLink.trim() : undefined),
    updateAll: typeof data.updateAll === 'boolean' ? data.updateAll : undefined,
    rescheduleReason: data.rescheduleReason === null ? null : (typeof data.rescheduleReason === 'string' ? data.rescheduleReason.trim() : undefined),
    rescheduleMessage: data.rescheduleMessage === null ? null : (typeof data.rescheduleMessage === 'string' ? data.rescheduleMessage.trim() : undefined),
    qaStatus: typeof data.qaStatus === 'string' ? data.qaStatus.trim() : undefined,
    qaFeedback: data.qaFeedback === null ? null : (typeof data.qaFeedback === 'string' ? data.qaFeedback.trim() : undefined),
    creditsAwarded: typeof data.creditsAwarded === 'number' ? data.creditsAwarded : undefined,
    // Only a literal true is consent to move a class on top of another.
    allowConflict: data.allowConflict === true || data.allowConflict === 'true',
  };
};
