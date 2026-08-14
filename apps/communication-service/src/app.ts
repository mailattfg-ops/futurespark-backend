import path from 'path';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';

import { notificationRoutes } from './modules/notification/notification.routes';
import { whatsappWebhookRoutes } from './modules/whatsapp/whatsapp.routes';
import { whatsappReportRoutes } from './modules/whatsapp/report.routes';
import { assertWhatsAppStartupConfig } from './modules/whatsapp/whatsapp.service';

/* ──────────────────────────────────────────────────────────────────────────
 * Load .env HERE, not only in server.ts.
 *
 * server.ts does `import app from './app'` on the line ABOVE its
 * `dotenv.config()`, and TypeScript compiles imports to requires that all run
 * before any module body — so under `npm start` / `npm run dev` the whole
 * module graph was previously constructed with an empty environment.
 * dotenv never overwrites already-set variables, so server.ts's later calls
 * are a harmless no-op and container-injected env still wins.
 * ────────────────────────────────────────────────────────────────────────── */
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

// Fail loudly and early on a missing WhatsApp credential. In production this
// throws and the process refuses to start; there are no sandbox fallbacks.
assertWhatsAppStartupConfig();

const app = express();

app.use(cors());

app.use((req, res, next) => {
  logger.info(`[communication-service] ${req.method} ${req.path}`);
  next();
});

/* ──────────────────────────────────────────────────────────────────────────
 * WhatsApp webhook — mounted BEFORE the global express.json().
 *
 * Meta's X-Hub-Signature-256 is an HMAC over the exact raw request bytes, so
 * the raw Buffer has to survive to the verifier. Two ways to get it; this one
 * scopes express.raw() to the single route that needs it, rather than using
 * the global `express.json({ verify })` hook. Reasons:
 *   1. The verify hook retains a Buffer copy of EVERY request body service-wide
 *      (notifications included) purely to serve one endpoint.
 *   2. Local ordering is self-evident and hard to regress: if anything ever
 *      parses the body first, the verifier sees a non-Buffer and hard-fails
 *      instead of silently comparing a re-serialised payload that can never match.
 *   3. It lets the only unauthenticated endpoint on the service carry its own
 *      tight body limit.
 * ────────────────────────────────────────────────────────────────────────── */
app.use(
  '/whatsapp/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  whatsappWebhookRoutes
);

/* ──────────────────────────────────────────────────────────────────────────
 * Session report — also mounted before the global express.json().
 *
 * The body carries a base64-encoded PDF, which blows straight through the
 * 100kb ceiling below. The larger limit is scoped to this one route rather than
 * raised globally, so the endpoints that only ever receive small JSON keep the
 * body ceiling they have always had. 12mb is far above the ~200kb a real report
 * weighs; it exists so an unusually long class does not silently 413.
 *
 * Not reachable from the internet: the gateway proxies only /api/notifications
 * and /api/whatsapp/webhook on this service.
 * ────────────────────────────────────────────────────────────────────────── */
app.use('/whatsapp', express.json({ limit: '12mb' }), whatsappReportRoutes);

// Explicitly the previous default; not raised, so the authenticated routes keep
// the same body ceiling they always had.
app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => {
  res.status(HTTP_STATUS.OK).json(successResponse({ status: 'UP' }, 'communication-service is healthy'));
});

app.use('/notifications', notificationRoutes);

app.use((req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Route not found'));
});

export default app;
