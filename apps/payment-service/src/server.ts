import dotenv from 'dotenv';
import path from 'path';
import app from './app';
import { logger } from '@futurespark/logger';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const PORT = process.env.PAYMENT_SERVICE_PORT || 3004;

app.listen(PORT, () => {
  logger.info(`payment-service server listening on port ${PORT}`);
});