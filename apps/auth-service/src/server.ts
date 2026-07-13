import dotenv from 'dotenv';
import app from './app';
import { logger } from '@futurespark/logger';

dotenv.config();

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  logger.info(`Auth Service server listening on port ${PORT}`);
});
