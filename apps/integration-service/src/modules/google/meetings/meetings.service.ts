import { db, withDbRetry } from '../../../database/datasource';
import { GoogleCalendarService, CalendarEventPatch } from '../calendar/calendar.service';
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
  /** Escape hatch: mint a brand-new room even when the pair already has one. */
  forceNewRoom?: boolean;
}

/**
 * Share one Meet room across every session of a mentor/student/programme.
 *
 * On by default because a room per session is what exhausts the Calendar budget,
 * and a 1-to-1 pair has no use for forty different rooms.
 */
const REUSE_ROOM_PER_PROGRAM = process.env.GOOGLE_MEET_REUSE_PER_PROGRAM !== 'false';

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

    // Everything from here to the row insert runs under one advisory lock. The key
    // is the mentor/student/programme triple rather than the individual slot, so a
    // whole programme booking — which arrives as a loop of one request per session
    // — serialises end to end. Without that, sessions 1 and 2 race and both mint a
    // room before either has written one for the other to find.
    //
    // The lock is transaction-scoped: it releases on commit or rollback, so a crash
    // mid-booking cannot leave the pair wedged.
    return db.$transaction(
      async (tx) => {
        const lockKey = `meeting:${input.teacherId}:${input.studentId}:${input.programId}`;
        // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, and
        // $queryRaw tries to deserialize every returned column — it cannot map a
        // void one and throws. We want the lock, not the result.
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', lockKey);

        // Retrying the exact same booking? Reuse the room instead of failing.
        //
        // The scheduler creates the Google meeting first and saves the class second.
        // If that second step fails, the room is left orphaned — and a naive conflict
        // check then blocks the retry forever using the debris of the first attempt.
        // Same teacher + same student + same instant is the same booking, not a clash.
        const sameBooking = await tx.meeting.findFirst({
          where: {
            // Provider matters: the same pair can hold a Google room and a Zoom
            // room for the same slot, and without this the Google path would hand
            // back a Zoom join URL (or the reverse) as though it had created it.
            provider: 'GOOGLE_MEET',
            startTime: start,
            status: { not: 'CANCELLED' },
            teacherId: input.teacherId,
            studentId: input.studentId,
          },
          orderBy: { createdAt: 'desc' },
        });
        if (sameBooking) {
          // The database is the answer here, not Google. Our own cancel path marks
          // the row CANCELLED and the query above already excludes those, so a row
          // that survives it describes a room we believe is live.
          //
          // This used to spend a Calendar GET confirming that with Google on every
          // single retry. The one thing that bought us — noticing an event someone
          // deleted by hand in Google's own UI — is rare, costs a request every
          // time whether or not it happened, and does not stop the Meet room
          // working. `GoogleCalendarService.isEventActive` is still there for a
          // deliberate check; it is just no longer on the hot path.
          logger.info(
            `[GoogleMeetingsService] Reusing existing room ${sameBooking.meetUrl} for the same teacher/student/slot ` +
            `(meeting ${sameBooking.id}) — resolved from the database, no Google call.`
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

        // One room for the whole programme — the single biggest saving available.
        //
        // Booking a 12-session programme used to mint 12 calendar events and 12
        // Meet rooms, 12 writes against a budget that also counts every earlier
        // attempt and every cancellation. That churn is what trips Google's
        // anti-abuse throttle, and no amount of per-request tuning avoids it.
        //
        // A 1-to-1 pair meets in the same room every week, so a fresh room per
        // session buys nothing. Recordings still separate correctly: Drive matches
        // on the Meet code AND the session's time window, not the code alone.
        //
        // Set GOOGLE_MEET_REUSE_PER_PROGRAM=false to go back to a room per session.
        if (REUSE_ROOM_PER_PROGRAM && input.programId && !input.forceNewRoom) {
          const programRoom = await tx.meeting.findFirst({
            where: {
              // Provider-scoped for the same reason as the slot lookup above:
              // reusing "the programme's room" must never cross vendors.
              provider: 'GOOGLE_MEET',
              status: { not: 'CANCELLED' },
              teacherId: input.teacherId,
              studentId: input.studentId,
              programId: input.programId,
              meetUrl: { not: '' },
            },
            orderBy: { createdAt: 'asc' },
          });
          if (programRoom) {
            logger.info(
              `[GoogleMeetingsService] Reusing programme room ${programRoom.meetUrl} for mentor ${input.teacherId} ` +
              `/ student ${input.studentId} / programme ${input.programId} (session ${input.sessionId}) — ` +
              `no Calendar request.`
            );
            return {
              id: programRoom.id,
              calendarEventId: programRoom.calendarEventId,
              meetLink: programRoom.meetUrl,
              calendarLink: programRoom.meetUrl,
              startTime: programRoom.startTime.toISOString(),
              endTime: programRoom.endTime.toISOString(),
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
        const conflict = await tx.meeting.findFirst({
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

        // 2. One Calendar request: the event and its Meet room together. The
        // room comes back inline on this response — there is no follow-up read.
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
            sessionId: input.sessionId,
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

        // 3. Store metadata in local database. Everything Google told us lands
        // here in one write, so no later request has to ask Google for it again.
        const meeting = await tx.meeting.create({
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
      },
      {
        // The Google create happens inside the lock, so the transaction has to
        // outlast a throttled call plus its backoff. Prisma's 5s default would
        // abort a booking that was about to succeed.
        timeout: Number(process.env.MEETING_CREATE_TIMEOUT_MS ?? 120_000),
        maxWait: Number(process.env.MEETING_CREATE_MAX_WAIT_MS ?? 60_000),
      }
    );
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

    // Work out what Google actually needs to hear about.
    //
    // This used to fire a Calendar update on every call, so flipping our own
    // `status` to COMPLETED — a purely internal field Google has never heard of
    // — cost a request, as did re-submitting a title that already matched.
    // Diffing against the stored row first means the common case costs nothing.
    const googlePatch: CalendarEventPatch = {};
    if (input.title !== undefined && input.title !== meeting.title) {
      googlePatch.title = input.title;
    }
    if (input.description !== undefined && (input.description || null) !== meeting.description) {
      googlePatch.description = input.description ?? '';
    }
    if (input.startTime !== undefined && new Date(input.startTime).getTime() !== meeting.startTime.getTime()) {
      googlePatch.startTime = input.startTime;
    }
    if (input.endTime !== undefined && new Date(input.endTime).getTime() !== meeting.endTime.getTime()) {
      googlePatch.endTime = input.endTime;
    }
    if (input.attendees !== undefined) {
      googlePatch.attendees = input.attendees;
    }
    // A timezone change is real, but Google only accepts one attached to a time,
    // so carry the existing instants along with it.
    if (input.timezone !== undefined && input.timezone !== meeting.timezone) {
      googlePatch.timezone = input.timezone;
      googlePatch.startTime = googlePatch.startTime ?? meeting.startTime.toISOString();
      googlePatch.endTime = googlePatch.endTime ?? meeting.endTime.toISOString();
    } else if (googlePatch.startTime || googlePatch.endTime) {
      googlePatch.timezone = input.timezone || meeting.timezone;
    }

    // Rooms synced from a manually pasted link have no event of ours to patch.
    const isRealEvent = Boolean(meeting.calendarEventId) && !meeting.calendarEventId!.startsWith('manual_');
    const hasGoogleChange = Object.keys(googlePatch).length > 0;

    if (hasGoogleChange && isRealEvent) {
      logger.info(
        `Patching Google Calendar Event ${meeting.calendarEventId} for Workspace: ${meeting.organizerEmail} ` +
        `(fields: ${Object.keys(googlePatch).join(', ')})`
      );
      await GoogleCalendarService.patchMeetEvent(
        meeting.organizerEmail,
        meeting.calendarEventId!,
        googlePatch,
        meeting.sessionId
      );
    } else {
      logger.info(
        `[GoogleMeetingsService] Meeting ${id} updated locally with no Calendar request — ` +
        `${!isRealEvent ? 'no real Calendar event' : 'nothing Google-facing changed'}.`
      );
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

    // Cancelling something already cancelled is a no-op, not a Google request.
    // Schedulers retry deletes and the UI double-fires them, and each repeat used
    // to spend a Calendar call to be told the event was already gone — the exact
    // create/delete churn that trips the anti-abuse throttle in the first place.
    const alreadyCancelled = meeting.status === 'CANCELLED';
    const isRealEvent = Boolean(meeting.calendarEventId) && !meeting.calendarEventId!.startsWith('manual_');

    if (alreadyCancelled || !isRealEvent) {
      logger.info(
        `[GoogleMeetingsService] Skipping Calendar delete for meeting ${id} — ` +
        `${alreadyCancelled ? 'already cancelled' : 'no real Calendar event'}.`
      );
    } else {
      logger.info(`Deleting Google Calendar Event ${meeting.calendarEventId} for Workspace: ${meeting.organizerEmail}`);
      try {
        await GoogleCalendarService.deleteMeetEvent(
          meeting.organizerEmail,
          meeting.calendarEventId!,
          meeting.sessionId
        );
      } catch (err: any) {
        // Soft handling: if it was already deleted on Calendar, log it and proceed
        logger.warn(`Google Calendar event deletion failed (might have been removed directly on Google): ${err.message}`);
      }
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
