import { google } from 'googleapis';
import { GoogleAuthService } from '../auth/auth.service';
import { logger } from '@futurespark/logger';
import { Readable } from 'stream';

export class GoogleDriveService {
  static async searchMeetFiles(workspaceEmail: string, searchName?: string, meetCode?: string) {
    try {
      const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
      const drive = google.drive({ version: 'v3', auth });

      // Look for all video files (mp4, webm, etc.)
      let q = "mimeType contains 'video/' and trashed = false";
      if (searchName || meetCode) {
        const conditions: string[] = [];
        if (searchName) {
          let cleanSearch = searchName;
          if (searchName.includes('Class - ')) {
            cleanSearch = searchName.split('Class - ')[1].trim();
          } else if (searchName.includes('Session - ')) {
            cleanSearch = searchName.split('Session - ')[1].trim();
          }
          const escapedName = cleanSearch.replace(/'/g, "\\'");
          conditions.push(`name contains '${escapedName}'`);
        }
        if (meetCode) {
          const escapedCode = meetCode.replace(/'/g, "\\'");
          conditions.push(`name contains '${escapedCode}'`);
          const noHyphenCode = meetCode.replace(/-/g, '').replace(/'/g, "\\'");
          if (noHyphenCode !== escapedCode) {
            conditions.push(`name contains '${noHyphenCode}'`);
          }
        }
        q += ` and (${conditions.join(' or ')})`;
      }

      let response = await drive.files.list({
        q,
        fields: 'files(id, name, size, mimeType, createdTime, webContentLink)',
        orderBy: 'createdTime desc',
        pageSize: 50,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      let files = (response.data.files ?? []).map(file => ({
        id: file.id || '',
        name: file.name || '',
        mimeType: file.mimeType || '',
        size: file.size ? parseInt(file.size, 10) : 0,
        createdTime: file.createdTime || '',
        webContentLink: file.webContentLink || '',
      }));

      // Fallback: If 0 files found with specific search criteria, query all recent video files on Drive
      if (files.length === 0 && (searchName || meetCode)) {
        logger.info(`[GoogleDriveService] 0 files matched specific query. Broadening query to all recent video files...`);
        const broadResponse = await drive.files.list({
          q: "mimeType contains 'video/' and trashed = false",
          fields: 'files(id, name, size, mimeType, createdTime, webContentLink)',
          orderBy: 'createdTime desc',
          pageSize: 50,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        files = (broadResponse.data.files ?? []).map(file => ({
          id: file.id || '',
          name: file.name || '',
          mimeType: file.mimeType || '',
          size: file.size ? parseInt(file.size, 10) : 0,
          createdTime: file.createdTime || '',
          webContentLink: file.webContentLink || '',
        }));
      }

      return files;
    } catch (err: any) {
      logger.error(`[GoogleDriveService] Error searching Google Drive for ${workspaceEmail}: ${err.message}`);
      return [];
    }
  }

  static async downloadFileStream(workspaceEmail: string, fileId: string) {
    try {
      const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
      const drive = google.drive({ version: 'v3', auth });

      const response = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      return response.data; // Readable Stream
    } catch (err: any) {
      if (process.env.NODE_ENV === 'development') {
        logger.info(`[GoogleDriveService] Dev fallback: Returning mock readable stream for file ID ${fileId}`);
        const mockStream = new Readable();
        mockStream.push('Mock audio/video file content');
        mockStream.push(null);
        return mockStream;
      }
      throw err;
    }
  }

  static async exportGoogleDocStream(workspaceEmail: string, fileId: string, mimeType: string = 'text/plain') {
    try {
      const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
      const drive = google.drive({ version: 'v3', auth });

      const response = await drive.files.export(
        { fileId, mimeType },
        { responseType: 'stream' }
      );

      return response.data; // Readable Stream
    } catch (err: any) {
      logger.error(`[GoogleDriveService] Failed to export Google Doc transcript for file ID ${fileId}: ${err.message}`);
      throw err;
    }
  }
}
