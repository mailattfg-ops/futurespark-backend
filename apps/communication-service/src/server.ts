import dotenv from 'dotenv';
import app from './app';
import { logger } from '@futurespark/logger';

dotenv.config();

const PORT = process.env.PORT || 3003;

app.listen(PORT, () => {
  logger.info(`communication-service server listening on port ${PORT}`);
});