import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { leadController } from './lead.controller';
import { requireInternalAuth, requireRoles } from '../../middlewares/auth';

const router = Router();

// Public endpoints for lead registration & demo class portal lookup by leadId
router.post('/',    asyncHandler(leadController.create));
router.get('/:id',   asyncHandler(leadController.getById));

// Protected endpoints for lead management in admin dashboard.
// requireInternalAuth alone let ANY signed role through — a student token via
// /api/courses/leads could list every lead. Sales/ops roles only.
router.use(requireInternalAuth, requireRoles(['ADMIN', 'SCHEDULER', 'ENROLLMENT_ADVISOR']));
router.get('/',       asyncHandler(leadController.list));
router.put('/:id',    asyncHandler(leadController.update));
router.post('/:id/collect-payment', asyncHandler(leadController.collectPayment));
router.post('/:id/verify-payment',  asyncHandler(leadController.verifyPayment));
router.delete('/:id', asyncHandler(leadController.delete));

export const leadRoutes = router;

