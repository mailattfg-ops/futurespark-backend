import { db } from '../../../database/datasource';
import { GoogleCalendarService } from '../calendar/calendar.service';
import { logger } from '@futurespark/logger';

export interface CreateMeetingInput {
  title: string;
  description?: string;
  startTime: string; // ISO string
  endTime: string; // ISO string
  timezone: string;
  attendees: string[];
  teacherId: string;
  studentId: string;
  programId: string;
  sessionId: string;
}

export interface UpdateMeetingInput {
  title?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  attendees?: string[];
  status?: string;
}

export class GoogleMeetingsService {
  static async create(workspaceEmail: string, input: CreateMeetingInput) {
    // 1. Validation
    const start = new Date(input.startTime);
    const end = new Date(input.endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Invalid start or end time format. Use ISO-8601 strings.');
    }
    if (start >= end) {
      throw new Error('Meeting start time must be before end time.');
    }

    // Check for duplicate meetings on the same calendar and time
    const existing = await db.meeting.findFirst({
      where: {
        organizerEmail: workspaceEmail,
        startTime: start,
        status: { not: 'CANCELLED' },
      },
    });
    if (existing) {
      throw new Error('A meeting is already scheduled at this time for this account.');
    }

    // 2. Call Google Calendar API to create Meet event
    logger.info(`Creating Google Calendar Event for Workspace email: ${workspaceEmail}`);
    const googleEvent = await GoogleCalendarService.createMeetEvent(workspaceEmail, {
      title: input.title,
      description: input.description,
      startTime: input.startTime,
      endTime: input.endTime,
      timezone: input.timezone,
      attendees: input.attendees,
    });

    // 3. Store metadata in local database
    const meeting = await db.meeting.create({
      data: {
        calendarEventId: googleEvent.eventId,
        conferenceId: googleEvent.conferenceId || null,
        meetUrl: googleEvent.meetLink,
        title: input.title,
        description: input.description || null,
        organizerEmail: googleEvent.organizer,
        teacherId: input.teacherId,
        studentId: input.studentId,
        programId: input.programId,
        sessionId: input.sessionId,
        startTime: start,
        endTime: end,
        timezone: input.timezone,
        status: 'SCHEDULED',
      },
    });

    logger.info(`Meeting created in database: ${meeting.id} with Meet Link: ${meeting.meetUrl}`);

    return {
      id: meeting.id,
      calendarEventId: meeting.calendarEventId,
      meetLink: meeting.meetUrl,
      calendarLink: googleEvent.calendarLink,
      startTime: meeting.startTime.toISOString(),
      endTime: meeting.endTime.toISOString(),
    };
  }

  static async getById(id: string) {
    const meeting = await db.meeting.findUnique({
      where: { id },
      include: { recordings: true },
    });
    if (!meeting) {
      throw new Error(`Meeting with ID ${id} not found.`);
    }
    return meeting;
  }

  static async list(filters: { teacherId?: string; studentId?: string; status?: string }) {
    return db.meeting.findMany({
      where: {
        teacherId: filters.teacherId || undefined,
        studentId: filters.studentId || undefined,
        status: filters.status || undefined,
      },
      include: { recordings: true },
      orderBy: { startTime: 'asc' },
    });
  }

  static async update(id: string, input: UpdateMeetingInput) {
    const meeting = await db.meeting.findUnique({ where: { id } });
    if (!meeting) {
      throw new Error(`Meeting with ID ${id} not found.`);
    }

    if (input.startTime && input.endTime) {
      const start = new Date(input.startTime);
      const end = new Date(input.endTime);
      if (start >= end) {
        throw new Error('Meeting start time must be before end time.');
      }
    }

    logger.info(`Updating Google Calendar Event ${meeting.calendarEventId} for Workspace: ${meeting.organizerEmail}`);

    // Update in Google Calendar
    const googleEvent = await GoogleCalendarService.updateMeetEvent(meeting.organizerEmail, meeting.calendarEventId, {
      title: input.title,
      description: input.description,
      startTime: input.startTime,
      endTime: input.endTime,
      timezone: input.timezone,
      attendees: input.attendees,
    });

    // Update local database
    const updated = await db.meeting.update({
      where: { id },
      data: {
        title: input.title || undefined,
        description: input.description !== undefined ? input.description : undefined,
        startTime: input.startTime ? new Date(input.startTime) : undefined,
        endTime: input.endTime ? new Date(input.endTime) : undefined,
        timezone: input.timezone || undefined,
        status: input.status || undefined,
      },
    });

    logger.info(`Successfully updated meeting metadata for ID ${id}`);

    return {
      id: updated.id,
      calendarEventId: updated.calendarEventId,
      meetLink: updated.meetUrl,
      calendarLink: googleEvent.calendarLink,
      startTime: updated.startTime.toISOString(),
      endTime: updated.endTime.toISOString(),
    };
  }

  static async delete(id: string) {
    const meeting = await db.meeting.findUnique({ where: { id } });
    if (!meeting) {
      throw new Error(`Meeting with ID ${id} not found.`);
    }

    logger.info(`Deleting Google Calendar Event ${meeting.calendarEventId} for Workspace: ${meeting.organizerEmail}`);

    try {
      // Delete event in Google Calendar
      await GoogleCalendarService.deleteMeetEvent(meeting.organizerEmail, meeting.calendarEventId);
    } catch (err: any) {
      // Soft handling: if it was already deleted on Calendar, log it and proceed
      logger.warn(`Google Calendar event deletion failed (might have been removed directly on Google): ${err.message}`);
    }

    // Soft delete: keep local history but mark status as CANCELLED
    const cancelledMeeting = await db.meeting.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    logger.info(`Meeting ${id} cancelled and soft-deleted in local database.`);
    return { id: cancelledMeeting.id, status: 'CANCELLED' };
  }
}
