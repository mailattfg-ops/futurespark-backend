import { db, withDbRetry } from '../../../database/datasource';
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

    // Retrying the exact same booking? Reuse the room instead of failing.
    //
    // The scheduler creates the Google meeting first and saves the class second.
    // If that second step fails, the room is left orphaned — and a naive conflict
    // check then blocks the retry forever using the debris of the first attempt.
    // Same teacher + same student + same instant is the same booking, not a clash.
    const sameBooking = await db.meeting.findFirst({
      where: {
        startTime: start,
        status: { not: 'CANCELLED' },
        teacherId: input.teacherId,
        studentId: input.studentId,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (sameBooking) {
      // Only reuse it if the Calendar event is genuinely still live. Deleting a
      // class cancels the event on Google but can leave our row behind saying
      // SCHEDULED. Handing back a cancelled room looks fine — the Meet link still
      // works — but attendees see it cancelled, and Meet stops naming recordings
      // after the class, falling back to "abc-defg-hij (2026-08-06 14:32 …)".
      const stillActive = sameBooking.calendarEventId
        ? await GoogleCalendarService.isEventActive(
            sameBooking.organizerEmail,
            sameBooking.calendarEventId
          )
        : true;

      if (stillActive === false) {
        logger.warn(
          `[GoogleMeetingsService] Existing room ${sameBooking.meetUrl} has a CANCELLED calendar event — ` +
          `creating a fresh room instead of reusing it.`
        );
        await db.meeting
          .update({ where: { id: sameBooking.id }, data: { status: 'CANCELLED' } })
          .catch(() => {});
        // fall through and create a new meeting
      } else {
        logger.info(
          `[GoogleMeetingsService] Reusing existing room ${sameBooking.meetUrl} for the same teacher/student/slot ` +
          `(meeting ${sameBooking.id}) instead of creating a duplicate.`
        );
        return {
          id: sameBooking.id,
          calendarEventId: sameBooking.calendarEventId,
          meetLink: sameBooking.meetUrl,
          calendarLink: sameBooking.meetUrl,
          startTime: sameBooking.startTime.toISOString(),
          endTime: sameBooking.endTime.toISOString(),
          reused: true,
        };
      }
    }

    // Guard against double-booking the same PERSON, not the same calendar account.
    //
    // Every booking is organized by one shared workspace account, so keying this
    // check on (organizerEmail, startTime) capped the whole platform at a single
    // class per start time. 1-to-1 mentorship runs many concurrent classes at the
    // same hour with different students and mentors, which is legitimate.
    const conflict = await db.meeting.findFirst({
      where: {
        startTime: start,
        status: { not: 'CANCELLED' },
        OR: [
          { teacherId: input.teacherId },
          { studentId: input.studentId },
        ],
      },
    });
    if (conflict) {
      const who = conflict.teacherId === input.teacherId ? 'mentor' : 'student';
      const localTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: conflict.timezone || input.timezone || 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(start);
      throw new Error(
        `This ${who} is already booked at ${localTime} for "${conflict.title}". Pick a different time or mentor.`
      );
    }

    // 2. Call Google Calendar API to create Meet event (with quota fallback)
    let googleEvent: any = null;
    try {
      logger.info(`Creating Google Calendar Event for Workspace email: ${workspaceEmail}`);
      googleEvent = await GoogleCalendarService.createMeetEvent(workspaceEmail, {
        title: input.title,
        description: input.description,
        startTime: input.startTime,
        endTime: input.endTime,
        timezone: input.timezone,
        attendees: input.attendees,
      });
    } catch (apiErr: any) {
      // Fail loudly. This previously fell back to either a randomly generated Meet
      // code (a syntactically valid room that does not exist and nobody can join)
      // or — worse — the most recent meetUrl for the same program, which drops two
      // different students into ONE live 1-to-1 room and cross-links their
      // recordings, since Drive matching keys on the Meet code.
      //
      // A failed booking the scheduler can retry is strictly safer than a booking
      // that reports success and hands out a dead or shared link.
      logger.error(
        `[GoogleMeetingsService] Google Calendar API failed for ${workspaceEmail} (${apiErr.message}). ` +
        `Refusing to fabricate a Meet link — no meeting was created.`
      );
      throw new Error(
        `Could not create the Google Meet room: ${apiErr.message}. No meeting was scheduled — please retry.`
      );
    }

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
    if (meeting.calendarEventId) {
      await GoogleCalendarService.updateMeetEvent(meeting.organizerEmail, meeting.calendarEventId, {
        title: input.title,
        description: input.description,
        startTime: input.startTime,
        endTime: input.endTime,
        timezone: input.timezone,
        attendees: input.attendees,
      });
    }

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
      calendarLink: updated.meetUrl,
      startTime: updated.startTime.toISOString(),
      endTime: updated.endTime.toISOString(),
    };
  }

  /**
   * Move a meeting by its Meet link rather than its internal id.
   *
   * auth-service owns the class schedule but has no idea what an integration
   * Meeting id is — all it holds is the meetingLink. Rescheduling a class used
   * to move only the class row, leaving the Google Calendar event (and therefore
   * the invite everyone sees, and the timestamp Meet stamps into the recording
   * filename) still pointing at the old slot.
   */
  static async rescheduleByLink(
    meetUrl: string,
    input: { startTime: string; endTime: string; timezone?: string }
  ) {
    const code = meetUrl.trim().split('?')[0].split('#')[0].split('/').pop();
    if (!code) throw new Error('A valid Google Meet link is required.');

    const meeting = await db.meeting.findFirst({
      where: { meetUrl: { contains: code } },
      orderBy: { createdAt: 'desc' },
    });
    if (!meeting) {
      throw new Error(`No meeting found for Meet link ${meetUrl}`);
    }

    // Calendar events created by the quota fallback have no real event id, so
    // there is nothing on Google to move.
    if (!meeting.calendarEventId || meeting.calendarEventId.startsWith('manual_')) {
      logger.warn(
        `[GoogleMeetingsService] Meeting ${meeting.id} has no real Calendar event — updating local times only.`
      );
      const updated = await db.meeting.update({
        where: { id: meeting.id },
        data: {
          startTime: new Date(input.startTime),
          endTime: new Date(input.endTime),
          timezone: input.timezone || undefined,
        },
      });
      return { id: updated.id, meetLink: updated.meetUrl, calendarUpdated: false };
    }

    const result = await GoogleMeetingsService.update(meeting.id, {
      startTime: input.startTime,
      endTime: input.endTime,
      timezone: input.timezone,
    });
    return { ...result, calendarUpdated: true };
  }

  static async delete(id: string) {
    const meeting = await db.meeting.findUnique({ where: { id } });
    if (!meeting) {
      throw new Error(`Meeting with ID ${id} not found.`);
    }

    logger.info(`Deleting Google Calendar Event ${meeting.calendarEventId} for Workspace: ${meeting.organizerEmail}`);

    try {
      // Delete event in Google Calendar
      if (meeting.calendarEventId) {
        await GoogleCalendarService.deleteMeetEvent(meeting.organizerEmail, meeting.calendarEventId);
      }
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

  static async syncManualClass(input: {
    meetingLink: string;
    title: string;
    description?: string;
    startTime: string;
    endTime: string;
    organizerEmail: string;
    teacherId: string;
    studentId: string;
    programId: string;
    sessionId: string;
  }) {
    try {
      let meeting = await withDbRetry(() => db.meeting.findFirst({
        where: { meetUrl: input.meetingLink },
      }));

      if (!meeting) {
        const start = new Date(input.startTime);
        const end = new Date(input.endTime);

        meeting = await withDbRetry(() => db.meeting.create({
          data: {
            calendarEventId: `manual_${Math.random().toString(36).substring(7)}`,
            meetUrl: input.meetingLink,
            title: input.title,
            description: input.description || null,
            organizerEmail: input.organizerEmail,
            teacherId: input.teacherId,
            studentId: input.studentId,
            programId: input.programId,
            sessionId: input.sessionId,
            startTime: start,
            endTime: end,
            timezone: 'UTC',
            status: 'COMPLETED',
          },
        }));
      }

      return meeting;
    } catch (err: any) {
      logger.warn(`[GoogleMeetingsService] DB sync failed (${err.message}). Using fallback meeting metadata...`);
      return {
        id: `manual_${input.sessionId || Math.random().toString(36).substring(7)}`,
        meetUrl: input.meetingLink,
        title: input.title,
        organizerEmail: input.organizerEmail || 'rec@meet.finquojunior.com',
        teacherId: input.teacherId,
        studentId: input.studentId,
        programId: input.programId,
        sessionId: input.sessionId,
        status: 'COMPLETED',
      };
    }
  }

  static async deleteByLink(meetUrl: string) {
    const meeting = await db.meeting.findFirst({
      where: { meetUrl, status: { not: 'CANCELLED' } },
    });
    if (!meeting) {
      logger.warn(`No active meeting found in database for URL: ${meetUrl}`);
      return null;
    }
    return this.delete(meeting.id);
  }
}
