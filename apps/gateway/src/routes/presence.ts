import { Router, type Request, type Response } from 'express';
import { getRedisClient } from '@futurespark/cache';
import { logger } from '@futurespark/logger';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { asyncHandler } from '@futurespark/middleware';

/**
 * Who is actually using the app right now.
 *
 * The dashboard used to answer this with `max(users.length, students + parents
 * + teachers)` — a headcount of everyone who has ever registered, dressed up
 * as a live figure. It could only go up, and it said the same number at 4am as
 * at 4pm.
 *
 * The gateway is the one place that sees every authenticated request from
 * every role, so last-seen is recorded here: one Redis key per user, re-set on
 * each request, expiring by itself. Counting live users is then counting keys.
 * Nothing is written to the database — presence is worthless a minute later,
 * and a row per request would be the most-written table in the system.
 */

/** How long after their last request a person still counts as "using it". */
const PRESENCE_TTL_SECONDS = Number(process.env.PRESENCE_WINDOW_SECONDS ?? 300);
const KEY_PREFIX = 'presence:';

/** Roles are grouped so the card can say WHO is on, not just how many. */
const roleBucket = (role: string): string => {
  const r = (role || '').toUpperCase();
  if (r === 'STUDENT') return 'students';
  if (r === 'PARENT') return 'parents';
  if (r === 'TEACHER' || r === 'INSTRUCTOR') return 'teachers';
  return 'staff';
};

/**
 * Record that this user is active. Fire-and-forget: presence is a nicety and
 * must never add latency to, or fail, the request it is observing.
 */
/**
 * In-process last-seen, used when Redis is unavailable.
 *
 * Bounded by the same TTL and swept on read, so it cannot grow without limit.
 * It is per-process: with several gateway instances behind a load balancer
 * each would see only its own share, which is why Redis stays the preferred
 * store rather than this being the only one.
 */
const localPresence = new Map<string, { role: string; at: number }>();

const sweepLocal = (): void => {
  const cutoff = Date.now() - PRESENCE_TTL_SECONDS * 1000;
  for (const [id, entry] of localPresence) {
    if (entry.at < cutoff) localPresence.delete(id);
  }
};

export const touchPresence = (userId: string, role: string): void => {
  if (!userId) return;
  const bucket = roleBucket(role);

  // Always recorded locally: this is the fallback AND the thing that keeps the
  // card honest during a Redis outage.
  localPresence.set(userId, { role: bucket, at: Date.now() });
  if (localPresence.size > 5000) sweepLocal();

  try {
    const redis = getRedisClient();
    void redis
      .set(`${KEY_PREFIX}${userId}`, bucket, 'EX', PRESENCE_TTL_SECONDS)
      .catch(() => undefined);
  } catch {
    // Redis not configured or not connected — the local map above answers.
  }
};

export const presenceRouter = Router();

presenceRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    if (String(req.headers['x-user-role'] ?? '').toUpperCase() !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Only an admin can read presence.' });
    }

    const byRole: Record<string, number> = { students: 0, parents: 0, teachers: 0, staff: 0 };
    let total = 0;
    let available = true;
    let redisFailed = false;

    try {
      const redis = getRedisClient();
      // SCAN, never KEYS: KEYS blocks the Redis event loop for everyone else,
      // and this endpoint is polled.
      let cursor = '0';
      const keys: string[] = [];
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0' && keys.length < 10_000);

      if (keys.length > 0) {
        const values = await redis.mget(...keys);
        for (const value of values) {
          // A key can expire between the scan and the read; that person left.
          if (value === null) continue;
          total += 1;
          byRole[value] = (byRole[value] ?? 0) + 1;
        }
      }
    } catch (err: any) {
      redisFailed = true;
      logger.warn(`[Presence] Redis unavailable (${err.message}); answering from this process's own last-seen map.`);
    }

    // Redis down, or simply holding nothing yet — fall back to what this
    // process has seen. Only when there is no source at all do we say so.
    if (total === 0) {
      sweepLocal();
      for (const entry of localPresence.values()) {
        total += 1;
        byRole[entry.role] = (byRole[entry.role] ?? 0) + 1;
      }
      if (total === 0 && redisFailed) available = false;
    }

    return res.status(HTTP_STATUS.OK).json(
      successResponse({
        available,
        total: available ? total : null,
        byRole: available ? byRole : null,
        windowSeconds: PRESENCE_TTL_SECONDS,
      })
    );
  })
);
