import { Router } from 'express';
import { GoogleMeetingsController } from './meetings.controller';

const router = Router();

router.post('/', GoogleMeetingsController.create);
router.get('/', GoogleMeetingsController.list);
// Must precede '/:id', otherwise the param route swallows "by-link".
router.put('/by-link', GoogleMeetingsController.rescheduleByLink);
router.get('/:id', GoogleMeetingsController.get);
router.put('/:id', GoogleMeetingsController.update);
router.post('/sync-manual', GoogleMeetingsController.syncManual);
router.delete('/by-link', GoogleMeetingsController.deleteByLink);
router.delete('/:id', GoogleMeetingsController.delete);

export default router;
