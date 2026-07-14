import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, isTokenBlocked, signInternalHeaders } from '@futurespark/authentication';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

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
    } catch {
      return next(new AppError('Invalid or expired access token', HTTP_STATUS.UNAUTHORIZED));
    }

    // Check the JWT blocklist (Redis)
    const blocked = await isTokenBlocked(payload.jti);
    if (blocked) {
      return next(new AppError('Token has been revoked', HTTP_STATUS.UNAUTHORIZED));
    }

    // Sign and inject internal HMAC headers for downstream services
    const internalHeaders = signInternalHeaders(payload.userId, payload.role);
    Object.entries(internalHeaders).forEach(([key, value]) => {
      req.headers[key] = value;
    });

    next();
  } catch (err) {
    next(err);
  }
};
