import db from '../../database/datasource';
import { logger } from '@futurespark/logger';
import { whatsappService } from '../whatsapp/whatsapp.service';

export const notificationService = {
  async createNotification(data: { recipientId: string; title: string; message: string; priority: string }) {
    const notification = await db.notification.create({
      data: {
        recipientId: data.recipientId,
        title: data.title,
        message: data.message,
        priority: data.priority || 'LOW',
      },
    });

    // Asynchronously resolve phone number and send WhatsApp message
    // so it doesn't block the HTTP request lifecycle.
    (async () => {
      try {
        const phone = await whatsappService.resolveUserPhoneNumber(data.recipientId);
        if (phone) {
          const bodyText = `🔔 *${data.title}*\n\n${data.message}`;
          logger.info(`[Notification Service] Dispatched WhatsApp alert to user: ${data.recipientId} at: ${phone}`);
          await whatsappService.sendTextMessage(phone, bodyText, data.recipientId);
        } else {
          logger.info(`[Notification Service] No phone number available to send WhatsApp alert for user: ${data.recipientId}`);
        }
      } catch (err: any) {
        logger.error(`[Notification Service] Failed to send WhatsApp notification: ${err.message}`);
      }
    })();

    return notification;
  },

  async getNotifications(recipientId: string) {
    return db.notification.findMany({
      where: { recipientId },
      orderBy: { createdAt: 'desc' },
    });
  },

  async getAllNotifications() {
    return db.notification.findMany({
      orderBy: { createdAt: 'desc' },
    });
  },

  async markAsRead(id: string, recipientId: string, isAdmin: boolean = false) {
    return db.notification.updateMany({
      where: isAdmin ? { id } : { id, recipientId },
      data: { read: true },
    });
  },

  async markAllAsRead(recipientId: string, isAdmin: boolean = false) {
    return db.notification.updateMany({
      where: isAdmin ? { read: false } : { recipientId, read: false },
      data: { read: true },
    });
  },
};
