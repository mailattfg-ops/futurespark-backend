import dotenv from 'dotenv';
import app from './app';
import { logger } from '@futurespark/logger';

dotenv.config();

const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  logger.info(`learning-service server listening on port ${PORT}`);
});