import { Router } from 'express';
import { ZoomMeetingsController } from './meetings.controller';

const router = Router();

router.post('/', ZoomMeetingsController.create);
router.get('/', ZoomMeetingsController.list);
router.put('/by-link', ZoomMeetingsController.rescheduleByLink);
router.get('/:id', ZoomMeetingsController.get);
router.put('/:id', ZoomMeetingsController.update);
router.delete('/by-link', ZoomMeetingsController.deleteByLink);
router.delete('/:id', ZoomMeetingsController.delete);

export default router;
