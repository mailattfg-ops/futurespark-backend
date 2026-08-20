import express from 'express';
import cors from 'cors';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { errorHandler } from '@futurespark/middleware';
import { courseRoutes } from './modules/course';
import { resourceRoutes } from './modules/resource/resource.routes';
import { transcriptionRoutes } from './modules/transcription/transcription.routes';
import { aiAdminRoutes } from './modules/ai-admin/ai-admin.routes';
import { metricsRoutes } from './modules/metrics/metrics.routes';
import { auditMiddleware } from './modules/shared/audit';
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

// Mount curriculum routes
app.use('/courses', courseRoutes);
app.use('/resources', resourceRoutes);
app.use('/transcription', transcriptionRoutes);
// Model catalogue + selection, spend ledger, error log (admin surface)
app.use('/ai', aiAdminRoutes);
// System Health aggregates for the gateway dashboard (admin surface)
app.use('/metrics', metricsRoutes);

app.get('/health', (req, res) => {
  // uptime is what the System Health page shows next to the green dot — a
  // service that silently restarts every few minutes looks identical to a
  // healthy one without it.
  res.status(HTTP_STATUS.OK).json(successResponse({ status: 'UP', uptime: process.uptime() }, 'learning-service is healthy'));
});

app.use((req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Route not found'));
});

// Register global error handler
app.use(errorHandler);

export default app;