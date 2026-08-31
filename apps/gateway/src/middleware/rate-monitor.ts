import { Request, Response, NextFunction } from 'express';
import logger from '@futurespark/logger';

// In-Memory Request Rate Monitor fallback
const ipRequestWindow = new Map<string, { count: number; windowStart: number }>();
const CLEANUP_INTERVAL_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_MINUTE_WARNING = 150; // Threshold for logging high traffic warnings

// Periodic cleanup of stale IP tracking entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of ipRequestWindow.entries()) {
    if (now - record.windowStart > CLEANUP_INTERVAL_MS) {
      ipRequestWindow.delete(ip);
    }
  }
}, CLEANUP_INTERVAL_MS);

/**
 * Non-Blocking Request Rate Monitor Middleware.
 *
 * CRITICAL SECURITY REQUIREMENT:
 * This middleware operates strictly in MONITOR-ONLY mode.
 * It tracks request frequency per IP to provide observability on traffic spikes.
 *
 * It NEVER drops, throttles, blocks, or rejects legitimate traffic.
 */
export const rateMonitorMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  try {
    const rawIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
    const clientIp = rawIp.split(',')[0].trim();
    const now = Date.now();

    const record = ipRequestWindow.get(clientIp) || { count: 0, windowStart: now };

    if (now - record.windowStart > CLEANUP_INTERVAL_MS) {
      record.count = 1;
      record.windowStart = now;
    } else {
      record.count += 1;
    }

    ipRequestWindow.set(clientIp, record);

    if (record.count > MAX_REQUESTS_PER_MINUTE_WARNING && record.count % 50 === 0) {
      logger.warn(
        `[Security Monitor][RateMonitor] High request frequency threshold reached. ` +
          `IP: ${clientIp} | Count: ${record.count} req/min | Route: ${req.method} ${req.originalUrl}`
      );
    }
  } catch (err: any) {
    // Fail-Safe: Monitoring failure must NEVER disrupt user request processing
    logger.error(`[RateMonitor] Error in rate monitor: ${err?.message}`);
  } finally {
    next();
  }
};
