import { Router } from 'express';
import { transcriptionController } from './transcription.controller';

const router = Router();

router.post('/transcribe', transcriptionController.transcribe);

export { router as transcriptionRoutes };
