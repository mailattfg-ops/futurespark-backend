import fs from 'fs';
import { Router, Request, Response } from 'express';
import { HTTP_STATUS } from '@futurespark/constants';
import { successResponse, errorResponse } from '@futurespark/response';
import { logger } from '@futurespark/logger';
import { listMessages, listThreads, replyToThread } from './conversations.service';
import { mediaFilePath, mimeForFile } from './media';

/**
 * /whatsapp/conversations — the admin inbox.
 *
 * Reachable only through the gateway, which authenticates and restricts these
 * to staff: a thread carries a family's phone number and everything they wrote.
 */
const router = Router();

const asInt = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

router.get('/', async (req: Request, res: Response) => {
  try {
    const withMessages = String(req.query.withMessages ?? '') === '1' || req.query.withMessages === 'true';
    const threads = await listThreads(asInt(req.query.limit, 200), withMessages);
    return res.status(HTTP_STATUS.OK).json(successResponse(threads, 'Conversations loaded.'));
  } catch (err: any) {
    logger.error(`[WhatsApp Inbox] Failed to list conversations: ${err.message}`);
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse('Failed to load conversations.'));
  }
});

router.get('/:phone/messages', async (req: Request, res: Response) => {
  try {
    const messages = await listMessages(req.params.phone, asInt(req.query.limit, 200));
    return res.status(HTTP_STATUS.OK).json(successResponse(messages, 'Messages loaded.'));
  } catch (err: any) {
    logger.error(`[WhatsApp Inbox] Failed to load messages: ${err.message}`);
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse('Failed to load messages.'));
  }
});

router.post('/:phone/reply', async (req: Request, res: Response) => {
  try {
    const result = await replyToThread(req.params.phone, req.body?.text ?? req.body?.message ?? '');
    if (!result.sent) {
      // A closed window or a disabled audience is an operator problem, not a
      // server fault: 409 so the UI can show the reason beside the composer.
      const status = result.reason === 'SEND_FAILED' ? HTTP_STATUS.BAD_GATEWAY : HTTP_STATUS.CONFLICT;
      return res.status(status).json(errorResponse(result.message));
    }
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Reply sent.'));
  } catch (err: any) {
    logger.error(`[WhatsApp Inbox] Reply failed: ${err.message}`);
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse('Failed to send the reply.'));
  }
});

/**
 * Stream a stored voice note or attachment.
 *
 * Served from disk through this service rather than as a public file: the
 * folder holds families' voice messages, so it stays behind the gateway's
 * authentication. Range requests are honoured so the player can seek.
 */
export const mediaRouter = Router();

mediaRouter.get('/:file', async (req: Request, res: Response) => {
  const full = mediaFilePath(req.params.file);
  if (!full) return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Bad media reference.'));

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(full);
  } catch {
    return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('That attachment is no longer stored.'));
  }

  const mime = mimeForFile(req.params.file);
  const range = req.headers.range;
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    return fs.createReadStream(full, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', String(stat.size));
  return fs.createReadStream(full).pipe(res);
});

export { router as whatsappConversationRoutes };
