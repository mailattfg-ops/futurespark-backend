import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { notificationController } from './notification.controller';

const router = Router();

/**
 * Authorization for these routes lives in the CONTROLLER, not in middleware
 * here, because each handler derives a different decision from the same
 * `x-user-id` / `x-user-role` headers the gateway injects (own-vs-all for the
 * reads, a role allowlist for the write). Adding a blanket middleware would
 * duplicate that logic and let the two drift apart.
 *
 *   POST /            role-gated (see notificationController.create) — this one
 *                     triggers a BILLED WhatsApp send to a real phone number.
 *   GET  /            requires identity; ADMIN sees all, everyone else sees own.
 *   PUT  /read-all    requires identity; scoped to own unless ADMIN.
 *   PUT  /:id/read    requires identity; scoped to own unless ADMIN.
 */
router.post('/',        asyncHandler(notificationController.create));
router.get('/',         asyncHandler(notificationController.list));
router.put('/read-all', asyncHandler(notificationController.markAllRead));
router.put('/:id/read', asyncHandler(notificationController.markRead));

export const notificationRoutes = router;
