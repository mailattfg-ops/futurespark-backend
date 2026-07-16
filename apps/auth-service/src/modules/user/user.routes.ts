import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { userController } from './user.controller';

const router = Router();

router.get('/',       asyncHandler(userController.list));
router.post('/',      asyncHandler(userController.create));
router.get('/:id',    asyncHandler(userController.getById));
router.put('/:id',    asyncHandler(userController.update));
router.put('/:id/reset-password', asyncHandler(userController.resetPassword));
router.delete('/:id', asyncHandler(userController.delete));

export const userRoutes = router;