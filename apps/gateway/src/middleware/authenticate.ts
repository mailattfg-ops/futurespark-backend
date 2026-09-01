import { touchPresence } from '../routes/presence';
import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, isTokenBlocked, signInternalHeaders } from '@futurespark/authentication';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';
import logger from '@futurespark/logger';

/**
 * JWT verification middleware for the gateway.
 * Verifies the Bearer token, checks the Redis blocklist,
 * then signs and injects HMAC internal headers before forwarding.
 */
export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return next(new AppError('Missing or invalid Authorization header', HTTP_STATUS.UNAUTHORIZED));
    }

    const token = authHeader.split(' ')[1];
    let payload;

    try {
      payload = verifyAccessToken(token);
    } catch (err: any) {
      logger.error(`[Gateway Auth] JWT verification failed: ${err.message}. Token: ${token.slice(0, 20)}...`);
      return next(new AppError('Invalid or expired access token', HTTP_STATUS.UNAUTHORIZED));
    }

    // Check the JWT blocklist (Redis)
    const blocked = await isTokenBlocked(payload.jti);
    if (blocked) {
      return next(new AppError('Token has been revoked', HTTP_STATUS.UNAUTHORIZED));
    }

    /* ── DISPLAY is a screen, not an operator ────────────────────────────
     * Page-level role checks live in the admin app's layout and are only as
     * strong as a browser's localStorage. This role is handed out to put
     * numbers on a wall, so its restriction is enforced here instead: one
     * aggregate endpoint, read-only, and nothing else in the platform.
     *
     * Every gated route in the gateway passes through this middleware, so
     * this is the one place the rule cannot be routed around.
     *
     * 403 and not 401 on purpose: the admin app signs a user out on 401, and
     * a display screen must not log itself out when a stray widget polls. */
    if (payload.role === 'DISPLAY') {
      const path = req.originalUrl.split('?')[0].replace(/\/+$/, '');
      const permitted = req.method === 'GET' && path === '/api/schedules/display-metrics';
      if (!permitted) {
        logger.warn(`[Gateway Auth] DISPLAY role refused ${req.method} ${path}`);
        return next(
          new AppError('This account may only view the display dashboard', HTTP_STATUS.FORBIDDEN)
        );
      }
    }

    // Sign and inject internal HMAC headers for downstream services
    const p = payload as any;
    const userId = p.userId || p.id || p.sub;
    const internalHeaders = signInternalHeaders(userId, payload.role || 'USER');
    Object.entries(internalHeaders).forEach(([key, value]) => {
      req.headers[key] = value;
    });

    // Every authenticated request from every role passes through here, which
    // makes this the only honest place to answer "who is using the app right
    // now". Fire-and-forget — presence never delays or fails a real request.
    touchPresence(userId, payload.role || "USER");

    next();
  } catch (err) {
    next(err);
  }
};
