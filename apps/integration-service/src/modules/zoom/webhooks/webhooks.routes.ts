import { Router } from 'express';
import { ZoomWebhooksController } from './webhooks.controller';

const router = Router();

router.post('/', ZoomWebhooksController.handleWebhook);

export default router;
