import dotenv from 'dotenv';
import app from './app';
import { logger } from '@futurespark/logger';

dotenv.config();

const PORT = process.env.PORT || 3005;

app.listen(PORT, () => {
  logger.info(`analytics-service server listening on port ${PORT}`);
});