import express from 'express';
import cors from 'cors';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';

import googleAuthRouter from './modules/google/auth/auth.routes';
import googleMeetingsRouter from './modules/google/meetings/meetings.routes';
import googleRecordingsRouter from './modules/google/recording/recording.routes';
import { startSyncCron } from './modules/google/cron/sync.cron';
import googlePresenceRouter from './modules/google/presence/presence.routes';
import { startPresencePolling } from './modules/google/presence/presence.service';
import storageRouter from './modules/storage/storage.routes';

// Zoom modules
import zoomAuthRouter from './modules/zoom/auth/auth.routes';
import zoomMeetingsRouter from './modules/zoom/meetings/meetings.routes';
import zoomRecordingsRouter from './modules/zoom/recording/recording.routes';
import zoomPresenceRouter from './modules/zoom/presence/presence.routes';
import { startZoomPresencePolling } from './modules/zoom/presence/presence.service';
import zoomWebhooksRouter from './modules/zoom/webhooks/webhooks.routes';

const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  logger.info(`[integration-service] ${req.method} ${req.path}`);
  next();
});

// Start background cron workers
startSyncCron();
startPresencePolling();
startZoomPresencePolling();

// Register Google module endpoints
app.use('/google/auth', googleAuthRouter);
app.use('/google/meetings', googleMeetingsRouter);
app.use('/google/recordings', googleRecordingsRouter);
app.use('/google/presence', googlePresenceRouter);

// Register Zoom module endpoints
app.use('/zoom/auth', zoomAuthRouter);
app.use('/zoom/meetings', zoomMeetingsRouter);
app.use('/zoom/recordings', zoomRecordingsRouter);
app.use('/zoom/presence', zoomPresenceRouter);
app.use('/zoom/webhooks', zoomWebhooksRouter);

// Storage module
app.use('/storage', storageRouter);

app.get('/health', (_req, res) => {
  res.status(HTTP_STATUS.OK).json(successResponse({ status: 'UP' }, 'integration-service is healthy'));
});

app.use((_req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Route not found'));
});

export default app;