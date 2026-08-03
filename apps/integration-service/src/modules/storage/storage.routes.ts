import { Router } from 'express';
import multer from 'multer';
import { StorageController } from './storage.controller';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload', upload.single('file'), StorageController.upload);
router.get('/file', StorageController.getFile);

export default router;
