import dotenv from 'dotenv';
import app from './app';
import { logger } from '@futurespark/logger';

dotenv.config();

const PORT = process.env.PORT || 3004;

app.listen(PORT, () => {
  logger.info(`payment-service server listening on port ${PORT}`);
});