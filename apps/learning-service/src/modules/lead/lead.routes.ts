import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { leadController } from './lead.controller';
import { requireInternalAuth } from '../../middlewares/auth';

const router = Router();

// Public endpoint for lead registration (e.g. website demo booking & enquiries)
router.post('/', asyncHandler(leadController.create));

// Protected endpoints for lead management in admin dashboard
router.use(requireInternalAuth);
router.get('/',       asyncHandler(leadController.list));
router.get('/:id',    asyncHandler(leadController.getById));
router.put('/:id',    asyncHandler(leadController.update));
router.post('/:id/collect-payment', asyncHandler(leadController.collectPayment));
router.post('/:id/verify-payment',  asyncHandler(leadController.verifyPayment));
router.delete('/:id', asyncHandler(leadController.delete));

export const leadRoutes = router;

