/**
 * Internal ops pings — the Meta-approved `internal_*` templates that tell the
 * scheduling team and mentors what just landed on the calendar.
 *
 * ── THE ONE RULE THAT MATTERS ──────────────────────────────────────────────
 * Meta matches body variables BY POSITION and rejects a wrong COUNT outright
 * (error 132000, which looks like "sent fine, nothing arrived"). The arrays in
 * PARAM_BUILDERS are transcribed from the APPROVED bodies, reproduced above
 * each builder. If a template is edited in Meta, edit the matching array here
 * in the same change — nowhere else needs to know.
 */

export type InternalNotifyKind =
  | 'SESSION_SCHEDULED'
  | 'SESSION_RESCHEDULED'
  | 'DEMO_SCHEDULED'
  | 'DEMO_RESCHEDULED'
  | 'DEMO_REMINDER';

export interface InternalNotifyContext {
  studentName?: string;
  level?: string;
  /** "in 2 days", "in 3 hours" — the {{n}} that follows "begins in". */
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
 * Which approved template each event sends.
 *
 * DEMO_RESCHEDULED deliberately reuses `internal_demo_scheduled`: no separate
 * reschedule template was approved for demos, and the scheduled body carries
 * exactly the fields a moved demo needs to state.
 */
export const TEMPLATE_NAMES: Record<InternalNotifyKind, string> = {
  SESSION_SCHEDULED: 'internal_session_reminder',
  SESSION_RESCHEDULED: 'internal_session_rescheduled',
  DEMO_SCHEDULED: 'internal_demo_scheduled',
  DEMO_RESCHEDULED: 'internal_demo_scheduled',
  DEMO_REMINDER: 'internal_demo_reminder',
};

/** Meta rejects newlines, tabs and 4+ space runs inside a variable. */
const v = (s: string | undefined): string => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return (flat || '-').slice(0, 1024);
};

export const PARAM_BUILDERS: Record<InternalNotifyKind, (c: InternalNotifyContext) => string[]> = {
  /* internal_session_reminder — 8 variables
   *   {{1}} Student  {{2}} Level  {{3}} begins in  {{4}} Topic
   *   {{5}} Date     {{6}} Time   {{7}} Mentor     {{8}} Meeting Link      */
  SESSION_SCHEDULED: (c) => [
    v(c.studentName), v(c.level), v(c.startsIn), v(c.topic),
    v(c.date), v(c.time), v(c.mentorName), v(c.meetingLink),
  ],

  /* internal_session_rescheduled — 7 variables
   *   {{1}} Student  {{2}} Level     {{3}} Topic   {{4}} New Date
   *   {{5}} New Time {{6}} Mentor    {{7}} Updated Meeting Link            */
  SESSION_RESCHEDULED: (c) => [
    v(c.studentName), v(c.level), v(c.topic), v(c.date),
    v(c.time), v(c.mentorName), v(c.meetingLink),
  ],

  /* internal_demo_scheduled — 8 variables
   *   {{1}} Student  {{2}} Grade  {{3}} Country  {{4}} Parent Contact
   *   {{5}} Date     {{6}} Time   {{7}} Mentor   {{8}} Meeting Link        */
  DEMO_SCHEDULED: (c) => [
    v(c.studentName), v(c.grade), v(c.country), v(c.parentContact),
    v(c.date), v(c.time), v(c.mentorName), v(c.meetingLink),
  ],
  // Same body, same order — a moved demo is announced with the scheduled card.
  DEMO_RESCHEDULED: (c) => [
    v(c.studentName), v(c.grade), v(c.country), v(c.parentContact),
    v(c.date), v(c.time), v(c.mentorName), v(c.meetingLink),
  ],

  /* internal_demo_reminder — 9 variables
   *   {{1}} Student  {{2}} begins in  {{3}} Grade   {{4}} Country
   *   {{5}} Parent Contact  {{6}} Date  {{7}} Time  {{8}} Mentor
   *   {{9}} Meeting Link                                                   */
  DEMO_REMINDER: (c) => [
    v(c.studentName), v(c.startsIn), v(c.grade), v(c.country),
    v(c.parentContact), v(c.date), v(c.time), v(c.mentorName), v(c.meetingLink),
  ],
};

export const buildInternalComponents = (kind: InternalNotifyKind, ctx: InternalNotifyContext): any[] => [
  {
    type: 'body',
    parameters: PARAM_BUILDERS[kind](ctx).map((text) => ({ type: 'text', text })),
  },
];
