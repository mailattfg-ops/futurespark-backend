/**
 * Self-check for Zoom host-seat buffer overlap. Run:
 *   npx ts-node --transpile-only apps/integration-service/src/modules/zoom/host-buffer/host-buffer.check.ts
 * Pure logic — no database, no network.
 */
import assert from 'assert';
import {
  DEFAULT_HOST_BUFFER_MS,
  busyHostKeys,
  expandWindow,
  findConflictingBookings,
  isHostAvailable,
  resolveHostBufferMs,
  timeWindowFrom,
  windowsConflict,
  type SeatBooking,
} from './host-buffer';

const MIN = 60_000;
const buf = 15 * MIN;

const booking = (
  id: string,
  host: string,
  startMs: number,
  durationMs: number,
  title = 'Class'
): SeatBooking => ({
  meetingId: id,
  hostEmail: host,
  title,
  startTime: new Date(startMs),
  endTime: new Date(startMs + durationMs),
});

// ── windowsConflict ─────────────────────────────────────────────────────────

assert.strictEqual(
  windowsConflict(timeWindowFrom(0, 60 * MIN), timeWindowFrom(60 * MIN, 120 * MIN), 0),
  false,
  'touching endpoints: no conflict without buffer'
);

assert.strictEqual(
  windowsConflict(timeWindowFrom(60 * MIN, 120 * MIN), timeWindowFrom(0, 60 * MIN), buf),
  true,
  '15m buffer: class starting when previous ends is still blocked'
);

assert.strictEqual(
  windowsConflict(timeWindowFrom(75 * MIN, 135 * MIN), timeWindowFrom(0, 60 * MIN), buf),
  false,
  '15m gap after previous end is free'
);

assert.strictEqual(
  windowsConflict(timeWindowFrom(0, 60 * MIN), timeWindowFrom(45 * MIN, 105 * MIN), buf),
  true,
  'overlap with buffer on both sides'
);

// ── expandWindow ────────────────────────────────────────────────────────────

const expanded = expandWindow(timeWindowFrom(100, 200), 10);
assert.strictEqual(expanded.start.getTime(), 90, 'start padded backward');
assert.strictEqual(expanded.end.getTime(), 210, 'end padded forward');

// ── busyHostKeys / isHostAvailable ──────────────────────────────────────────

const seatA = 'seat-a@example.com';
const seatB = 'seat-b@example.com';
const existing = [
  booking('m1', seatA, 0, 60 * MIN, 'Morning'),
  booking('m2', seatB, 2 * 60 * MIN, 60 * MIN, 'Afternoon'),
];

const busy = busyHostKeys(timeWindowFrom(50 * MIN, 70 * MIN), existing, { bufferMs: buf });
assert.ok(busy.has('seat-a@example.com'), 'seat A busy inside buffer after morning class');
assert.ok(!busy.has('seat-b@example.com'), 'seat B still free — afternoon class is 2h out');

assert.strictEqual(
  isHostAvailable(seatA, timeWindowFrom(75 * MIN, 135 * MIN), existing, { bufferMs: buf }),
  true,
  'seat A free once buffer elapsed'
);

assert.strictEqual(
  isHostAvailable(seatA, timeWindowFrom(75 * MIN, 135 * MIN), existing, { bufferMs: buf, excludeMeetingId: 'm1' }),
  true,
  'excluding the only blocker frees the seat'
);

// ── findConflictingBookings ─────────────────────────────────────────────────

const conflicts = findConflictingBookings(timeWindowFrom(50 * MIN, 70 * MIN), existing, { bufferMs: buf });
assert.strictEqual(conflicts.length, 1, 'one conflict reported');
assert.strictEqual(conflicts[0].existing.meetingId, 'm1');

// ── resolveHostBufferMs ─────────────────────────────────────────────────────

const saved = process.env.ZOOM_HOST_BUFFER_MINUTES;
process.env.ZOOM_HOST_BUFFER_MINUTES = '20';
assert.strictEqual(resolveHostBufferMs(), 20 * MIN, 'reads env');
assert.strictEqual(resolveHostBufferMs(5 * MIN), 5 * MIN, 'explicit override wins');
if (saved === undefined) delete process.env.ZOOM_HOST_BUFFER_MINUTES;
else process.env.ZOOM_HOST_BUFFER_MINUTES = saved;
assert.strictEqual(resolveHostBufferMs(), DEFAULT_HOST_BUFFER_MS, 'restored default');

console.log('zoom host-buffer: 14/14 checks passed');
