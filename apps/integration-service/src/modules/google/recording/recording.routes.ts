import { Router } from 'express';
import { GoogleRecordingController } from './recording.controller';

const router = Router();

// ── Static paths first ───────────────────────────────────────────────────────
// Anything declared after "/:id" is swallowed by it: Express matches in order,
// so "/for-class" would be handled as a lookup for a recording whose id is
// literally "for-class" and 404.

// One class's recordings, unlocked by a grant signed by auth-service. This is
// how students and parents reach their own media without the unscoped list.
router.get('/for-class', GoogleRecordingController.forClass);

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
