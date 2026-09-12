/**
 * Self-check for the "may we end the Zoom room on sign-off?" rule. Run:
 *   npx ts-node --transpile-only apps/integration-service/src/modules/classes/end-window.check.ts
 * Pure logic — no Zoom call, no database.
 *
 * Why this is guarded at all: one Zoom room serves every session of a
 * programme, behind a SINGLE Meeting row. So "end the session" cannot be aimed
 * at one lesson — ending it late would kill whichever class is live in that
 * room now, possibly another child's lesson mid-flow. The rule below is the
 * only thing standing between a late sign-off and that outcome, so it gets a
 * test of its own.
 */
import assert from 'assert';
import { mayEndRoomOnSignOff, END_WINDOW_MS } from './lifecycle.service';

const start = new Date('2026-09-12T11:00:00Z');
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

// Prompt sign-off: this class is the only thing that can be live in that room.
assert.strictEqual(mayEndRoomOnSignOff(start, at(0)), true, 'signed off at the start');
assert.strictEqual(mayEndRoomOnSignOff(start, at(70)), true, 'signed off right after a 70-minute class');
assert.strictEqual(mayEndRoomOnSignOff(start, at(179)), true, 'just inside three hours');
assert.strictEqual(mayEndRoomOnSignOff(start, at(180)), true, 'exactly three hours is still allowed');

// Late sign-off: another class may hold the room now — never touch it.
assert.strictEqual(mayEndRoomOnSignOff(start, at(181)), false, 'a minute past the window is refused');
assert.strictEqual(mayEndRoomOnSignOff(start, at(60 * 8)), false, 'same-evening sign-off is refused');
assert.strictEqual(mayEndRoomOnSignOff(start, at(60 * 24 * 3)), false, 'three days later is refused');

// No known start (demo rooms, hand-linked classes): nothing to reason from, so
// the completion itself is trusted — it is the only signal available.
assert.strictEqual(mayEndRoomOnSignOff(null, at(0)), true, 'no start time: trust the sign-off');

// A clock skew that puts sign-off BEFORE the start must not be read as "late".
assert.strictEqual(mayEndRoomOnSignOff(start, at(-30)), true, 'sign-off before the start is still prompt');

assert.strictEqual(END_WINDOW_MS, 3 * 60 * 60 * 1000, 'the window is three hours');

console.log('zoom end-on-signoff window: 10/10 checks passed');
