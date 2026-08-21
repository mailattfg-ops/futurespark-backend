import { Router, type Request, type Response } from 'express';
import { successResponse } from '@futurespark/response';
import { asyncHandler } from '@futurespark/middleware';
import { logger } from '@futurespark/logger';
import { HTTP_STATUS } from '@futurespark/constants';

/**
 * GET /api/tech-feed — one time-ordered stream of everything the platform did.
 *
 * Sessions, leads, reports, summaries, WhatsApp, notifications, video and
 * audio live in three different databases owned by three different services,
 * so "what happened this afternoon" could previously only be answered by
 * opening three pages and comparing timestamps by eye. This merges them.
 *
 * ADMIN-only: the stream names children and carries parent phone numbers.
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:3001';
const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://127.0.0.1:3003';
const INTEGRATION_SERVICE_URL = process.env.INTEGRATION_SERVICE_URL || 'http://127.0.0.1:3006';

const FETCH_TIMEOUT_MS = 20_000;

interface FeedEvent {
  type: string;
  at: string;
  title: string;
  subtitle?: string | null;
  status?: string;
  detail?: string | null;
  /** Which service produced it — shown as the source chip. */
  source?: string;
}

const fetchFeed = async (url: string, headers: Record<string, string>, source: string): Promise<FeedEvent[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`${source} answered ${res.status}`);
    const body = (await res.json()) as any;
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows.map((r: FeedEvent) => ({ ...r, source }));
  } catch (err: any) {
    // One service being down must not empty the whole feed — the events from
    // the other two are still true.
    logger.warn(`[TechFeed] ${source} feed unavailable: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
};

export const techFeedRouter = Router();

techFeedRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    if (String(req.headers['x-user-role'] ?? '').toUpperCase() !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Only an admin can read the technical feed.' });
    }

    const headers = {
      'x-user-role': 'ADMIN',
      'x-user-id': String(req.headers['x-user-id'] ?? ''),
    };

    // `since` is passed straight through; each service applies it to the field
    // that means "when this happened" for its own event types.
    const since = typeof req.query.since === 'string' ? req.query.since : '';
    const perType = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200);
    const qs = `?limit=${perType}${since ? `&since=${encodeURIComponent(since)}` : ''}`;

    const [auth, comm, integration] = await Promise.all([
      fetchFeed(`${AUTH_SERVICE_URL}/metrics/feed${qs}`, headers, 'auth'),
      fetchFeed(`${COMMUNICATION_SERVICE_URL}/metrics/feed${qs}`, headers, 'communication'),
      fetchFeed(`${INTEGRATION_SERVICE_URL}/metrics/feed${qs}`, headers, 'integration'),
    ]);

    const events = [...auth, ...comm, ...integration]
      .filter((e) => e && typeof e.at === 'string' && !Number.isNaN(new Date(e.at).getTime()))
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // A per-type tally for the filter chips, counted BEFORE the slice so the
    // numbers describe the window rather than the page.
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;

    const limit = Math.min(Math.max(Number(req.query.total) || 300, 1), 1000);

    res.status(HTTP_STATUS.OK).json(
      successResponse({
        generatedAt: new Date().toISOString(),
        counts,
        total: events.length,
        events: events.slice(0, limit),
        // Named so the page can say WHICH source is missing rather than
        // quietly showing a shorter list.
        sourcesDown: [
          auth.length === 0 ? 'auth' : null,
          comm.length === 0 ? 'communication' : null,
          integration.length === 0 ? 'integration' : null,
        ].filter(Boolean),
      })
    );
  })
);
