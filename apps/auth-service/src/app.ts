import express from 'express';
import cors from 'cors';
import { logger } from '@futurespark/logger';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { errorHandler, requestId } from '@futurespark/middleware';
import { authRoutes } from './modules/auth';
import { userRoutes } from './modules/user';

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

// ── Routes ─────────────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/users', userRoutes);

// ── Health Check ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(HTTP_STATUS.OK).json(
    successResponse(
      { status: 'UP', uptime: process.uptime() },
      'Auth Service is healthy'
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
