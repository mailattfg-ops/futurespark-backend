import crypto from 'crypto';

// ── Async Handler ──────────────────────────────────────────────

/**
 * Wraps an async Express route handler to automatically catch errors
 * and forward them to the Express error middleware.
 * Uses generic types to avoid depending on @types/express directly.
 */
export const asyncHandler = (fn: Function) => {
  return (req: any, res: any, next: any) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// ── Global Error Handler ───────────────────────────────────────

/**
 * Custom application error with HTTP status code.
 */
export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;

  constructor(message: string, statusCode: number, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Global error handler middleware.
 * Catches all errors thrown in route handlers and returns a standardized response.
 */
export const errorHandler = (err: any, req: any, res: any, _next: any) => {
  const requestId = req.headers['x-request-id'] || 'unknown';

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }

  // Prisma known errors
  if (err.code === 'P2002') {
    return res.status(409).json({
      success: false,
      message: 'A record with this value already exists',
      timestamp: new Date().toISOString(),
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      success: false,
      message: 'Record not found',
      timestamp: new Date().toISOString(),
    });
  }

  // Unexpected errors
  console.error(`[${requestId}] Unexpected error: ${err.message}`);
  console.error(err.stack || '');

  return res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    timestamp: new Date().toISOString(),
  });
};

// ── Request ID Middleware ──────────────────────────────────────

/**
 * Attaches a unique request ID to every incoming request.
 */
export const requestId = (req: any, res: any, next: any) => {
  const id = req.headers['x-request-id'] || crypto.randomUUID();
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-Id', id);
  next();
};