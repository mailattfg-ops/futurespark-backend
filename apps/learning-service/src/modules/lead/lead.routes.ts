import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { leadController } from './lead.controller';

const router = Router();

router.get('/',       asyncHandler(leadController.list));
router.post('/',      asyncHandler(leadController.create));
router.get('/:id',    asyncHandler(leadController.getById));
router.put('/:id',    asyncHandler(leadController.update));
router.delete('/:id', asyncHandler(leadController.delete));

export const leadRoutes = router;
