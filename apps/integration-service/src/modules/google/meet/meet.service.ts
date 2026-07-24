import { google } from 'googleapis';
import { GoogleAuthService } from '../auth/auth.service';

export class GoogleMeetService {
  static async getMeetingDetails(workspaceEmail: string, eventId: string) {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const calendar = google.calendar({ version: 'v3', auth });

    const response = await calendar.events.get({
      calendarId: 'primary',
      eventId,
    });

    const event = response.data;
    const meetLink = event.conferenceData?.entryPoints?.find(
      ep => ep.entryPointType === 'video'
    )?.uri || '';

    return {
      title: event.summary || '',
      organizer: event.organizer?.email || '',
      participants: event.attendees?.map(a => a.email).filter(Boolean) as string[] || [],
      meetUrl: meetLink,
      startTime: event.start?.dateTime || event.start?.date || '',
      endTime: event.end?.dateTime || event.end?.date || '',
      status: event.status || 'confirmed',
      calendarEventId: event.id || '',
    };
  }
}
