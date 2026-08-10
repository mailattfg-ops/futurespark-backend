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
const AUTH_SERVICE_URL  = process.env.AUTH_SERVICE_URL  || 'http://127.0.0.1:3001';
const LEARN_SERVICE_URL = process.env.LEARN_SERVICE_URL || 'http://127.0.0.1:3002';
const PAY_SERVICE_URL   = process.env.PAY_SERVICE_URL   || 'http://127.0.0.1:3004';
const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://127.0.0.1:3003';
const INTEGRATION_SERVICE_URL = process.env.INTEGRATION_SERVICE_URL || 'http://127.0.0.1:3006';

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

// ── WhatsApp Webhook Verification (Handled Directly in Gateway) ───
// Meta calls GET /api/whatsapp/webhook to verify the callback URL
app.get('/api/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'futurespark-webhook-secret';

  logger.info(`[WhatsApp Webhook] Verify request — mode: ${mode}, token: ${token}`);

  if (mode === 'subscribe' && token === verifyToken) {
    logger.info('[WhatsApp Webhook] ✅ Verified by Meta');
    return res.status(200).send(challenge);
  }
  logger.error('[WhatsApp Webhook] ❌ Verification failed — token mismatch');
  return res.status(403).json({ error: 'Forbidden' });
});

// Meta sends incoming message events via POST
app.post('/api/whatsapp/webhook', express.json(), (req, res) => {
  const body = req.body;
  if (body?.object === 'whatsapp_business_account') {
    logger.info(`[WhatsApp Webhook] Incoming event received`);
    return res.sendStatus(200);
  }
  return res.sendStatus(404);
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
// Scheduler Group management
app.use('/api/scheduler-groups',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/scheduler-groups/' },
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

// Session resources hub — mentor-contributed teaching aids, read by every role
app.use('/api/resources',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: LEARN_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/resources/' },
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

// Public Callback for Google OAuth (does NOT require JWT auth)
app.use('/api/google/callback',
  createProxyMiddleware({
    target: INTEGRATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/google/auth/callback' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Integration service unreachable on callback: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Integration service is temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// Public Callback for Zoom OAuth (does NOT require JWT auth)
app.use('/api/zoom/callback',
  createProxyMiddleware({
    target: INTEGRATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/zoom/auth/callback' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Integration service unreachable on Zoom callback: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Integration service is temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// Public Zoom Webhooks (URL Validation & Event Delivery)
app.use('/api/zoom/webhooks',
  createProxyMiddleware({
    target: INTEGRATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/zoom/webhooks' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Integration service unreachable on Zoom webhooks: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Integration service is temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// Public Stream Route for Google Recordings (No JWT authentication required for browser media players)
app.use('/api/google/recordings/:id/stream',
  createProxyMiddleware({
    target: INTEGRATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path, req) => (req as express.Request).originalUrl.replace('/api/google/recordings/', '/google/recordings/'),
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Integration service unreachable on stream: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Integration service is temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// Public Stream Route for Zoom Recordings
app.use('/api/zoom/recordings/:id/stream',
  createProxyMiddleware({
    target: INTEGRATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path, req) => (req as express.Request).originalUrl.replace('/api/zoom/recordings/', '/zoom/recordings/'),
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Integration service unreachable on Zoom stream: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Integration service is temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// ── Storage Proxy (Public GET for viewing files, Protected POST/etc for uploading) ───
app.get('/api/storage/file',
  createProxyMiddleware({
    target: INTEGRATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/storage': '/storage' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Integration service unreachable for file get: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Storage service is temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

app.use('/api/storage',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: INTEGRATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/storage/' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Integration service unreachable for storage: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Storage service is temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// Google Integration service
app.use('/api/google',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: INTEGRATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/google/' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Integration service unreachable: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Integration service is temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// Zoom Integration service
app.use('/api/zoom',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: INTEGRATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/zoom/' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Integration service unreachable for Zoom: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Integration service is temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// Notification service
app.use('/api/notifications',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: COMMUNICATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/notifications/' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Communication service unreachable: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Notification service is temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// ── WhatsApp Webhook (Public — Meta Cloud API calls this) ───────
// GET: Webhook verification handshake from Meta
// POST: Incoming messages and status updates
app.use('/api/whatsapp/webhook',
  createProxyMiddleware({
    target: COMMUNICATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/whatsapp/webhook' },
    on: {
      error: (err, _req, res: any) => {
        logger.error(`[Gateway] Communication service unreachable for WhatsApp webhook: ${err.message}`);
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'WhatsApp webhook handler unavailable.',
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
