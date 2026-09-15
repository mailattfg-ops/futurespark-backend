/**
 * Self-check for prepare-join ghost / force-end rules. Run:
 *   npx ts-node --transpile-only apps/integration-service/src/modules/zoom/meetings/prepare-join.check.ts
 */
import assert from 'assert';
import {
  isGhostSessionOnTarget,
  mayForceEndGhostSession,
  resolveJoinGraceMs,
  resolveJoinEarlyMs,
  shouldForceEndByParticipants,
  shouldForceEndSession,
  DEFAULT_JOIN_GRACE_MS,
  DEFAULT_JOIN_EARLY_MS,
} from './prepare-join.service';
import { countActiveMeetingParticipants } from '../shared/zoom-session';

const MIN = 60_000;
const grace = 30 * MIN;
const early = 10 * MIN;
const start = new Date('2026-09-14T10:00:00.000Z');
const end = new Date('2026-09-14T11:00:00.000Z');

const base = {
  startTime: start,
  endTime: end,
  presenceIsLive: false,
  presenceFirstJoinAt: null as Date | null,
};

assert.strictEqual(resolveJoinGraceMs(grace), grace, 'grace override wins');
assert.strictEqual(resolveJoinGraceMs(), DEFAULT_JOIN_GRACE_MS, 'default grace');
assert.strictEqual(resolveJoinEarlyMs(), DEFAULT_JOIN_EARLY_MS, 'default early');

// Reused room: first join was user1, user4 joins in their window — ghost.
assert.strictEqual(
  isGhostSessionOnTarget(
    {
      ...base,
      presenceFirstJoinAt: new Date(start.getTime() - 60 * MIN),
    },
    new Date(start.getTime() + 5 * MIN),
    early,
    grace
  ),
  true,
  'stale first join on reused room'
);

// After scheduled end with empty room — ghost even inside grace.
assert.strictEqual(
  isGhostSessionOnTarget(base, new Date(end.getTime() + 10 * MIN), early, grace),
  true,
  '10m after end with empty room is ghost'
);

// In active class window, first join in window — not ghost.
assert.strictEqual(
  isGhostSessionOnTarget(
    {
      ...base,
      presenceIsLive: true,
      presenceFirstJoinAt: new Date(start.getTime() + 2 * MIN),
    },
    new Date(start.getTime() + 20 * MIN),
    early,
    grace
  ),
  false,
  'live class in window is not ghost'
);

// Different zoom id on same host — always force-end.
assert.strictEqual(
  shouldForceEndSession(
    '111',
    { ...base, id: 't', zoomMeetingId: '222' } as any,
    undefined,
    new Date(start.getTime() + 5 * MIN)
  ),
  true,
  'other meeting id always cleared'
);

// Same id, legitimate window — do not force.
assert.strictEqual(
  shouldForceEndSession(
    '222',
    { ...base, id: 't', zoomMeetingId: '222' } as any,
    { ...base, id: 't', zoomMeetingId: '222' } as any,
    new Date(start.getTime() + 5 * MIN)
  ),
  false,
  'same id in window not forced'
);

// mayForceEndGhostSession delegates to isGhostSessionOnTarget.
assert.strictEqual(
  mayForceEndGhostSession(
    { ...base, presenceLastLiveAt: null },
    new Date(end.getTime() + 10 * MIN),
    grace
  ),
  true,
  'mayForceEnd: empty room after end is ghost'
);

// Participant gate for force-end.
assert.strictEqual(shouldForceEndByParticipants(0, end, new Date(end.getTime() + 5 * MIN)).action, 'force_end');
assert.strictEqual(shouldForceEndByParticipants(2, end, new Date(end.getTime() + 5 * MIN)).action, 'skip');
assert.strictEqual(shouldForceEndByParticipants(1, end, new Date(end.getTime() - 5 * MIN)).action, 'skip');
assert.strictEqual(shouldForceEndByParticipants(1, end, new Date(end.getTime() + 5 * MIN)).action, 'force_end');
assert.strictEqual(shouldForceEndByParticipants(null, end, new Date(end.getTime() + 5 * MIN)).action, 'force_end');

assert.strictEqual(
  countActiveMeetingParticipants([
    { user_id: '1', user_name: 'Host' },
    { user_id: '2', user_name: 'Student', leave_time: '2026-09-14T11:00:00Z' },
    { user_id: '3', user_name: 'Waiting', status: 'in_waiting_room' },
  ]),
  1,
  'counts only active in-room participants'
);

console.log('prepare-join: 14/14 checks passed');
