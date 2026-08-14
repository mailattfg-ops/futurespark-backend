import dotenv from 'dotenv';
import path from 'path';
import app from './app';
import { logger } from '@futurespark/logger';
import { startPostClassReportCron } from './modules/report/report.cron';

// Load root backend/.env first (shared DB URLs, JWT secrets, etc.)
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
// Load service-specific .env (PORT, NODE_ENV) — overrides root if keys clash
dotenv.config();

const PORT = process.env.AUTH_SERVICE_PORT || 3001;

app.listen(PORT, () => {
  logger.info(`Auth Service server listening on port ${PORT}`);

  // Started here rather than in app.ts on purpose. `import app from './app'` is
  // hoisted above the dotenv.config() calls above, so anything app.ts evaluates
  // at module load sees an empty environment — a cron started there would read
  // its intervals and service URLs as undefined.
  startPostClassReportCron();
});
