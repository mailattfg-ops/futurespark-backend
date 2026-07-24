import { google } from 'googleapis';
import { GoogleAuthService } from '../auth/auth.service';

export class GoogleDriveService {
  static async searchMeetFiles(workspaceEmail: string, searchName?: string) {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const drive = google.drive({ version: 'v3', auth });

    // Look for mp4 video files OR Google Doc transcript files
    let q = "(mimeType = 'video/mp4' or (mimeType = 'application/vnd.google-apps.document' and name contains 'Transcript') or name contains 'Transcript') and trashed = false";
    if (searchName) {
      // Escape single quotes in searchName
      const escapedName = searchName.replace(/'/g, "\\'");
      q += ` and name contains '${escapedName}'`;
    }

    const response = await drive.files.list({
      q,
      fields: 'files(id, name, size, mimeType, createdTime, webContentLink)',
      orderBy: 'createdTime desc',
      pageSize: 50,
    });

    return (response.data.files ?? []).map(file => ({
      id: file.id || '',
      name: file.name || '',
      mimeType: file.mimeType || '',
      size: file.size ? parseInt(file.size, 10) : 0,
      createdTime: file.createdTime || '',
      webContentLink: file.webContentLink || '',
    }));
  }

  static async downloadFileStream(workspaceEmail: string, fileId: string) {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    return response.data; // Readable Stream
  }

  static async exportGoogleDocStream(workspaceEmail: string, fileId: string, mimeType: string = 'text/plain') {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.export(
      { fileId, mimeType },
      { responseType: 'stream' }
    );

    return response.data; // Readable Stream
  }
}
