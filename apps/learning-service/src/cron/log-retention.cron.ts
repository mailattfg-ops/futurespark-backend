import { logger } from '@futurespark/logger';
import db from '../database/datasource';

/**
 * Retention for the observability tables.
 *
 * Policy: activity events (AuditLog) and AI errors (ErrorLog) are kept for AT
 * LEAST one month — the configured window is clamped to a 31-day floor so a
 * misconfigured env can never violate that. Default is 45 days. The AI usage
 * ledger (AiUsage) keeps a year by default, because /costs totals are money
 * history and a month of spend context is not enough to spot a trend.
 *
 * Runs in learning-service because its Prisma client spans both the auth and
 * learning schemas, so one daily pass covers all three tables.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const startLogRetentionCron = (): void => {
  if (process.env.LOG_RETENTION_ENABLED === 'false') {
    logger.warn('[LogRetention] Disabled by LOG_RETENTION_ENABLED=false — the log tables will grow unbounded.');
    return;
  }

  const auditDays = Math.max(31, Number(process.env.AUDIT_RETENTION_DAYS) || 45);
  const usageDays = Math.max(31, Number(process.env.AI_USAGE_RETENTION_DAYS) || 365);

  const tick = async () => {
    try {
      const auditCutoff = new Date(Date.now() - auditDays * DAY_MS);
      const usageCutoff = new Date(Date.now() - usageDays * DAY_MS);

      const [audit, errors, usage] = await Promise.all([
        db.auditLog.deleteMany({ where: { occurredAt: { lt: auditCutoff } } }),
        db.errorLog.deleteMany({ where: { occurredAt: { lt: auditCutoff } } }),
        db.aiUsage.deleteMany({ where: { createdAt: { lt: usageCutoff } } }),
      ]);

      const total = audit.count + errors.count + usage.count;
      if (total > 0) {
        logger.info(
          `[LogRetention] Pruned ${audit.count} activity event(s), ${errors.count} AI error(s) ` +
            `(older than ${auditDays}d) and ${usage.count} usage row(s) (older than ${usageDays}d).`
        );
      }
    } catch (err: any) {
      logger.error(`[LogRetention] Prune failed: ${err.message}`);
    }
  };

  logger.info(
    `[LogRetention] Keeping activity events + AI errors for ${auditDays} days and the AI usage ` +
      `ledger for ${usageDays} days (pruned daily).`
  );

  // First pass shortly after boot, then daily.
  setTimeout(() => void tick(), 90_000);
  setInterval(() => void tick(), DAY_MS);
};
