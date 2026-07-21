import dotenv from 'dotenv';
import path from 'path';
import app from './app';
import { logger } from '@futurespark/logger';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const PORT = process.env.PORT || 3003;

app.listen(PORT, () => {
  logger.info(`communication-service server listening on port ${PORT}`);
});