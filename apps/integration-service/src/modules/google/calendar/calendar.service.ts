import { google } from 'googleapis';
import { GoogleAuthService } from '../auth/auth.service';
import crypto from 'crypto';

export interface CalendarEventInput {
  title: string;
  description?: string;
  startTime: string; // ISO string
  endTime: string; // ISO string
  timezone: string;
  attendees: string[]; // array of emails
}

export class GoogleCalendarService {
  static async createMeetEvent(workspaceEmail: string, input: CalendarEventInput) {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const calendar = google.calendar({ version: 'v3', auth });

    const event = {
      summary: input.title,
      description: input.description || '',
      start: {
        dateTime: input.startTime,
        timeZone: input.timezone,
      },
      end: {
        dateTime: input.endTime,
        timeZone: input.timezone,
      },
      attendees: input.attendees.map(email => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: {
            type: 'hangoutsMeet',
          },
        },
      },
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
      conferenceDataVersion: 1,
    });

    const createdEvent = response.data;
    const meetLink = createdEvent.conferenceData?.entryPoints?.find(
      ep => ep.entryPointType === 'video'
    )?.uri || '';

    return {
      eventId: createdEvent.id || '',
      meetLink,
      calendarLink: createdEvent.htmlLink || '',
      conferenceId: createdEvent.conferenceData?.conferenceId || '',
      organizer: createdEvent.organizer?.email || workspaceEmail,
      attendees: createdEvent.attendees?.map(a => a.email).filter(Boolean) as string[] || [],
    };
  }

  static async updateMeetEvent(workspaceEmail: string, eventId: string, input: Partial<CalendarEventInput>) {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const calendar = google.calendar({ version: 'v3', auth });

    // Fetch existing event first to keep untouched fields
    const getResponse = await calendar.events.get({
      calendarId: 'primary',
      eventId,
    });
    const currentEvent = getResponse.data;

    const updatedRequestBody = {
      ...currentEvent,
      ...(input.title ? { summary: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.startTime || input.timezone
        ? {
            start: {
              dateTime: input.startTime || currentEvent.start?.dateTime || undefined,
              timeZone: input.timezone || currentEvent.start?.timeZone || undefined,
            },
          }
        : {}),
      ...(input.endTime || input.timezone
        ? {
            end: {
              dateTime: input.endTime || currentEvent.end?.dateTime || undefined,
              timeZone: input.timezone || currentEvent.end?.timeZone || undefined,
            },
          }
        : {}),
      ...(input.attendees
        ? { attendees: input.attendees.map(email => ({ email })) }
        : {}),
    };

    const response = await calendar.events.update({
      calendarId: 'primary',
      eventId,
      requestBody: updatedRequestBody,
    });

    const updatedEvent = response.data;
    const meetLink = updatedEvent.conferenceData?.entryPoints?.find(
      ep => ep.entryPointType === 'video'
    )?.uri || '';

    return {
      eventId: updatedEvent.id || '',
      meetLink,
      calendarLink: updatedEvent.htmlLink || '',
      attendees: updatedEvent.attendees?.map(a => a.email).filter(Boolean) as string[] || [],
    };
  }

  static async deleteMeetEvent(workspaceEmail: string, eventId: string) {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const calendar = google.calendar({ version: 'v3', auth });

    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
    });

    return { eventId, status: 'CANCELLED' };
  }
}
