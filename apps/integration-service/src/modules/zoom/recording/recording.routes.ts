import { Router } from 'express';
import { ZoomRecordingController } from './recording.controller';

const router = Router();

router.get('/', ZoomRecordingController.list);
router.post('/sync', ZoomRecordingController.sync);
router.get('/:id/stream', ZoomRecordingController.stream);
router.post('/:id/download', ZoomRecordingController.download);
router.post('/:id/extract-audio', ZoomRecordingController.extractAudio);
router.get('/:id', ZoomRecordingController.get);

export default router;
