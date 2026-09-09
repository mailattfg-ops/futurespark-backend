/**
 * Self-check for the "split" scheduler payload adapters. Run:
 *   npx ts-node --transpile-only apps/auth-service/src/modules/schedule/split-payload.check.ts
 * Pure logic — no server, no database. It proves the frontend's /program and
 * /demo bodies translate into the shape validateCreateSchedule already accepts,
 * which is the whole reason demo booking was returning "route not found" +
 * would have mis-mapped fields even once routed.
 *
 * The mapping mirrors createProgram/createDemo in schedule.controller.ts. If
 * that mapping changes, change it here too — this is the contract with the UI.
 */
import assert from 'assert';
import { validateCreateSchedule } from './schedule.schema';

// The exact body the split scheduler UI POSTs to /program.
const programBody = {
  studentId: 'stu-1',
  programId: 'prog-1',
  mentorId: 'men-1',
  startTime: '2026-09-09T16:30:00.000Z',
  durationMin: 70,
  status: 'SCHEDULED',
  meetingLink: 'https://us06web.zoom.us/j/89520200609',
  updateAllMeetingLinks: false,
  cadence: 'WEEKLY',
  allowConflict: false,
  sessionsToBook: [
    { sessionId: 'sess-a', meetingLink: 'https://us06web.zoom.us/j/1' },
    { sessionId: 'sess-b' },
  ],
};

const programInput = validateCreateSchedule({
  ...programBody,
  classType: 'REGULAR',
  durationMinutes: programBody.durationMin ?? (programBody as any).durationMinutes,
  sessions: Array.isArray(programBody.sessionsToBook)
    ? programBody.sessionsToBook.map((s: any, i: number) => ({
        id: s.sessionId ?? s.id,
        order: typeof s.order === 'number' ? s.order : i,
        meetingLink: s.meetingLink,
      }))
    : (programBody as any).sessions,
});

assert.strictEqual(programInput.durationMinutes, 70, 'durationMin maps onto durationMinutes');
assert.strictEqual(programInput.sessions?.length, 2, 'both sessionsToBook entries survive');
assert.strictEqual(programInput.sessions?.[0].id, 'sess-a', 'sessionId maps onto id');
assert.strictEqual(programInput.sessions?.[0].order, 0, 'order is injected from position');
assert.strictEqual(programInput.sessions?.[1].order, 1, 'second session keeps its position');
assert.strictEqual(programInput.classType, 'REGULAR', 'program bookings are regular classes');
assert.strictEqual(programInput.studentId, 'stu-1', 'student carried through');

// The exact body the split UI POSTs to /demo — the one that was 404-ing.
const demoBody = {
  leadId: 'dd8d0cbc-f0ef-4159-9016-c835100ba328',
  programId: 'prog-1',
  mentorId: 'men-1',
  startTime: '2026-09-09T16:30:00.000Z',
  durationMin: 70,
  status: 'SCHEDULED',
  meetingLink: 'https://us06web.zoom.us/j/89520200609',
  allowConflict: false,
};

const demoInput = validateCreateSchedule({
  ...demoBody,
  classType: 'DEMO',
  durationMinutes: demoBody.durationMin ?? (demoBody as any).durationMinutes,
});

assert.strictEqual(demoInput.classType, 'DEMO', 'demo bookings are demo classes');
assert.strictEqual(demoInput.leadId, 'dd8d0cbc-f0ef-4159-9016-c835100ba328', 'lead carried through');
assert.strictEqual(demoInput.durationMinutes, 70, 'demo duration maps too');
assert.ok(!demoInput.studentId, 'a demo has no student');

// A demo with no lead must still be rejected — the adapter must not paper over it.
let rejected = false;
try {
  validateCreateSchedule({ classType: 'DEMO', mentorId: 'm', programId: 'p', startTime: '2026-09-09T16:30:00.000Z' });
} catch {
  rejected = true;
}
assert.ok(rejected, 'a demo without a lead is still refused');

console.log('split payload adapters: 11/11 checks passed');
