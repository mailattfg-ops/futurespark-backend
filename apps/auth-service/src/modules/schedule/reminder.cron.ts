import { logger } from '@futurespark/logger';
import db from '../../database/datasource';
import { notifyInternal, formatWhen, InternalNotifyContext } from '../shared/internal-notify';

/**
 * Internal reminders for the team: 24 hours, 1 hour and 10 minutes before a
 * class starts.
 *
 * Regular classes send `internal_session_reminder`; demos send
 * `internal_demo_reminder`. Both go to the schedulers and the class's mentor —
 * never to families, who have their own separate reminder path.
 *
 * ── Why a ledger column rather than a time window ─────────────────────────
 * A cron that fires "everything between 23h55m and 24h05m from now" loses a
 * reminder whenever a tick is missed — a restart, a deploy, a slow tick — and
 * sends twice whenever one runs late. `internalRemindersSent` records which
 * thresholds a class has already had, so a reminder is sent exactly once no
 * matter how the ticks fall.
 *
 * ── Why only the most urgent threshold is sent ────────────────────────────
 * A class booked twenty minutes before it starts has crossed all three
 * thresholds at once. Sending three messages for one class is noise, so the
 * tightest crossed threshold is the one that goes out and the looser ones are
 * marked as spent.
 */

/** Minutes before the class, loosest first. The label is what gets stored. */
const THRESHOLDS: { label: string; minutes: number }[] = [
  { label: '24h', minutes: 24 * 60 },
  { label: '1h', minutes: 60 },
  { label: '10m', minutes: 10 },
];

const TICK_MS = Number(process.env.INTERNAL_REMINDER_INTERVAL_MINUTES ?? 5) * 60 * 1000;
/** Keeps one backlog from monopolising a tick. */
const BATCH_SIZE = Number(process.env.INTERNAL_REMINDER_BATCH ?? 20);

let isRunning = false;

/** Grade, country and contact for a demo class, from whichever lead table holds it. */
const demoDetails = async (leadId: string | null): Promise<Partial<InternalNotifyContext>> => {
  if (!leadId) return {};
  try {
    const lead = await db.lead.findUnique({
      where: { id: leadId },
      select: { firstName: true, lastName: true, phone: true, studentFirstName: true, studentLastName: true },
    });
    if (lead) {
      return {
        studentName:
          `${lead.studentFirstName ?? ''} ${lead.studentLastName ?? ''}`.trim() ||
          `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim() ||
          'Demo student',
        parentContact: lead.phone ?? '-',
      };
    }
    // Pilot applications live in their own table and carry the richer fields.
    const pilot = await db.pilotLead.findUnique({
      where: { id: leadId },
      select: { studentName: true, studentGrade: true, presentCountry: true, parentPhone: true },
    });
    if (pilot) {
      return {
        studentName: pilot.studentName || 'Demo student',
        grade: pilot.studentGrade || '-',
        country: pilot.presentCountry || '-',
        parentContact: pilot.parentPhone || '-',
      };
    }
  } catch (err: any) {
    logger.warn(`[Internal Reminder] Could not read lead ${leadId}: ${err?.message ?? err}`);
  }
  return {};
};

const tick = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = Date.now();
    const horizon = new Date(now + THRESHOLDS[0].minutes * 60 * 1000);

    const classes = await db.scheduledClass.findMany({
      where: {
        status: 'SCHEDULED',
        startTime: { gt: new Date(now), lte: horizon },
      },
      select: {
        id: true,
        classType: true,
        startTime: true,
        meetingLink: true,
        leadId: true,
        mentorId: true,
        internalRemindersSent: true,
        // `sessionId` is a plain column here, not a relation — the curriculum
        // row is fetched separately below.
        sessionId: true,
        student: { select: { firstName: true, lastName: true, level: true, country: true } },
        mentor: { select: { firstName: true, lastName: true } },
      },
      orderBy: { startTime: 'asc' },
      take: BATCH_SIZE,
    });

    for (const cls of classes) {
      const minutesUntil = (cls.startTime.getTime() - now) / 60000;
      const crossed = THRESHOLDS.filter(
        (t) => minutesUntil <= t.minutes && !cls.internalRemindersSent.includes(t.label)
      );
      if (crossed.length === 0) continue;

      // Tightest crossed threshold is the one worth saying out loud.
      const due = crossed[crossed.length - 1];
      const isDemo = cls.classType === 'DEMO';
      const when = formatWhen(cls.startTime);
      const session = cls.sessionId
        ? await db.session.findUnique({ where: { id: cls.sessionId }, select: { title: true } })
        : null;

      const context: InternalNotifyContext = {
        studentName: `${cls.student?.firstName ?? ''} ${cls.student?.lastName ?? ''}`.trim() || 'Student',
        level: cls.student?.level ?? '-',
        country: cls.student?.country ?? '-',
        topic: session?.title ?? 'Class session',
        mentorName: `${cls.mentor?.firstName ?? ''} ${cls.mentor?.lastName ?? ''}`.trim() || 'Unassigned',
        meetingLink: cls.meetingLink ?? 'To be created',
        grade: '-',
        parentContact: '-',
        ...when,
        // The countdown says the threshold, not a re-derived duration: a tick a
        // couple of minutes late should still read "1 hour", not "57 minutes".
        startsIn: due.label === '24h' ? '24 hours' : due.label === '1h' ? '1 hour' : '10 minutes',
        ...(isDemo ? await demoDetails(cls.leadId) : {}),
      };

      await notifyInternal(isDemo ? 'DEMO_REMINDER' : 'SESSION_SCHEDULED', context, cls.mentorId);

      // Every crossed threshold is spent, not just the one sent — otherwise a
      // late-booked class would fire the looser ones on the following ticks.
      await db.scheduledClass.update({
        where: { id: cls.id },
        data: { internalRemindersSent: { push: crossed.map((t) => t.label) } },
      });
      logger.info(
        `[Internal Reminder] Class ${cls.id} — sent the ${due.label} reminder` +
          (crossed.length > 1 ? ` (also marking ${crossed.slice(0, -1).map((t) => t.label).join(', ')} as spent)` : '')
      );
    }
  } catch (err: any) {
    logger.error(`[Internal Reminder] Tick failed: ${err?.message ?? err}`);
  } finally {
    isRunning = false;
  }
};

export const startInternalReminderCron = (): void => {
  setInterval(tick, TICK_MS);
  setTimeout(tick, 20_000); // after boot has settled
  logger.info(`[Internal Reminder] Cron started — every ${TICK_MS / 60000} min, thresholds 24h / 1h / 10m.`);
};

/** Exported for the self-check: which thresholds a class is due, given its ledger. */
export const dueThresholds = (minutesUntil: number, alreadySent: string[]): string[] =>
  THRESHOLDS.filter((t) => minutesUntil <= t.minutes && !alreadySent.includes(t.label)).map((t) => t.label);
