import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { scheduleController } from './schedule.controller';

const router = Router();

router.get('/mentors', asyncHandler(scheduleController.listMentors));
// Internal, service-to-service: the presence poller reporting an emptied room.
// Not exposed through the gateway.
router.post('/internal/room-ended', asyncHandler(scheduleController.markRoomEnded));
// Static prefix, so "students" is never matched as a class id by "/:id".
router.get('/students/:studentId/overview', asyncHandler(scheduleController.getStudentOverview));
router.get('/reports', asyncHandler(scheduleController.listReports));
router.post('/reports', asyncHandler(scheduleController.createReport));
router.put('/reports/:id', asyncHandler(scheduleController.updateReport));
router.get('/',       asyncHandler(scheduleController.list));
router.post('/',      asyncHandler(scheduleController.create));
router.put('/:id/complete', asyncHandler(scheduleController.completeClass));
router.post('/:id/rate', asyncHandler(scheduleController.rateClass));
router.get('/:id/reflection', asyncHandler(scheduleController.getReflection));
router.post('/:id/reflection', asyncHandler(scheduleController.submitReflection));
router.get('/:id',    asyncHandler(scheduleController.getById));
router.put('/:id',    asyncHandler(scheduleController.update));
router.delete('/:id', asyncHandler(scheduleController.delete));

export const scheduleRoutes = router;
