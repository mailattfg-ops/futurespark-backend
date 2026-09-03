import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { roleController } from './role.controller';
import { requireRole } from '../../middlewares/identity';

const router = Router();

// The role/permission matrix is a map of the castle — staff dropdowns may read
// it, only ADMIN reshapes it.
const STAFF_VIEW = ['ADMIN', 'SCHEDULER', 'FINANCE_ADMIN', 'QA_AUDITOR', 'WAREHOUSE_ADMIN', 'ENROLLMENT_ADVISOR'];

router.get('/',       requireRole(...STAFF_VIEW), asyncHandler(roleController.list));
router.post('/',      requireRole('ADMIN'), asyncHandler(roleController.create));
router.get('/:id',    requireRole(...STAFF_VIEW), asyncHandler(roleController.getById));
router.put('/:id',    requireRole('ADMIN'), asyncHandler(roleController.update));
router.delete('/:id', requireRole('ADMIN'), asyncHandler(roleController.delete));

export const roleRoutes = router;
