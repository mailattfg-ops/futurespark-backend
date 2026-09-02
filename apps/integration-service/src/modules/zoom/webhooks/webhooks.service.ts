import crypto from 'crypto';
import { internalKeyHeader } from '../../shared/internal-key';
import { db, withDbRetry } from '../../../database/datasource';
import { ZoomRecordingService } from '../recording/recording.service';
import { logger } from '@futurespark/logger';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

export class ZoomWebhooksService {
  /**
   * Validates Zoom webhook CRC challenge.
   */
  static validateUrl(plainToken: string): { plainToken: string; encryptedToken: string } {
    const secretToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || 'futurespark-zoom-webhook-secret';
    const hash = crypto.createHmac('sha256', secretToken).update(plainToken).digest('hex');
    return {
      plainToken,
      encryptedToken: hash,
    };
  }

  /**
   * Processes incoming webhook event payload from Zoom.
   */
  static async handleEvent(event: string, payload: any) {
    logger.info(`[ZoomWebhook] Received event: ${event}`);

    const meetingObj = payload?.object;
    const meetingId = String(meetingObj?.id || '');

    if (!meetingId) {
      logger.warn(`[ZoomWebhook] Event ${event} received without valid meeting ID`);
      return;
    }

    const meeting = await withDbRetry(() =>
      db.meeting.findFirst({
        where: {
          OR: [
            { zoomMeetingId: meetingId },
            { meetUrl: { contains: meetingId } },
          ],
        },
      })
    );

    const now = new Date();

    switch (event) {
      case 'meeting.started':
      case 'meeting.participant_joined':
        if (meeting) {
          logger.info(`[ZoomWebhook] Meeting started / joined for "${meeting.title}" (${meetingId})`);
          await withDbRetry(() =>
            db.meeting.update({
              where: { id: meeting.id },
              data: {
                presenceIsLive: true,
                presenceLastLiveAt: now,
                ...(meeting.presenceFirstJoinAt ? {} : { presenceFirstJoinAt: now }),
              },
            })
          );
        }
        break;

      case 'meeting.ended':
        if (meeting) {
          logger.info(`[ZoomWebhook] Meeting ended for "${meeting.title}" (${meetingId})`);
          await withDbRetry(() =>
            db.meeting.update({
              where: { id: meeting.id },
              data: {
                presenceIsLive: false,
                presenceLastLiveAt: now,
              },
            })
          );

          // Report room ended to auth-service
          fetch(`${AUTH_SERVICE_URL}/schedules/internal/room-ended`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...internalKeyHeader() },
            body: JSON.stringify({ meetingLink: meeting.meetUrl, endedAt: now.toISOString() }),
          }).catch((err) => {
            logger.warn(`[ZoomWebhook] Failed to report room ended: ${err.message}`);
          });
        }
        break;

      case 'recording.completed':
        if (meeting) {
          logger.info(`[ZoomWebhook] Recording completed for "${meeting.title}" (${meetingId}). Syncing files...`);
          ZoomRecordingService.syncMeetingRecording(meeting.id).catch((err) => {
            logger.warn(`[ZoomWebhook] Auto sync after recording completed failed: ${err.message}`);
          });
        }
        break;

      default:
        logger.info(`[ZoomWebhook] Unhandled event type: ${event}`);
        break;
    }
  }
}
