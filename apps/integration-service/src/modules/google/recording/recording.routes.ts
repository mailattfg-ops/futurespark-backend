import { Router } from 'express';
import { GoogleRecordingController } from './recording.controller';

const router = Router();

router.get('/', GoogleRecordingController.list);
router.post('/sync', GoogleRecordingController.sync);
router.post('/link-url', GoogleRecordingController.linkDriveUrl);
router.get('/:id', GoogleRecordingController.get);
router.post('/:id/download', GoogleRecordingController.download);
// Authenticated at the gateway; hands back a short-lived signed link.
router.get('/:id/media-token', GoogleRecordingController.mediaToken);
// Public by necessity (a <video> cannot send headers) — guarded by that token.
router.get('/:id/stream', GoogleRecordingController.stream);
router.post('/:id/extract-audio', GoogleRecordingController.extractAudio);
router.get('/:id/transcript', GoogleRecordingController.getTranscriptContent);
router.delete('/:id', GoogleRecordingController.remove);

export default router;
