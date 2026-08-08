import { google } from 'googleapis';
import { GoogleAuthService } from '../auth/auth.service';
import { logger } from '@futurespark/logger';
import { Readable } from 'stream';

export class GoogleDriveService {
  static async searchMeetFiles(workspaceEmail: string, searchName?: string, meetCode?: string, targetDate?: Date) {
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

      if (targetDate && !isNaN(new Date(targetDate).getTime())) {
        const t = new Date(targetDate).getTime();
        // A recording is written after its call, never before. The old ±24h window
        // let every same-day session match, so a 09:42 recording could attach to a
        // 12:10 class. Bound it to "shortly before the start" (clock skew only)
        // through "a few hours after", which is ample for Drive to finish rendering.
        const minTime = new Date(t - 15 * 60 * 1000).toISOString();
        const maxTime = new Date(t + 8 * 60 * 60 * 1000).toISOString();
        q += ` and createdTime >= '${minTime}' and createdTime <= '${maxTime}'`;
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

      return files;
    } catch (err: any) {
      logger.error(`[GoogleDriveService] Error searching Google Drive for ${workspaceEmail}: ${err.message}`);
      return [];
    }
  }

  /**
   * Flattens a response's headers to a plain lowercase-keyed object.
   *
   * Depending on the gaxios version underneath googleapis, `response.headers` is
   * either a plain object or a fetch-style `Headers` instance. Indexing a
   * `Headers` returns undefined without erroring, which silently dropped
   * `content-range` and left the video unseekable even though Drive had sent it.
   */
  private static flattenHeaders(raw: any): Record<string, string> {
    if (!raw) return {};
    if (typeof raw.get === 'function' && typeof raw.forEach === 'function') {
      const out: Record<string, string> = {};
      raw.forEach((value: string, key: string) => {
        out[key.toLowerCase()] = value;
      });
      return out;
    }
    return Object.fromEntries(
      Object.entries(raw as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
  }

  /**
   * Streams a Drive file, passing the browser's Range header straight through.
   *
   * Without this a reviewer can only watch a 90-minute class linearly: a plain
   * `alt=media` request returns the whole file with no `Content-Range`, so the
   * <video> element has nothing to seek against and the scrub bar does nothing.
   * Drive honours Range on `alt=media`, so forwarding it — and echoing back what
   * Drive answers with — makes seeking work without ever writing the file to disk.
   *
   * Returns the raw response so the caller can mirror Drive's status and headers.
   */
  static async streamFileRange(workspaceEmail: string, fileId: string, range?: string) {
    const auth = await GoogleAuthService.getClientForEmail(workspaceEmail);
    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.get(
      { fileId, alt: 'media' },
      {
        responseType: 'stream',
        ...(range ? { headers: { Range: range } } : {}),
        // A 206 is the expected answer to a Range request, not an error.
        validateStatus: (status: number) => status >= 200 && status < 400,
      } as any
    );

    return {
      stream: response.data as NodeJS.ReadableStream,
      status: response.status,
      headers: this.flattenHeaders(response.headers),
    };
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
