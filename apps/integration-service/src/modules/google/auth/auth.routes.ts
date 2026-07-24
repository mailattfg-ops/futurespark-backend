import { Router } from 'express';
import { GoogleAuthController } from './auth.controller';

const router = Router();

router.get('/connect', GoogleAuthController.connectWorkspace);
router.get('/callback', GoogleAuthController.callback);
router.post('/disconnect', GoogleAuthController.disconnectWorkspace);

export default router;
