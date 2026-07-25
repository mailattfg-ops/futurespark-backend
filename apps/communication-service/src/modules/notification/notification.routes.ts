import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { notificationController } from './notification.controller';

const router = Router();

router.post('/',        asyncHandler(notificationController.create));
router.get('/',         asyncHandler(notificationController.list));
router.put('/read-all', asyncHandler(notificationController.markAllRead));
router.put('/:id/read', asyncHandler(notificationController.markRead));

export const notificationRoutes = router;
