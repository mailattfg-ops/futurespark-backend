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
import classLifecycleRouter from './modules/classes/lifecycle.routes';
import metricsRoutes from './modules/metrics/metrics.routes';
import { startTranscriptionRetryCron, resetStuckTranscriptions } from './modules/shared/transcription-retry';
import { GoogleRecordingService } from './modules/google/recording/recording.service';
import { ZoomRecordingService } from './modules/zoom/recording/recording.service';

// Zoom modules
import zoomAuthRouter from './modules/zoom/auth/auth.routes';
import zoomMeetingsRouter from './modules/zoom/meetings/meetings.routes';
import zoomRecordingsRouter from './modules/zoom/recording/recording.routes';
import zoomPresenceRouter from './modules/zoom/presence/presence.routes';
import { startZoomPresencePolling } from './modules/zoom/presence/presence.service';
import zoomWebhooksRouter from './modules/zoom/webhooks/webhooks.routes';
import { zoomHostsRouter } from './modules/zoom/hosts/hosts.routes';
import { seedFromEnvIfEmpty } from './modules/zoom/hosts/hosts.service';

const app = express();

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

app.use((req, res, next) => {
  logger.info(`[integration-service] ${req.method} ${req.path}`);
  next();
});

// Activity Log — records webapp-driven mutations (recording sync, uploads) by
// posting them to auth-service's internal /audit/record endpoint.
import { auditMiddleware } from './modules/shared/audit-http';
app.use(auditMiddleware);

// Start background cron workers
startSyncCron();
// Retries transcriptions that failed for a reason that passes — chiefly the
// Groq free tier's audio quota, which rejects the sixth class of a day purely
// for arriving too soon. Routed by provider so a Zoom recording is retried
// through Zoom's path and a Meet recording through Google's.
// A restart orphans any in-flight job: the DB says RUNNING, the process that
// owned it is gone. Requeue those before the daemon starts looking.
void resetStuckTranscriptions();
startTranscriptionRetryCron((recordingId, provider) =>
  provider === 'ZOOM'
    ? ZoomRecordingService.transcribeRecording(recordingId)
    : GoogleRecordingService.transcribeRecording(recordingId)
);
startPresencePolling();
startZoomPresencePolling();

// Cutover: copy ZOOM_HOST_EMAILS into the seat table the first time this runs
// against an empty table, so the allocator's switch from env to database is
// invisible — the same seats keep hosting the same classes. No-ops forever
// after, and never resurrects a seat an admin deleted.
void seedFromEnvIfEmpty();

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
// The licensed seat register — buying a Zoom licence no longer needs an env
// edit and a redeploy. Admin-gated inside the router.
app.use('/zoom/hosts', zoomHostsRouter);

// Storage module
app.use('/storage', storageRouter);

// Provider-neutral class lifecycle (auth-service tells us a class was signed off)
app.use('/classes', classLifecycleRouter);

// System Health aggregates (admin-only, read by the gateway)
app.use('/metrics', metricsRoutes);

app.get('/health', (_req, res) => {
  // uptime feeds the System Health page's per-service card.
  res.status(HTTP_STATUS.OK).json(successResponse({ status: 'UP', uptime: process.uptime() }, 'integration-service is healthy'));
});

app.use((_req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Route not found'));
});

export default app;