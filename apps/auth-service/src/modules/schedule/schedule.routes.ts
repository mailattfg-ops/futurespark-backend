import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { scheduleController } from './schedule.controller';

const router = Router();

router.get('/mentors', asyncHandler(scheduleController.listMentors));
router.get('/reports', asyncHandler(scheduleController.listReports));
router.post('/reports', asyncHandler(scheduleController.createReport));
router.put('/reports/:id', asyncHandler(scheduleController.updateReport));
router.get('/',       asyncHandler(scheduleController.list));
router.post('/',      asyncHandler(scheduleController.create));
router.put('/:id/complete', asyncHandler(scheduleController.completeClass));
router.get('/:id',    asyncHandler(scheduleController.getById));
router.put('/:id',    asyncHandler(scheduleController.update));
router.delete('/:id', asyncHandler(scheduleController.delete));

export const scheduleRoutes = router;
