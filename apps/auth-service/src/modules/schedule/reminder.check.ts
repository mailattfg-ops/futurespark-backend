/**
 * Self-check for internal reminder thresholds. Run:
 *   npx ts-node --transpile-only apps/auth-service/src/modules/schedule/reminder.check.ts
 * Pure logic — no database, no network, no cron started.
 *
 * The two failures worth guarding: a reminder sent twice (the team stops
 * trusting them) and a reminder never sent (the team misses a class).
 */
import assert from 'assert';
import { dueThresholds } from './reminder.cron';

/** What the cron actually sends: the tightest crossed threshold, or nothing. */
const sends = (minutesUntil: number, sent: string[]): string | null => {
  const due = dueThresholds(minutesUntil, sent);
  return due.length ? due[due.length - 1] : null;
};

// ── Nothing fires before the first threshold ──────────────────────────────
assert.strictEqual(sends(48 * 60, []), null, 'two days out: silent');
assert.strictEqual(sends(24 * 60 + 5, []), null, 'just over 24h: silent');

// ── Each threshold fires once, at the right time ──────────────────────────
assert.strictEqual(sends(24 * 60, []), '24h', 'exactly 24h out fires the 24h reminder');
assert.strictEqual(sends(23 * 60, []), '24h', 'inside 24h fires it');
assert.strictEqual(sends(90, ['24h']), null, '90 minutes out, 24h already sent: silent');
assert.strictEqual(sends(60, ['24h']), '1h', 'one hour out fires the 1h reminder');
assert.strictEqual(sends(30, ['24h', '1h']), null, 'between thresholds: silent');
assert.strictEqual(sends(10, ['24h', '1h']), '10m', 'ten minutes out fires the last one');
assert.strictEqual(sends(2, ['24h', '1h', '10m']), null, 'all spent: silent');

// ── A late booking crosses everything at once ─────────────────────────────
assert.deepStrictEqual(dueThresholds(20, []), ['24h', '1h'], 'booked 20 min out: both loose ones crossed');
assert.strictEqual(sends(20, []), '1h', 'and only the tightest is spoken');
assert.deepStrictEqual(dueThresholds(5, []), ['24h', '1h', '10m'], 'booked 5 min out: all three crossed');
assert.strictEqual(sends(5, []), '10m', 'the most urgent wins');
// After that tick marks all three spent, nothing more fires.
assert.strictEqual(sends(3, ['24h', '1h', '10m']), null, 'no follow-up storm from a late booking');

// ── A missed tick still delivers, and never twice ─────────────────────────
// Cron was down through the 1h mark; the next tick at 40 minutes still sends it.
assert.strictEqual(sends(40, ['24h']), '1h', 'a missed tick is recovered, not lost');
assert.strictEqual(sends(40, ['24h', '1h']), null, 'and is not re-sent on the tick after');

console.log('internal reminders: 15/15 threshold checks passed');
