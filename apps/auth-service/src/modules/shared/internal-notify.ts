import { db } from '../../database/datasource';
import { logger } from '@futurespark/logger';

/**
 * Ops pings to the internal team when the calendar changes.
 *
 * Recipients are staff WHATSAPP NUMBERS held on `User.phone` — the schedulers
 * who run the timetable, plus the mentor teaching the class. Families are
 * never messaged from here; their reminders are a separate, audience-gated
 * path.
 *
 * Fire-and-forget by construction: a booking must never fail because Meta is
 * slow or a number is missing, so every caller drops this into the background
 * and nothing here throws.
 */
const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://127.0.0.1:3003';

export type InternalNotifyKind =
  | 'SESSION_SCHEDULED'
  | 'SESSION_RESCHEDULED'
  | 'DEMO_SCHEDULED'
  | 'DEMO_RESCHEDULED'
  | 'DEMO_REMINDER';

export interface InternalNotifyContext {
  studentName?: string;
  level?: string;
  /** "in 2 days" / "in 3 hours" — follows "begins in" in the approved body. */
  startsIn?: string;
  topic?: string;
  date?: string;
  time?: string;
  mentorName?: string;
  meetingLink?: string;
  grade?: string;
  country?: string;
  parentContact?: string;
}

/**
 * Everyone who should hear about a calendar change: every ADMIN/SCHEDULER with
 * a number on file, plus this class's mentor. Deduplicated, because one person
 * holding two roles should get one message.
 */
const recipientsFor = async (mentorId?: string | null): Promise<string[]> => {
  const [staff, mentor] = await Promise.all([
    db.user.findMany({
      where: {
        isActive: true,
        phone: { not: null },
        role: { name: { in: ['ADMIN', 'SCHEDULER'] } },
      },
      select: { phone: true },
    }),
    mentorId
      ? db.user.findUnique({ where: { id: mentorId }, select: { phone: true, isActive: true } })
      : Promise.resolve(null),
  ]);

  const numbers = staff.map((s) => s.phone).filter((p): p is string => !!p && !!p.trim());
  if (mentor?.phone?.trim() && mentor.isActive) numbers.push(mentor.phone);
  return [...new Set(numbers.map((n) => n.trim()))];
};

export const notifyInternal = async (
  kind: InternalNotifyKind,
  context: InternalNotifyContext,
  mentorId?: string | null
): Promise<void> => {
  try {
    const recipients = await recipientsFor(mentorId);
    if (recipients.length === 0) {
      logger.info(`[Internal Notify] ${kind} — no staff number on file; nothing to send.`);
      return;
    }
    const res = await fetch(`${COMMUNICATION_SERVICE_URL}/whatsapp/internal-notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, context, recipients }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn(`[Internal Notify] ${kind} — communication-service answered ${res.status}`);
    }
  } catch (err: any) {
    logger.warn(`[Internal Notify] ${kind} failed: ${err?.message ?? err}`);
  }
};

/**
 * Date, time and the "begins in" phrase, as the team reads them.
 *
 * `startsIn` fills the template's "begins in {{n}}" slot. A class booked weeks
 * out reads "in 3 weeks"; one starting shortly reads "in 25 minutes". Already
 * past reads "now" rather than a negative.
 */
export const formatWhen = (start: Date, timeZone = 'Asia/Kolkata') => {
  const ms = start.getTime() - Date.now();
  const mins = Math.round(ms / 60000);
  let startsIn = 'now';
  if (mins > 0) {
    if (mins < 60) startsIn = `${mins} minute${mins === 1 ? '' : 's'}`;
    else if (mins < 60 * 24) {
      const h = Math.round(mins / 60);
      startsIn = `${h} hour${h === 1 ? '' : 's'}`;
    } else {
      const d = Math.round(mins / (60 * 24));
      startsIn = d < 14 ? `${d} day${d === 1 ? '' : 's'}` : `${Math.round(d / 7)} weeks`;
    }
  }
  return {
    date: start.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone }),
    time: start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }),
    startsIn,
  };
};
