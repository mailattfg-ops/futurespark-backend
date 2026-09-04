import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { partialLeadController } from './partial-lead.controller';
import { requireInternalAuth, requireRoles } from '../../middlewares/auth';

const router = Router();

// Public endpoints for partial form submission from landing page
router.post('/', asyncHandler(partialLeadController.savePartial));
router.post('/complete', asyncHandler(partialLeadController.completePartial));
router.get('/:id', asyncHandler(partialLeadController.getById));

// Protected endpoints for admin dashboard
router.use(requireInternalAuth, requireRoles(['ADMIN', 'SCHEDULER', 'ENROLLMENT_ADVISOR']));
router.get('/', asyncHandler(partialLeadController.list));
router.delete('/:id', asyncHandler(partialLeadController.delete));

export const partialLeadRoutes = router;
