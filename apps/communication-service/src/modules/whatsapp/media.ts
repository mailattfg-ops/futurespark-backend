import fs from 'fs';
import path from 'path';
import { logger } from '@futurespark/logger';
import { whatsappConfig } from './whatsapp.service';

/**
 * Inbound WhatsApp media — voice notes, images, documents.
 *
 * Meta never sends the file. It sends a media id, which has to be exchanged
 * for a download URL that is valid for about five minutes and only works with
 * the app's access token. So the file must be pulled down while the webhook is
 * being handled; there is no fetching it later when an admin opens the thread.
 *
 * Files land on the server's own disk rather than object storage: voice notes
 * are small, and losing them on an instance replacement is acceptable here.
 * `sweepOldMedia` keeps the folder from growing without bound.
 */

/** Where downloaded media lives. Relative paths resolve against the repo root. */
export const mediaDir = (): string => {
  const configured = process.env.WHATSAPP_MEDIA_DIR?.trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), 'data', 'whatsapp-media');
};

/** Files older than this are deleted by the sweep. */
const retentionDays = (): number => {
  const raw = Number(process.env.WHATSAPP_MEDIA_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
};

/** Refuse anything larger — Meta caps audio at 16MB, documents at 100MB. */
const MAX_BYTES = 25 * 1024 * 1024;

/** The message types that carry a media id. */
export const MEDIA_TYPES = ['audio', 'voice', 'image', 'video', 'document', 'sticker'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const isMediaType = (type: string): type is MediaType =>
  (MEDIA_TYPES as readonly string[]).includes(type);

/**
 * File extension for a MIME type. Deliberately small: what WhatsApp actually
 * sends. The extension matters because the <audio> player and the browser pick
 * their decoder from the response's content type, which we derive from it.
 */
const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
};

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
export const baseMime = (mime: string): string => (mime || '').split(';')[0].trim().toLowerCase();

export const extensionFor = (mime: string): string => EXTENSIONS[baseMime(mime)] || 'bin';

/** The reverse, for serving a stored file back with the right content type. */
export const mimeForFile = (file: string): string => {
  const ext = path.extname(file).replace('.', '').toLowerCase();
  const hit = Object.entries(EXTENSIONS).find(([, e]) => e === ext);
  return hit ? hit[0] : 'application/octet-stream';
};

/**
 * A stored file name is `<mediaId>.<ext>` and nothing else — no separators, no
 * dots beyond the extension. Serving routes take the name straight from the
 * database, but validating here means a poisoned row still cannot walk out of
 * the media folder.
 */
export const isSafeMediaFile = (file: string): boolean => /^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,5}$/.test(file);

export const mediaFilePath = (file: string): string | null =>
  isSafeMediaFile(file) ? path.join(mediaDir(), file) : null;

export interface DownloadedMedia {
  /** File name on disk, stored on the message row. */
  file: string;
  mime: string;
  bytes: number;
}

/**
 * Fetch one media id from Meta and store it. Returns null on any failure —
 * a voice note that could not be downloaded must not cost us the message row
 * itself, which is what opens the 24-hour reply window.
 */
export const downloadInboundMedia = async (mediaId: string): Promise<DownloadedMedia | null> => {
  const token = whatsappConfig.accessToken;
  if (!token) {
    logger.warn('[WhatsApp Media] No access token configured; cannot download media.');
    return null;
  }

  try {
    const metaRes = await fetch(`https://graph.facebook.com/${whatsappConfig.apiVersion}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!metaRes.ok) {
      logger.warn(`[WhatsApp Media] Lookup for ${mediaId} returned ${metaRes.status}.`);
      return null;
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number };
    if (!meta.url) {
      logger.warn(`[WhatsApp Media] Lookup for ${mediaId} carried no download url.`);
      return null;
    }
    if (typeof meta.file_size === 'number' && meta.file_size > MAX_BYTES) {
      logger.warn(`[WhatsApp Media] ${mediaId} is ${meta.file_size} bytes — above the ${MAX_BYTES} cap; skipped.`);
      return null;
    }

    // The CDN url also needs the token: it is not a public link.
    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!fileRes.ok) {
      logger.warn(`[WhatsApp Media] Download of ${mediaId} returned ${fileRes.status}.`);
      return null;
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) {
      logger.warn(`[WhatsApp Media] ${mediaId} downloaded ${buffer.byteLength} bytes — above the cap; discarded.`);
      return null;
    }

    const mime = meta.mime_type || fileRes.headers.get('content-type') || 'application/octet-stream';
    const file = `${mediaId.replace(/[^A-Za-z0-9_-]/g, '')}.${extensionFor(mime)}`;
    const dir = mediaDir();
    await fs.promises.mkdir(dir, { recursive: true });
    // Temp-then-rename: a half-written file must never be served.
    const tmp = path.join(dir, `.${file}.part`);
    await fs.promises.writeFile(tmp, buffer);
    await fs.promises.rename(tmp, path.join(dir, file));

    logger.info(`[WhatsApp Media] Stored ${file} (${buffer.byteLength} bytes, ${mime}).`);
    return { file, mime: baseMime(mime), bytes: buffer.byteLength };
  } catch (err: any) {
    logger.warn(`[WhatsApp Media] Could not fetch ${mediaId}: ${err.message}`);
    return null;
  }
};

/** Delete media older than the retention window. Safe to call on a timer. */
export const sweepOldMedia = async (): Promise<number> => {
  const dir = mediaDir();
  const cutoff = Date.now() - retentionDays() * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    const files = await fs.promises.readdir(dir);
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(full);
          removed++;
        }
      } catch {
        /* a file that vanished mid-sweep is not an error */
      }
    }
    if (removed) logger.info(`[WhatsApp Media] Swept ${removed} file(s) older than ${retentionDays()} days.`);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') logger.warn(`[WhatsApp Media] Sweep failed: ${err.message}`);
  }
  return removed;
};
