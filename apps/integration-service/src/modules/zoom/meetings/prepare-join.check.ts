/**
 * Self-check for prepare-join grace rules. Run:
 *   npx ts-node --transpile-only apps/integration-service/src/modules/zoom/meetings/prepare-join.check.ts
 */
import assert from 'assert';
import { mayForceEndGhostSession, resolveJoinGraceMs, DEFAULT_JOIN_GRACE_MS } from './prepare-join.service';

const MIN = 60_000;
const grace = 30 * MIN;
const end = new Date('2026-09-14T11:00:00.000Z');

assert.strictEqual(resolveJoinGraceMs(grace), grace, 'override wins');
assert.strictEqual(resolveJoinGraceMs(), DEFAULT_JOIN_GRACE_MS, 'default grace');

// Inside grace — never force.
assert.strictEqual(
  mayForceEndGhostSession({ endTime: end, presenceIsLive: false, presenceLastLiveAt: null }, new Date(end.getTime() + 10 * MIN), grace),
  false,
  '10m after end: too soon'
);

// Past grace, room empty — force OK.
assert.strictEqual(
  mayForceEndGhostSession({ endTime: end, presenceIsLive: false, presenceLastLiveAt: null }, new Date(end.getTime() + 31 * MIN), grace),
  true,
  '31m after end, not live: may force'
);

// Past grace but still marked live — do not force.
assert.strictEqual(
  mayForceEndGhostSession({ endTime: end, presenceIsLive: true, presenceLastLiveAt: null }, new Date(end.getTime() + 60 * MIN), grace),
  false,
  'still live locally: no force'
);

// Activity after scheduled end, still within grace of that activity.
const activeAfterEnd = new Date(end.getTime() + 5 * MIN);
assert.strictEqual(
  mayForceEndGhostSession(
    { endTime: end, presenceIsLive: false, presenceLastLiveAt: activeAfterEnd },
    new Date(end.getTime() + 20 * MIN),
    grace
  ),
  false,
  'recent post-end activity blocks force'
);

console.log('prepare-join: 6/6 checks passed');
