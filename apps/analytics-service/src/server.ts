import dotenv from 'dotenv';
import path from 'path';
import app from './app';
import { logger } from '@futurespark/logger';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const PORT = process.env.ANALYTICS_SERVICE_PORT || 3005;

app.listen(PORT, () => {
  logger.info(`analytics-service server listening on port ${PORT}`);
});