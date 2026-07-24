import dotenv from 'dotenv';
import path from 'path';
import app from './app';
import { logger } from '@futurespark/logger';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const PORT = process.env.INTEGRATION_SERVICE_PORT || 3006;

app.listen(PORT, () => {
  logger.info(`integration-service server listening on port ${PORT}`);
});