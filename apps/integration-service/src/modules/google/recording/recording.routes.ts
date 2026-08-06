import { Router } from 'express';
import { GoogleRecordingController } from './recording.controller';

const router = Router();

router.get('/', GoogleRecordingController.list);
router.post('/sync', GoogleRecordingController.sync);
router.post('/link-url', GoogleRecordingController.linkDriveUrl);
router.get('/:id', GoogleRecordingController.get);
router.post('/:id/download', GoogleRecordingController.download);
router.get('/:id/stream', GoogleRecordingController.stream);
router.post('/:id/extract-audio', GoogleRecordingController.extractAudio);
router.get('/:id/transcript', GoogleRecordingController.getTranscriptContent);
router.delete('/:id', GoogleRecordingController.remove);

export default router;
