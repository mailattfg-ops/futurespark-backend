import express from 'express';
import cors from 'cors';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';

import googleAuthRouter from './modules/google/auth/auth.routes';
import googleMeetingsRouter from './modules/google/meetings/meetings.routes';
import googleRecordingsRouter from './modules/google/recording/recording.routes';
import { startSyncCron } from './modules/google/cron/sync.cron';

const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  logger.info(`[integration-service] ${req.method} ${req.path}`);
  next();
});

// Start background cron worker
startSyncCron();

// Register Google module endpoints
app.use('/google/auth', googleAuthRouter);
app.use('/google/meetings', googleMeetingsRouter);
app.use('/google/recordings', googleRecordingsRouter);

app.get('/health', (req, res) => {
  res.status(HTTP_STATUS.OK).json(successResponse({ status: 'UP' }, 'integration-service is healthy'));
});

app.use((req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Route not found'));
});

export default app;