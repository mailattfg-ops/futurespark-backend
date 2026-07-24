import { Router } from 'express';
import { GoogleRecordingController } from './recording.controller';

const router = Router();

router.get('/', GoogleRecordingController.list);
router.post('/sync', GoogleRecordingController.sync);
router.get('/:id', GoogleRecordingController.get);
router.post('/:id/download', GoogleRecordingController.download);
router.get('/:id/stream', GoogleRecordingController.stream);
router.post('/:id/extract-audio', GoogleRecordingController.extractAudio);
router.get('/:id/transcript', GoogleRecordingController.getTranscriptContent);

export default router;
