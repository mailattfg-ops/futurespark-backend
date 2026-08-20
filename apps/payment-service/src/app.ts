import express from 'express';
import cors from 'cors';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';

const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  logger.info(`[payment-service] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (req, res) => {
  // uptime feeds the System Health page's per-service card.
  res.status(HTTP_STATUS.OK).json(successResponse({ status: 'UP', uptime: process.uptime() }, 'payment-service is healthy'));
});

app.use((req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Route not found'));
});

export default app;