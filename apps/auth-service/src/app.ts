import express from 'express';
import cors from 'cors';
import { logger } from '@futurespark/logger';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS, buildInfo } from '@futurespark/constants';
import { errorHandler, requestId } from '@futurespark/middleware';
import { authRoutes } from './modules/auth';
import { userRoutes } from './modules/user';
import { roleRoutes } from './modules/role/role.routes';
import { scheduleRoutes } from './modules/schedule/schedule.routes';
import { schedulerGroupRoutes } from './modules/scheduler-group/scheduler-group.routes';
import { auditRoutes } from './modules/audit/audit.routes';
import { metricsRoutes } from './modules/metrics/metrics.routes';
import { auditMiddleware } from './modules/shared/audit';

const app = express();

// ── Core Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(requestId);

// ── Request Logging ────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info(`[Auth-Service] ${req.method} ${req.path} — ${req.headers['x-request-id']}`);
  next();
});

// Activity Log — records every successful mutation as a "who did what" event.
app.use(auditMiddleware);

// ── Routes ─────────────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/audit', auditRoutes);
app.use('/users', userRoutes);
app.use('/roles', roleRoutes);
app.use('/schedules', scheduleRoutes);
app.use('/scheduler-groups', schedulerGroupRoutes);
app.use('/metrics', metricsRoutes);

// ── Health Check ───────────────────────────────────────────────
/**
 * Behaviours compiled into THIS build.
 *
 * A name here cannot appear unless the code implementing it is the code
 * running, so a missing name proves the deployment predates that fix. Add a
 * name in the same change as the behaviour; never rename one.
 */
const CAPABILITIES = [
  'report-approved-design',
  'report-curriculum-content',
  'report-first-session-baseline',
  'slot-70min-editable-end',
  'slot-conflict-override',
  'class-conflict-override',
];

app.get('/health', (_req, res) => {
  // uptime feeds the System Health page; capabilities answer "is the fix live?".
  res.status(HTTP_STATUS.OK).json(
    successResponse(
      { status: 'UP', uptime: process.uptime(), build: buildInfo('auth-service', CAPABILITIES) },
      'auth-service is healthy'
    )
  );
});

// ── 404 Handler ────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, message: 'Route not found' });
});

// ── Global Error Handler ───────────────────────────────────────
// Must be registered last, after all routes
app.use(errorHandler);

export default app;
