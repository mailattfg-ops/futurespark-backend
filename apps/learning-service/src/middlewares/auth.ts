import { Request, Response, NextFunction } from 'express';
import { verifyInternalHeaders } from '@futurespark/authentication';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    role: string;
  };
}

/**
 * Middleware that authenticates incoming requests using internal trust headers
 * signed by the API Gateway.
 */
export const requireInternalAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    // Read and verify the internal cryptographic signature
    const headers = req.headers as Record<string, string>;
    const identity = verifyInternalHeaders(headers);
    
    req.user = {
      id: identity.userId,
      role: identity.role,
    };
    
    next();
  } catch (err: any) {
    next(new AppError(err.message || 'Unauthorized: Missing or invalid internal headers', HTTP_STATUS.UNAUTHORIZED));
  }
};

/**
 * Middleware that checks if the authenticated user has one of the allowed roles.
 */
export const requireRoles = (allowedRoles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('Unauthorized', HTTP_STATUS.UNAUTHORIZED));
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError('Forbidden: Insufficient privileges', HTTP_STATUS.FORBIDDEN));
    }
    
    next();
  };
};
