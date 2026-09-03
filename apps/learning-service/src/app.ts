import express from 'express';
import cors from 'cors';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS, buildInfo } from '@futurespark/constants';
import { errorHandler } from '@futurespark/middleware';
import { courseRoutes } from './modules/course';
import { resourceRoutes } from './modules/resource/resource.routes';
import { transcriptionRoutes } from './modules/transcription/transcription.routes';
import { aiAdminRoutes } from './modules/ai-admin/ai-admin.routes';
import { metricsRoutes } from './modules/metrics/metrics.routes';
import { requireInternalAuth, requireRoles } from './middlewares/auth';
import { auditMiddleware } from './modules/shared/audit';
import { migratePromptSuite } from './modules/ai-admin/ai-admin.service';
import { startLogRetentionCron } from './cron/log-retention.cron';

const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  logger.info(`[learning-service] ${req.method} ${req.path}`);
  next();
});

// Activity Log — records every successful mutation as a "who did what" event.
app.use(auditMiddleware);

// Keep activity + AI logs at least one month (31-day floor; default 45 days).
startLogRetentionCron();

// The prompts and this code are one contract: v2 derives every count from
// cited evidence, while a pre-v2 stored prompt tells the model to return the
// numbers itself. An environment upgraded in place still holds that old body
// as its ACTIVE version, so it is migrated here — at boot, because the
// pipeline reads the active prompt whether or not anyone opens /prompts.
void migratePromptSuite();

// Mount curriculum routes
app.use('/courses', courseRoutes);
app.use('/resources', resourceRoutes);
app.use('/transcription', transcriptionRoutes);
// Model catalogue + selection, spend ledger, error log (admin surface)
app.use('/ai', requireInternalAuth, requireRoles(['ADMIN']), aiAdminRoutes);
// System Health aggregates for the gateway dashboard (admin surface)
app.use('/metrics', metricsRoutes);

/**
 * Behaviours compiled into THIS build. A name cannot appear unless the code
 * implementing it is the code running, so a missing name proves the deployment
 * predates that fix. Add a name with the behaviour; never rename one.
 */
const CAPABILITIES = [
  'transcription-model-fallback-ladder',
  'transcription-empty-walks-ladder',
  'transcription-chat-base64-headroom',
];

app.get('/health', (req, res) => {
  // uptime is what the System Health page shows next to the green dot — a
  // service that silently restarts every few minutes looks identical to a
  // healthy one without it.
  res.status(HTTP_STATUS.OK).json(
    successResponse(
      { status: 'UP', uptime: process.uptime(), build: buildInfo('learning-service', CAPABILITIES) },
      'learning-service is healthy'
    )
  );
});

app.use((req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Route not found'));
});

// Register global error handler
app.use(errorHandler);

export default app;