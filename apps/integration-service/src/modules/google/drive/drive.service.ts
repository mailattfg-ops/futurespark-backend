import { google } from 'googleapis';
import { GoogleAuthService } from '../auth/auth.service';

export class GoogleDriveService {
  static async searchMeetRecordings(workspaceEmail: string, searchName?: string) {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const drive = google.drive({ version: 'v3', auth });

    // Look for mp4 video files
    let q = "mimeType = 'video/mp4' and trashed = false";
    if (searchName) {
      // Escape single quotes in searchName
      const escapedName = searchName.replace(/'/g, "\\'");
      q += ` and name contains '${escapedName}'`;
    }

    const response = await drive.files.list({
      q,
      fields: 'files(id, name, size, createdTime, webContentLink)',
      orderBy: 'createdTime desc',
      pageSize: 50,
    });

    return (response.data.files ?? []).map(file => ({
      id: file.id || '',
      name: file.name || '',
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
}
