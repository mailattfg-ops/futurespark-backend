import { Router } from 'express';
import { ZoomPresenceController } from './presence.controller';

const router = Router();

router.get('/', ZoomPresenceController.getSnapshot);
router.post('/poll', ZoomPresenceController.pollNow);

export default router;
