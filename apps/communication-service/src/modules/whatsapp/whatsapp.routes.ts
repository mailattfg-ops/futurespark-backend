import { Router } from 'express';
import { whatsappWebhookController } from './whatsapp.controller';

const router = Router();

// GET: Webhook verification by Meta
router.get('/', whatsappWebhookController.verify);

// POST: Incoming messages and delivery status events from Meta
router.post('/', whatsappWebhookController.handleEvent);

export { router as whatsappWebhookRoutes };
