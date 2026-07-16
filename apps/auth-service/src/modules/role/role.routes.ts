import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { roleController } from './role.controller';

const router = Router();

router.get('/',       asyncHandler(roleController.list));
router.post('/',      asyncHandler(roleController.create));
router.get('/:id',    asyncHandler(roleController.getById));
router.put('/:id',    asyncHandler(roleController.update));
router.delete('/:id', asyncHandler(roleController.delete));

export const roleRoutes = router;
