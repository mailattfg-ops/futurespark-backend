/**
 * Self-check for the internal ops templates. Run:
 *   npx ts-node --transpile-only apps/communication-service/src/modules/whatsapp/internal-notify.check.ts
 * No network — it inspects the component payload only.
 *
 * Meta matches body variables BY POSITION and rejects a wrong COUNT with error
 * 132000, which surfaces as "template accepted but nothing arrived". The
 * expectations below are transcribed from the APPROVED bodies, so a drift
 * between code and Meta fails here instead of silently in production.
 */
import assert from 'assert';
import { buildInternalComponents, InternalNotifyKind, TEMPLATE_NAMES } from './internal-notify';

/** Variable count of each approved template body, counted from the real text. */
const APPROVED_COUNT: Record<string, number> = {
  internal_session_reminder: 8,
  internal_session_rescheduled: 7,
  internal_demo_scheduled: 8,
  internal_demo_reminder: 9,
};

const ctx = {
  studentName: '  Sada   Haimi ',
  level: 'L2',
  startsIn: '2 days',
  topic: 'Budgeting\nand saving',
  date: 'Tue 02 Sept',
  time: '7:00 PM',
  mentorName: 'Mazina Thameem',
  meetingLink: 'https://us06web.zoom.us/j/8217',
  grade: 'Grade 6',
  country: 'India',
  parentContact: '+91 98765 43210',
};

const KINDS: InternalNotifyKind[] = [
  'SESSION_SCHEDULED', 'SESSION_RESCHEDULED', 'DEMO_SCHEDULED', 'DEMO_RESCHEDULED', 'DEMO_REMINDER',
];

for (const kind of KINDS) {
  const template = TEMPLATE_NAMES[kind];
  const params = buildInternalComponents(kind, ctx)[0].parameters;
  assert.strictEqual(
    params.length,
    APPROVED_COUNT[template],
    `${kind} -> ${template}: sends ${params.length} variables, the approved body has ${APPROVED_COUNT[template]}`
  );
  for (const p of params) {
    assert.strictEqual(p.type, 'text', `${kind}: every parameter is text`);
    assert.ok(!/[\n\t]/.test(p.text), `${kind}: no newlines or tabs survive`);
    assert.ok(!/ {4}/.test(p.text), `${kind}: no long space runs survive`);
    assert.ok(p.text.length > 0, `${kind}: never an empty variable`);
  }
}

// Position is the contract — spot-check the ones whose order is load-bearing.
const sess = buildInternalComponents('SESSION_SCHEDULED', ctx)[0].parameters.map((p: any) => p.text);
assert.deepStrictEqual(
  sess,
  ['Sada Haimi', 'L2', '2 days', 'Budgeting and saving', 'Tue 02 Sept', '7:00 PM', 'Mazina Thameem', 'https://us06web.zoom.us/j/8217'],
  'session reminder: student, level, begins-in, topic, date, time, mentor, link'
);

const resched = buildInternalComponents('SESSION_RESCHEDULED', ctx)[0].parameters.map((p: any) => p.text);
assert.deepStrictEqual(
  resched,
  ['Sada Haimi', 'L2', 'Budgeting and saving', 'Tue 02 Sept', '7:00 PM', 'Mazina Thameem', 'https://us06web.zoom.us/j/8217'],
  'rescheduled: no begins-in variable in this body'
);

const demo = buildInternalComponents('DEMO_SCHEDULED', ctx)[0].parameters.map((p: any) => p.text);
assert.deepStrictEqual(
  demo,
  ['Sada Haimi', 'Grade 6', 'India', '+91 98765 43210', 'Tue 02 Sept', '7:00 PM', 'Mazina Thameem', 'https://us06web.zoom.us/j/8217'],
  'demo scheduled: student, grade, country, contact, date, time, mentor, link'
);

const reminder = buildInternalComponents('DEMO_REMINDER', ctx)[0].parameters.map((p: any) => p.text);
assert.strictEqual(reminder[1], '2 days', 'demo reminder puts begins-in at {{2}}, not {{3}}');

// A moved demo reuses the scheduled body — same template, same shape.
assert.strictEqual(TEMPLATE_NAMES.DEMO_RESCHEDULED, 'internal_demo_scheduled', 'no separate demo reschedule template');
assert.deepStrictEqual(
  buildInternalComponents('DEMO_RESCHEDULED', ctx)[0].parameters,
  buildInternalComponents('DEMO_SCHEDULED', ctx)[0].parameters,
  'a rescheduled demo sends exactly the scheduled payload'
);

// Missing context must never produce an empty variable — Meta rejects those.
assert.ok(
  buildInternalComponents('DEMO_SCHEDULED', {})[0].parameters.every((p: any) => p.text === '-'),
  'absent values become a dash, never an empty string'
);

console.log(`internal templates: ${KINDS.length} kinds, counts match all 4 approved bodies, positions verified`);
