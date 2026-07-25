import db from '../../database/datasource';

export const notificationService = {
  async createNotification(data: { recipientId: string; title: string; message: string; priority: string }) {
    return db.notification.create({
      data: {
        recipientId: data.recipientId,
        title: data.title,
        message: data.message,
        priority: data.priority || 'LOW',
      },
    });
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
