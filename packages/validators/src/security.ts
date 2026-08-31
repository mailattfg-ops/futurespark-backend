/**
 * Security Input Validation & Sanitization Helpers
 */

/**
 * Sanitizes user input string against XSS script injection & dangerous script tags.
 */
export function sanitizeString(input: string): string {
  if (typeof input !== 'string') return input;

  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/on\w+\s*=/gi, '');
}

/**
 * Sanitizes file names to prevent Path Traversal attacks (e.g. ../../etc/passwd or null bytes).
 */
export function sanitizeFileName(fileName: string): string {
  if (!fileName || typeof fileName !== 'string') return 'unnamed_file';

  // Remove path components, null bytes, and parent folder traversal
  return fileName
    .replace(/\0/g, '')
    .replace(/^.*[\\\/]/, '')
    .replace(/\.\.+/g, '.')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Validates whether a file extension is in an allowed list of safe business file types.
 */
export function isAllowedFileType(fileName: string, allowedExtensions: string[] = ['jpg', 'jpeg', 'png', 'webp', 'pdf', 'mp3', 'mp4', 'doc', 'docx', 'xlsx']): boolean {
  if (!fileName || typeof fileName !== 'string') return false;
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return allowedExtensions.includes(ext);
}
