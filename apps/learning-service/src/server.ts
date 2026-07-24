import dotenv from 'dotenv';
import path from 'path';
import app from './app';
import { logger } from '@futurespark/logger';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const PORT = process.env.LEARNING_SERVICE_PORT || 3002;

app.listen(PORT, () => {
  logger.info(`learning-service server listening on port ${PORT}`);
});