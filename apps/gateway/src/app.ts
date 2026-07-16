import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { logger } from '@futurespark/logger';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { errorHandler, requestId, asyncHandler } from '@futurespark/middleware';
import { createRedisClient } from '@futurespark/cache';
import { authenticate } from './middleware/authenticate';

const app = express();

// ── Bootstrap ──────────────────────────────────────────────────
// Initialize Redis connection for JWT blocklist lookups
createRedisClient(process.env.REDIS_URL);

// ── Service URLs ───────────────────────────────────────────────
const AUTH_SERVICE_URL  = process.env.AUTH_SERVICE_URL  || 'http://localhost:3001';
const LEARN_SERVICE_URL = process.env.LEARN_SERVICE_URL || 'http://localhost:3002';
const PAY_SERVICE_URL   = process.env.PAY_SERVICE_URL   || 'http://localhost:3004';

// ── Core Middleware ────────────────────────────────────────────
app.use(cors());
app.use(requestId);

// ── Request Logging ────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info(`[Gateway] ${req.method} ${req.path} — ${req.headers['x-request-id']}`);
  next();
});

// ── Health Check ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(HTTP_STATUS.OK).json(
    successResponse({ status: 'UP', uptime: process.uptime() }, 'Gateway is healthy')
  );
});

// ── Public Routes (No Auth Required) ──────────────────────────
// Auth flows: register, login, refresh are public
app.use('/api/auth', createProxyMiddleware({
  target: AUTH_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/': '/auth/' },
  on: {
    error: (err, _req, res: any) => {
      logger.error(`[Gateway] Auth service unreachable: ${err.message}`);
      res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
        success: false,
        message: 'Auth service is temporarily unavailable. Please try again shortly.',
        timestamp: new Date().toISOString(),
      });
    },
  },
}));

// ── Protected Routes (JWT + HMAC Required) ────────────────────
// User management
app.use('/api/users',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/users/' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Auth service unreachable: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Service temporarily unavailable. Please try again shortly.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);
// Role management
app.use('/api/roles',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/roles/' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Auth service unreachable: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Service temporarily unavailable. Please try again shortly.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);
// Schedule management
app.use('/api/schedules',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/schedules/' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Auth service unreachable: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Service temporarily unavailable. Please try again shortly.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);
// Learning service (future)
app.use('/api/courses',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: LEARN_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/courses/' },
    on: {
      error: (_err, _req, res: any) => {
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Learning service temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// Payment service — Fail-fast 503, no cached fallback
app.use('/api/payments',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: PAY_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/payments/' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Payment service unreachable: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Payment service is temporarily unavailable. Please try your checkout again shortly.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// ── 404 Handler ────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, message: 'Route not found' });
});

// ── Global Error Handler ───────────────────────────────────────
app.use(errorHandler);

export default app;
