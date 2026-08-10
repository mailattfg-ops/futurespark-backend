import { db, withDbRetry } from '../../../database/datasource';
import { ZoomAuthService } from '../auth/auth.service';
import { logger } from '@futurespark/logger';
import crypto from 'crypto';

export interface CreateZoomMeetingInput {
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

export interface UpdateZoomMeetingInput {
  title?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  attendees?: string[];
  status?: string;
}

const isRetryableZoomError = (status: number): boolean => {
  return status === 429 || status === 500 || status === 503;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withZoomRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      if (attempt === attempts || !isRetryableZoomError(status)) throw err;

      const delay = Math.round(500 * 2 ** (attempt - 1) * (1 + Math.random() * 0.4));
      logger.warn(
        `[ZoomMeeting] ${label} hit rate limit / temporary failure (attempt ${attempt}/${attempts}). Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

export class ZoomMeetingsService {
  /**
   * Creates a Zoom Meeting via Zoom REST API, checks conflicts, and saves meeting metadata to DB.
   */
  static async create(workspaceEmail: string, input: CreateZoomMeetingInput) {
    // 1. Validation
    const start = new Date(input.startTime);
    const end = new Date(input.endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Invalid start or end time format. Use ISO-8601 strings.');
    }
    if (start >= end) {
      throw new Error('Meeting start time must be before end time.');
    }

    // 2. Reuse check: Same teacher + same student + same start time
    const sameBooking = await withDbRetry(() =>
      db.meeting.findFirst({
        where: {
          startTime: start,
          status: { not: 'CANCELLED' },
          teacherId: input.teacherId,
          studentId: input.studentId,
        },
        orderBy: { createdAt: 'desc' },
      })
    );

    if (sameBooking) {
      logger.info(
        `[ZoomMeetingsService] Reusing existing room ${sameBooking.meetUrl} for meeting ${sameBooking.id}`
      );
      return {
        id: sameBooking.id,
        zoomMeetingId: sameBooking.zoomMeetingId || '',
        meetLink: sameBooking.meetUrl,
        joinUrl: sameBooking.zoomJoinUrl || sameBooking.meetUrl,
        startUrl: sameBooking.zoomStartUrl || sameBooking.meetUrl,
        passcode: sameBooking.zoomPasscode || '',
        calendarLink: sameBooking.meetUrl,
        startTime: sameBooking.startTime.toISOString(),
        endTime: sameBooking.endTime.toISOString(),
        reused: true,
      };
    }

    // 3. Double booking conflict check for teacher or student
    const conflict = await withDbRetry(() =>
      db.meeting.findFirst({
        where: {
          startTime: start,
          status: { not: 'CANCELLED' },
          OR: [
            { teacherId: input.teacherId },
            { studentId: input.studentId },
          ],
        },
      })
    );

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

    // 4. Calculate duration in minutes
    const durationMinutes = Math.max(15, Math.round((end.getTime() - start.getTime()) / (60 * 1000)));

    // 5. Call Zoom REST API
    let zoomData: any = null;
    try {
      const accessToken = await ZoomAuthService.getAccessToken(workspaceEmail);

      const zoomPayload = {
        topic: input.title,
        agenda: input.description || `FutureSpark Session: ${input.title}`,
        type: 2, // Scheduled meeting
        start_time: input.startTime,
        duration: durationMinutes,
        timezone: input.timezone || 'Asia/Kolkata',
        settings: {
          host_video: true,
          participant_video: true,
          join_before_host: true,
          jbh_time: 0,
          mute_upon_entry: true,
          waiting_room: false,
          auto_recording: 'cloud', // auto record to Zoom cloud
          audio: 'both',
          meeting_authentication: false,
        },
      };

      const res = await withZoomRetry('createMeeting', async () => {
        const response = await fetch('https://api.zoom.us/v2/users/me/meetings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(zoomPayload),
        });

        if (!response.ok) {
          const errBody = await response.text();
          const err: any = new Error(`Zoom API error (${response.status}): ${errBody}`);
          err.status = response.status;
          throw err;
        }

        return response.json();
      });

      zoomData = res;
    } catch (apiErr: any) {
      logger.error(`[ZoomMeetingsService] Zoom API creation failed: ${apiErr.message}`);
      throw new Error(`Could not create Zoom meeting: ${apiErr.message}. Please verify Zoom credentials.`);
    }

    const meetingIdStr = String(zoomData.id);
    const joinUrl = zoomData.join_url;
    const startUrl = zoomData.start_url || zoomData.join_url;
    const passcode = zoomData.password || zoomData.encrypted_password || '';

    // 6. Store meeting in database
    const meeting = await withDbRetry(() =>
      db.meeting.create({
        data: {
          provider: 'ZOOM',
          zoomMeetingId: meetingIdStr,
          zoomJoinUrl: joinUrl,
          zoomStartUrl: startUrl,
          zoomPasscode: passcode,
          zoomHostEmail: zoomData.host_email || workspaceEmail,
          meetUrl: joinUrl,
          title: input.title,
          description: input.description || null,
          organizerEmail: workspaceEmail,
          teacherId: input.teacherId,
          studentId: input.studentId,
          programId: input.programId,
          sessionId: input.sessionId,
          startTime: start,
          endTime: end,
          timezone: input.timezone || 'Asia/Kolkata',
          status: 'SCHEDULED',
        },
      })
    );

    logger.info(`[ZoomMeetingsService] Created Zoom meeting ${meetingIdStr} (DB ID: ${meeting.id})`);

    return {
      id: meeting.id,
      zoomMeetingId: meetingIdStr,
      meetLink: joinUrl,
      joinUrl,
      startUrl,
      passcode,
      calendarLink: joinUrl,
      startTime: meeting.startTime.toISOString(),
      endTime: meeting.endTime.toISOString(),
      reused: false,
    };
  }

  /**
   * Lists scheduled meetings from DB with optional filters.
   */
  static async list(filter?: {
    teacherId?: string;
    studentId?: string;
    programId?: string;
    status?: string;
    provider?: string;
  }) {
    return withDbRetry(() =>
      db.meeting.findMany({
        where: {
          ...(filter?.teacherId ? { teacherId: filter.teacherId } : {}),
          ...(filter?.studentId ? { studentId: filter.studentId } : {}),
          ...(filter?.programId ? { programId: filter.programId } : {}),
          ...(filter?.status ? { status: filter.status } : {}),
          ...(filter?.provider ? { provider: filter.provider } : {}),
        },
        include: {
          recordings: true,
        },
        orderBy: { startTime: 'asc' },
      })
    );
  }

  /**
   * Retrieves single meeting by database ID.
   */
  static async get(id: string) {
    const meeting = await withDbRetry(() =>
      db.meeting.findUnique({
        where: { id },
        include: { recordings: true },
      })
    );
    if (!meeting) throw new Error(`Meeting with ID ${id} not found.`);
    return meeting;
  }

  /**
   * Updates Zoom meeting topic/time in Zoom API and DB.
   */
  static async update(id: string, input: UpdateZoomMeetingInput) {
    const meeting = await this.get(id);

    if (meeting.zoomMeetingId) {
      try {
        const accessToken = await ZoomAuthService.getAccessToken(meeting.organizerEmail);
        const updatePayload: any = {};
        if (input.title) updatePayload.topic = input.title;
        if (input.description) updatePayload.agenda = input.description;
        if (input.startTime) {
          updatePayload.start_time = input.startTime;
          if (input.endTime) {
            const start = new Date(input.startTime);
            const end = new Date(input.endTime);
            updatePayload.duration = Math.max(15, Math.round((end.getTime() - start.getTime()) / 60000));
          }
        }
        if (input.timezone) updatePayload.timezone = input.timezone;

        await fetch(`https://api.zoom.us/v2/meetings/${meeting.zoomMeetingId}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updatePayload),
        });
      } catch (err: any) {
        logger.warn(`[ZoomMeetingsService] Failed to update Zoom API meeting: ${err.message}`);
      }
    }

    return withDbRetry(() =>
      db.meeting.update({
        where: { id },
        data: {
          ...(input.title ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.startTime ? { startTime: new Date(input.startTime) } : {}),
          ...(input.endTime ? { endTime: new Date(input.endTime) } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
      })
    );
  }

  /**
   * Reschedules Zoom meeting by its join link.
   */
  static async rescheduleByLink(zoomUrl: string, newStartTime: string, newEndTime: string) {
    const meeting = await withDbRetry(() =>
      db.meeting.findFirst({
        where: {
          OR: [
            { meetUrl: zoomUrl },
            { zoomJoinUrl: zoomUrl },
          ],
          status: { not: 'CANCELLED' },
        },
      })
    );

    if (!meeting) {
      throw new Error(`Active Zoom meeting for link ${zoomUrl} was not found.`);
    }

    return this.update(meeting.id, {
      startTime: newStartTime,
      endTime: newEndTime,
    });
  }

  /**
   * Deletes / cancels meeting by ID.
   */
  static async delete(id: string) {
    const meeting = await this.get(id);

    if (meeting.zoomMeetingId) {
      try {
        const accessToken = await ZoomAuthService.getAccessToken(meeting.organizerEmail);
        await fetch(`https://api.zoom.us/v2/meetings/${meeting.zoomMeetingId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
      } catch (err: any) {
        logger.warn(`[ZoomMeetingsService] Failed to delete Zoom meeting in API: ${err.message}`);
      }
    }

    return withDbRetry(() =>
      db.meeting.update({
        where: { id },
        data: { status: 'CANCELLED' },
      })
    );
  }

  /**
   * Deletes / cancels meeting by join link.
   */
  static async deleteByLink(zoomUrl: string) {
    const meeting = await withDbRetry(() =>
      db.meeting.findFirst({
        where: {
          OR: [
            { meetUrl: zoomUrl },
            { zoomJoinUrl: zoomUrl },
          ],
          status: { not: 'CANCELLED' },
        },
      })
    );

    if (!meeting) {
      logger.warn(`[ZoomMeetingsService] No active meeting found for link: ${zoomUrl}`);
      return { success: true, message: 'No active meeting found to cancel' };
    }

    return this.delete(meeting.id);
  }
}
