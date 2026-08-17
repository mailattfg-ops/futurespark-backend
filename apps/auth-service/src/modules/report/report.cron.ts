import { logger } from '@futurespark/logger';
import db from '../../database/datasource';
import { markMeetingClassCompleted } from '../calendar-helper';
import { MAX_REPORT_ATTEMPTS, reportService } from './report.service';

/**
 * The post-class pipeline, seen from auth-service.
 *
 * The full journey of one class:
 *
 *   mentor presses "Completed"          → status COMPLETED, completedAt stamped,
 *                                         integration-service told
 *   +90 min (RECORDING_SEARCH_DELAY)    → integration-service searches Drive once
 *   Drive hit                           → download, extract audio, Groq transcribe
 *                                         and summarise, write classSummary here
 *   this cron sees a summary            → render the PDF, WhatsApp it to the parent,
 *                                         stamp reportSentAt
 *
 * Only the last step lives here, plus a small backstop for the first. The two
 * middle steps belong to integration-service and learning-service, which own
 * Drive and Groq respectively.
 */

const TICK_MS = Number(process.env.REPORT_CRON_INTERVAL_MINUTES ?? 5) * 60 * 1000;

/**
 * How long after sign-off a class stops being a candidate. Past this it is
 * almost certainly a class that was never recorded, and re-querying it forever
 * is just load.
 */
const REPORT_MAX_AGE_MS = Number(process.env.REPORT_MAX_AGE_HOURS ?? 72) * 60 * 60 * 1000;

/** How many reports one tick will send. Keeps a backlog from monopolising the process. */
const BATCH_SIZE = Number(process.env.REPORT_BATCH_SIZE ?? 5);

let isRunning = false;

/**
 * Re-drive the "class completed" signal to integration-service.
 *
 * `completeClass` already sends it inline, but that call is fire-and-forget and
 * fails silently if integration-service happens to be restarting at that second
 * — and a missed signal means the recording is never searched for, which is
 * invisible until a parent asks where their report is.
 *
 * The band is deliberately narrow: only classes signed off between 10 and 25
 * minutes ago. That is wide enough for a 5-minute tick to catch every class two
 * or three times even if a tick is missed, and it closes long before the Drive
 * search would start at +90 minutes. The receiving endpoint is idempotent — it
 * never overwrites an existing timestamp — so a repeat is free.
 */
const redriveCompletionSignals = async (): Promise<void> => {
  const now = Date.now();
  const classes = await db.scheduledClass.findMany({
    where: {
      status: 'COMPLETED',
      classSummary: null,
      completedAt: {
        gt: new Date(now - 25 * 60 * 1000),
        lt: new Date(now - 10 * 60 * 1000),
      },
    },
    select: { id: true, meetingLink: true, studentId: true, sessionId: true, programId: true, startTime: true, completedAt: true },
    take: 25,
  });

  if (classes.length === 0) return;

  logger.info(`[Report Cron] Re-confirming the completion signal for ${classes.length} recently finished class(es).`);

  for (const c of classes) {
    await markMeetingClassCompleted({
      meetingLink: c.meetingLink,
      studentId: c.studentId,
      sessionId: c.sessionId,
      programId: c.programId,
      startTime: c.startTime,
      completedAt: c.completedAt,
    });
  }
};

/** Send whatever is ready. */
const sendDueReports = async (): Promise<void> => {
  const horizon = new Date(Date.now() - REPORT_MAX_AGE_MS);

  const due = await db.scheduledClass.findMany({
    where: {
      status: 'COMPLETED',
      reportSentAt: null,
      reportAttempts: { lt: MAX_REPORT_ATTEMPTS },
      completedAt: { not: null, gt: horizon },
      // The summary is the trigger. Its arrival is what makes a class reportable,
      // and nothing else in this pipeline waits on a timer.
      classSummary: { not: null },
      studentId: { not: null },
    },
    orderBy: { completedAt: 'asc' },
    select: { id: true },
    take: BATCH_SIZE,
  });

  if (due.length === 0) return;

  logger.info(`[Report Cron] ${due.length} class report(s) ready to send.`);

  // Sequential on purpose. Each report renders a PDF and uploads it to Meta, and
  // Meta rate-limits per phone number id — five of these at once buys nothing
  // and risks a 130429 that would burn a retry on every one of them.
  for (const { id } of due) {
    try {
      const outcome = await reportService.sendClassReport(id);
      if (!outcome.sent && outcome.skippedReason) {
        logger.info(`[Report Cron] Skipped class ${id}: ${outcome.skippedReason}`);
      }
    } catch (err: any) {
      logger.error(`[Report Cron] Unhandled error sending the report for class ${id}: ${err.message}`);
    }
  }
};

/**
 * Mark classes that will never get a report, once.
 *
 * Without this a class whose recording never appeared simply drops out of the
 * query at the age horizon and nobody ever learns why the parent got nothing.
 * `reportLastError: null` in the filter is what makes it once-only.
 */
const markExpiredReports = async (): Promise<void> => {
  const horizon = new Date(Date.now() - REPORT_MAX_AGE_MS);

  const { count } = await db.scheduledClass.updateMany({
    where: {
      status: 'COMPLETED',
      reportSentAt: null,
      reportLastError: null,
      classSummary: null,
      completedAt: { not: null, lt: horizon },
    },
    data: {
      reportLastError:
        '[NO_RECORDING] No class recording was ever found on Drive, so no summary and no parent ' +
        'report could be produced. Link the recording by hand to generate it.',
    },
  });

  if (count > 0) {
    logger.warn(
      `[Report Cron] ${count} completed class(es) passed the ${Math.round(REPORT_MAX_AGE_MS / 3_600_000)}h ` +
        'horizon with no recording found. No report went to those parents.'
    );
  }
};

const tick = async (): Promise<void> => {
  if (isRunning) {
    logger.warn('[Report Cron] Previous pass is still running — skipping this tick.');
    return;
  }
  isRunning = true;

  try {
    await redriveCompletionSignals();
    // Disabled: Do not send parent report / transcript whatsapp message automatically.
    // Dispatch is now handled manually by the admin from the dashboard.
    // await sendDueReports();
    await markExpiredReports();
  } catch (err: any) {
    logger.error(`[Report Cron] Pass failed: ${err.message}`);
  } finally {
    // In `finally` — an early throw would otherwise wedge the flag on and stop
    // the daemon for the lifetime of the process.
    isRunning = false;
  }
};

export const startPostClassReportCron = (): void => {
  if (process.env.REPORT_CRON_ENABLED === 'false') {
    logger.warn('[Report Cron] Disabled by REPORT_CRON_ENABLED=false — no parent reports will be sent.');
    return;
  }

  const minutes = Math.round(TICK_MS / 60_000);
  logger.info(
    `[Report Cron] Starting the post-class parent report daemon (every ${minutes} min, ` +
      `up to ${BATCH_SIZE} report(s) per pass, ${MAX_REPORT_ATTEMPTS} attempts each).`
  );

  // Not immediately on boot: a deploy restarts every service at once, and
  // integration-service may not be accepting connections yet.
  setTimeout(() => void tick(), 30_000);
  setInterval(() => void tick(), TICK_MS);
};
