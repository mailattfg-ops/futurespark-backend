import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { logger } from '@futurespark/logger';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { errorHandler, requestId, asyncHandler } from '@futurespark/middleware';
import { createRedisClient } from '@futurespark/cache';
import { authenticate } from './middleware/authenticate';
import { logsRouter } from './routes/logs';

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

/* ──────────────────────────────────────────────────────────────────────────
 * NOTE: /api/whatsapp/webhook is deliberately NOT handled here.
 *
 * It is proxied verbatim to communication-service at the bottom of this file,
 * which owns the hardened implementation (verify-token handshake with no
 * insecure fallback, X-Hub-Signature-256 HMAC verification, inbound
 * persistence, idempotency, auto-reply).
 *
 * Two rules for that route, both load-bearing:
 *
 *   1. Register NOTHING for this path above the proxy. Express matches layers
 *      in registration order, so any app.get/app.post/app.use here wins and
 *      the proxy becomes unreachable — the failure is silent (Meta gets its
 *      200 ack and the event is discarded).
 *
 *   2. Never run a body parser in front of it. Meta's X-Hub-Signature-256 is
 *      an HMAC over the EXACT raw request bytes. With no parser mounted, the
 *      proxy pipes the untouched request stream straight to the upstream
 *      socket, so the bytes and Content-Length arrive unchanged. Adding a
 *      global express.json() — or any parser scoped to this path — drains that
 *      stream first. http-proxy-middleware v4 does not re-emit a consumed body
 *      unless you opt into its fixRequestBody handler, so the proxied request
 *      never ends and the webhook HANGS until Meta times out (measured, not
 *      assumed). Even with fixRequestBody it would only 401 forever, because an
 *      HMAC cannot be recomputed from a re-serialised object — key order,
 *      unicode escaping and whitespace all differ from Meta's byte stream.
 *      This gateway mounts NO body parser at all; keep it that way.
 * ────────────────────────────────────────────────────────────────────────── */

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

// Merged service logs — still consumed by the AI Errors page's log-context
// and Pipeline activity features. Served by the gateway itself (not proxied):
// the log files live on this box, one per service.
app.use('/api/logs', asyncHandler(authenticate), logsRouter);

// Activity Log — business events ("who did what"), the admin's /logs page.
// READ-ONLY from outside: the internal /audit/record write endpoint must stay
// reachable only service-to-service, so non-GET is refused here.
app.use('/api/audit',
  asyncHandler(authenticate),
  (req: any, res: any, next: any) => {
    if (req.method !== 'GET') {
      return res.status(405).json({ success: false, message: 'The activity log is read-only from the app.' });
    }
    next();
  },
  createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/audit/' },
    on: {
      error: (_err, _req, res: any) => {
        res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
          success: false,
          message: 'Auth service temporarily unavailable.',
          timestamp: new Date().toISOString(),
        });
      },
    },
  })
);

// AI administration — model catalogue + selection, spend ledger, error log.
// Role enforcement happens in learning-service from the x-user-role header.
app.use('/api/ai',
  asyncHandler(authenticate),
  createProxyMiddleware({
    target: LEARN_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/ai/' },
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

/* ── WhatsApp Webhook (Public — Meta Cloud API calls this) ──────────────────
 * GET:  verification handshake from Meta (hub.mode / hub.verify_token / hub.challenge)
 * POST: incoming messages and delivery status updates, signed with X-Hub-Signature-256
 *
 * RAW-BODY CONTRACT — do not break it:
 *   No body parser runs anywhere ahead of this middleware (cors, requestId and
 *   the request logger all touch headers only), so http-proxy-middleware pipes
 *   the request stream directly into the upstream socket and forwards the
 *   headers verbatim — Content-Type, Content-Length and X-Hub-Signature-256
 *   included. communication-service re-reads those exact bytes via
 *   express.raw() and verifies the HMAC against them. Introducing express.json()
 *   (globally or on this path) drains the stream and every webhook starts
 *   failing signature verification.
 *
 * Nothing may be registered for this path above this line — see the note next
 * to the health check. Express matches in registration order and an earlier
 * layer silently swallows every inbound message.
 * ────────────────────────────────────────────────────────────────────────── */
app.use('/api/whatsapp/webhook',
  createProxyMiddleware({
    target: COMMUNICATION_SERVICE_URL,
    changeOrigin: true,
    // app.use() strips the mount path, leaving req.url === '/' (plus any query
    // string), which this rewrites to the service-side '/whatsapp/webhook'.
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
