import './load-env'; // must stay first — populates process.env before ./app loads
import app from './app';
import { logger } from '@futurespark/logger';
import { startPostClassReportCron } from './modules/report/report.cron';
import { startInternalReminderCron } from './modules/schedule/reminder.cron';


const PORT = process.env.AUTH_SERVICE_PORT || 3001;

app.listen(PORT, () => {
  logger.info(`Auth Service server listening on port ${PORT}`);

  // Started here rather than in app.ts on purpose. `import app from './app'` is
  // hoisted above the dotenv.config() calls above, so anything app.ts evaluates
  // at module load sees an empty environment — a cron started there would read
  // its intervals and service URLs as undefined.
  startPostClassReportCron();
  // Internal team reminders: 24h / 1h / 10m before each class.
  startInternalReminderCron();
});
