import { Router } from 'express';
import { bindRecording, unbindRecording } from '../../shared/recording-bind.controller';
import { ZoomRecordingController } from './recording.controller';

const router = Router();

router.get('/for-class', ZoomRecordingController.forClass);

router.get('/', ZoomRecordingController.list);
router.post('/sync', ZoomRecordingController.sync);
router.get('/:id', ZoomRecordingController.get);
// Manual attribution — attach/detach a recording to a class (staff only).
router.post('/:id/bind', bindRecording);
router.post('/:id/unbind', unbindRecording);
router.post('/:id/download', ZoomRecordingController.download);
router.get('/:id/media-token', ZoomRecordingController.mediaToken);
router.get('/:id/stream', ZoomRecordingController.stream);
router.post('/:id/extract-audio', ZoomRecordingController.extractAudio);
router.get('/:id/transcript', ZoomRecordingController.getTranscriptContent);
router.delete('/:id', ZoomRecordingController.remove);

export default router;
