/**
 * Self-check for the reused-room presence reset. Run:
 *   npx ts-node --transpile-only apps/integration-service/src/modules/zoom/presence/stale-presence.check.ts
 * No database, no network.
 *
 * The rule: a room that is idle NOW, whose last sign of life predates this
 * watch window, belongs to an earlier session — wipe its presence so the new
 * session starts from "nobody has joined yet". Without this a reused room
 * reads for ever as "somebody joined and then left", which renders a class as
 * completed before anyone arrives and makes the red waiting / no-show states
 * unreachable.
 */
import assert from 'assert';

const WATCH_AFTER_MS = 60 * 60 * 1000;
const MIN = 60 * 1000;

/** Mirrors the poller: same expression, same inputs. */
const isStale = (active: boolean, lastLiveAt: number | null, firstJoinAt: number | null, now: number) => {
  const lastSign = Math.max(lastLiveAt ?? 0, firstJoinAt ?? 0);
  return !active && lastSign > 0 && now - lastSign > WATCH_AFTER_MS;
};

const now = Date.UTC(2026, 8, 1, 19, 0, 0);

// The bug: last week's session left its marks on a room reused today.
assert.strictEqual(isStale(false, now - 7 * 24 * 60 * MIN, now - 7 * 24 * 60 * MIN, now), true,
  'a week-old join is a previous session');

// A class that genuinely ran and emptied minutes ago must NOT be wiped —
// that is a real ending and still has to reach auth-service.
assert.strictEqual(isStale(false, now - 5 * MIN, now - 70 * MIN, now), false,
  'a room that emptied 5 minutes ago is this session');

// Someone in the room right now is never stale, however old the history.
assert.strictEqual(isStale(true, now - 30 * 24 * 60 * MIN, now - 30 * 24 * 60 * MIN, now), false,
  'an occupied room is never reset');

// A room nobody has ever used has nothing to wipe, and must not be treated as
// a reset (it would log noise on every poll of every fresh room).
assert.strictEqual(isStale(false, null, null, now), false, 'a never-used room is not stale');

// Exactly on the boundary stays live; only strictly older is stale.
assert.strictEqual(isStale(false, now - WATCH_AFTER_MS, null, now), false, 'boundary is not stale');
assert.strictEqual(isStale(false, now - WATCH_AFTER_MS - 1, null, now), true, 'just past the boundary is stale');

// firstJoinAt alone (lastLiveAt never written) still counts as a sign of life.
assert.strictEqual(isStale(false, null, now - 3 * MIN, now), false, 'recent first-join is this session');
assert.strictEqual(isStale(false, null, now - 5 * 60 * MIN, now), true, 'old first-join is a previous one');

console.log('stale presence: 8/8 checks passed');
