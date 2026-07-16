import { Request, Response, NextFunction } from 'express';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';
import { decodeToken } from '@futurespark/authentication';

/**
 * Gateway Role Authorization Middleware.
 * Decodes the Bearer token and checks if the user's role is in the allowed list.
 */
export const authorize = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return next(new AppError('Unauthorized access', HTTP_STATUS.UNAUTHORIZED));
      }

      const token = authHeader.split(' ')[1];
      const payload = decodeToken(token);

      if (!payload || !allowedRoles.includes(payload.role)) {
        return next(new AppError('Forbidden: Insufficient privileges', HTTP_STATUS.FORBIDDEN));
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};
