import { Request, Response } from 'express';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { notificationService } from './notification.service';

export const notificationController = {
  async create(req: Request, res: Response) {
    const { recipientId, title, message, priority } = req.body;
    if (!recipientId || !title || !message) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('recipientId, title, and message are required'));
    }
    const notification = await notificationService.createNotification({ recipientId, title, message, priority });
    logger.info(`[Notification] Created alert for recipient: ${recipientId}`);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(notification, 'Notification created successfully'));
  },

  async list(req: Request, res: Response) {
    const recipientId = req.headers['x-user-id'] as string;
    const userRole = req.headers['x-user-role'] as string;
    if (!recipientId) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json(errorResponse('Unauthorized: Missing user header'));
    }

    let notifications;
    if (userRole === 'ADMIN') {
      notifications = await notificationService.getAllNotifications();
    } else {
      notifications = await notificationService.getNotifications(recipientId);
    }

    return res.status(HTTP_STATUS.OK).json(successResponse(notifications, 'Notifications fetched successfully'));
  },

  async markRead(req: Request, res: Response) {
    const recipientId = req.headers['x-user-id'] as string;
    const userRole = req.headers['x-user-role'] as string;
    const { id } = req.params;
    if (!recipientId) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json(errorResponse('Unauthorized'));
    }
    const isAdmin = userRole === 'ADMIN';
    await notificationService.markAsRead(id, recipientId, isAdmin);
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Notification marked as read'));
  },

  async markAllRead(req: Request, res: Response) {
    const recipientId = req.headers['x-user-id'] as string;
    const userRole = req.headers['x-user-role'] as string;
    if (!recipientId) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json(errorResponse('Unauthorized'));
    }
    const isAdmin = userRole === 'ADMIN';
    await notificationService.markAllAsRead(recipientId, isAdmin);
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'All notifications marked as read'));
  },
};
