import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { authController } from './auth.controller';

const router = Router();

router.post('/register',     asyncHandler(authController.register));
router.post('/login',        asyncHandler(authController.login));
router.post('/refresh',      asyncHandler(authController.refresh));
router.post('/logout',       asyncHandler(authController.logout));
router.post('/complete-ftl', asyncHandler(authController.completeFtl));

export const authRoutes = router;
