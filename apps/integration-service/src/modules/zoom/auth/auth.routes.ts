import { Router } from 'express';
import { ZoomAuthController } from './auth.controller';

const router = Router();

router.get('/connect', ZoomAuthController.connectWorkspace);
router.get('/callback', ZoomAuthController.callback);
router.post('/disconnect', ZoomAuthController.disconnectWorkspace);
router.get('/status', ZoomAuthController.status);

export default router;
