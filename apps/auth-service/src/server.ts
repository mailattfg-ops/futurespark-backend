import dotenv from 'dotenv';
import path from 'path';
import app from './app';
import { logger } from '@futurespark/logger';

// Load root backend/.env first (shared DB URLs, JWT secrets, etc.)
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
// Load service-specific .env (PORT, NODE_ENV) — overrides root if keys clash
dotenv.config();

const PORT = process.env.AUTH_SERVICE_PORT || 3001;

app.listen(PORT, () => {
  logger.info(`Auth Service server listening on port ${PORT}`);
});
