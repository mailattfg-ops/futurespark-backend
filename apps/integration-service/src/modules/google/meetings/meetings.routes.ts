import { Router } from 'express';
import { GoogleMeetingsController } from './meetings.controller';

const router = Router();

router.post('/', GoogleMeetingsController.create);
router.get('/', GoogleMeetingsController.list);
router.get('/:id', GoogleMeetingsController.get);
router.put('/:id', GoogleMeetingsController.update);
router.post('/sync-manual', GoogleMeetingsController.syncManual);
router.delete('/:id', GoogleMeetingsController.delete);

export default router;
