import { logger } from '@futurespark/logger';

const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://localhost:3003';

export const sendNotification = async (recipientId: string, title: string, message: string, priority: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW') => {
  try {
    const res = await fetch(`${COMMUNICATION_SERVICE_URL}/notifications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipientId,
        title,
        message,
        priority,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      logger.error(`[Notification Helper] Failed to send notification: ${res.statusText} - ${errText}`);
    }
  } catch (err: any) {
    logger.error(`[Notification Helper] Error sending notification to communication-service: ${err.message}`);
  }
};
