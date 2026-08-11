import { Router } from 'express';
import { verifyMetaWebhookSignature, whatsappWebhookController } from './whatsapp.controller';

const router = Router();

// GET: Webhook verification handshake by Meta (hub.mode / hub.verify_token / hub.challenge).
// Unsigned by design — Meta does not sign the handshake — so it is guarded by the
// verify token only, and the handler refuses when that token is unconfigured.
router.get('/', whatsappWebhookController.verify);

// POST: Incoming messages and delivery status events from Meta.
// The X-Hub-Signature-256 HMAC is verified over the RAW body before the handler
// runs; the raw Buffer is supplied by the express.raw() mount in app.ts.
router.post('/', verifyMetaWebhookSignature, whatsappWebhookController.handleEvent);

export { router as whatsappWebhookRoutes };
