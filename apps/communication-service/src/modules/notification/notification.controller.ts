import { Request, Response } from 'express';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { notificationService } from './notification.service';

/**
 * Roles allowed to create a notification for an ARBITRARY recipientId.
 * Overridable (comma-separated) without a redeploy, because widening this is
 * the fix if a legitimate internal role starts getting 403s.
 */
const DEFAULT_CREATE_ROLES = ['ADMIN'];

const createRoles = (): Set<string> => {
  const raw = (process.env.NOTIFICATION_CREATE_ROLES || '')
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
  return new Set(raw.length > 0 ? raw : DEFAULT_CREATE_ROLES);
};

export const notificationController = {
  /**
   * POST /notifications — creates an in-app notification AND triggers a
   * WhatsApp send to whatever phone number is on file for `recipientId`.
   *
   * Authorization, read from the same `x-user-*` headers the sibling handlers
   * use (the gateway's `authenticate` HMAC-signs and injects them on every
   * end-user request):
   *
   *   - identity headers PRESENT  => an end user reached us through the
   *     gateway. Require a privileged role. Without this, any logged-in user
   *     could send WhatsApp messages (billed, to real families) to any
   *     recipientId they can guess.
   *   - identity headers ABSENT   => an in-cluster service-to-service call.
   *     The gateway always injects them, so their absence cannot come from a
   *     gateway request. auth-service's notification-helper.ts posts here with
   *     no headers at all, and blocking it would silently kill every schedule
   *     and account notification, so this path stays open.
   *
   * KNOWN GAP (not fixable from this file): the absent-headers path trusts the
   * network perimeter, and this service does not call `verifyInternalHeaders`,
   * so a caller with direct access to port 3003 can bypass the role check by
   * omitting the headers — exactly as it could today by forging
   * `x-user-role: ADMIN`. The real fix is to verify the HMAC internal headers
   * service-wide and give notification-helper.ts a signed service identity.
   */
  async create(req: Request, res: Response) {
    const callerId = req.headers['x-user-id'] as string | undefined;
    const callerRole = req.headers['x-user-role'] as string | undefined;

    if (callerId) {
      if (!createRoles().has((callerRole || '').toUpperCase())) {
        logger.warn(
          `[Notification] FORBIDDEN create attempt by user=${callerId} role=${callerRole || '-'}`
        );
        // Deliberately generic: a distinct message per reason would leak back
        // the same recipient information this endpoint just stopped echoing.
        return res
          .status(HTTP_STATUS.FORBIDDEN)
          .json(errorResponse('Forbidden: you are not allowed to create notifications'));
      }
    } else {
      logger.debug('[Notification] create with no identity headers — treating as internal service call.');
    }

    const { recipientId, title, message, priority } = req.body;
    if (!recipientId || !title || !message) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('recipientId, title, and message are required'));
    }
    const notification = await notificationService.createNotification({ recipientId, title, message, priority });
    logger.info(`[Notification] Created alert for recipient: ${recipientId} (by ${callerId || 'internal'})`);
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
