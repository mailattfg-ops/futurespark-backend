/**
 * Self-check for demo slot capacity. Run:
 *   npx ts-node --transpile-only apps/learning-service/src/modules/pilot-lead/slot-capacity.check.ts
 *
 * Pure logic — the database is stubbed, nothing is written and nothing is sent.
 *
 * What it protects: a demo seat is a seat whichever form produced it. The pilot
 * widget writes PilotLead; the claim-free-class form writes a demo Lead whose
 * date lives in preferredDays[0]. Counting only the first is what let a slot be
 * booked past its limit while still advertising itself as free.
 */
import assert from 'assert';
import Module from 'module';

/* ── stub the database before the service imports it ─────────────────────── */
let pilotRows: any[] = [];
let leadRows: any[] = [];
let settingsRow: any = { value: { demoTeachersCount: 3, todayCutoffHour: 16, hiddenSlots: [] } };

const fakeDb = {
  pilotLead: { findMany: async () => pilotRows },
  lead: { findMany: async () => leadRows },
  appSetting: { findUnique: async () => settingsRow },
};

const originalResolve = (Module as any)._resolveFilename;
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request.endsWith('database/datasource')) return { db: fakeDb };
  return originalLoad.call(this, request, parent, isMain);
};

const run = async () => {
  const { pilotLeadService } = await import('./pilot-lead.service');

  const PILOT = (date: string, time: string, status = 'NEW') => ({
    preferredSlotDate: date,
    preferredSlotTime: time,
    status,
  });
  const CLAIM = (date: string, time: string) => ({
    preferredDays: [date],
    preferredTime: time,
  });

  // 1. Both tables feed one seat count.
  pilotRows = [PILOT('20/09/2026 (Sunday)', '04:00 PM')];
  leadRows = [CLAIM('20/09/2026 (Sunday)', '04:00 PM')];
  assert.strictEqual(
    await pilotLeadService.seatsTaken('20/09/2026 (Sunday)', '04:00 PM'),
    2,
    'a pilot booking and a claim-free-class booking both occupy the slot'
  );

  // 2. The claim-free-class booking alone still counts — the regression that shipped.
  pilotRows = [];
  leadRows = [CLAIM('20/09/2026 (Sunday)', '04:00 PM'), CLAIM('20/09/2026', '04:00 PM')];
  assert.strictEqual(
    await pilotLeadService.seatsTaken('20/09/2026', '04:00 PM'),
    2,
    'claim-free-class bookings count, and the date matches across format variants'
  );

  // 3. A different time or a different day is a different seat.
  assert.strictEqual(await pilotLeadService.seatsTaken('20/09/2026', '05:00 PM'), 0, 'other times are free');
  assert.strictEqual(await pilotLeadService.seatsTaken('21/09/2026', '04:00 PM'), 0, 'other days are free');

  // 4. Rows without a slot never consume one.
  leadRows = [{ preferredDays: [], preferredTime: '04:00 PM' }, { preferredDays: ['20/09/2026'], preferredTime: null }];
  assert.strictEqual(await pilotLeadService.seatsTaken('20/09/2026', '04:00 PM'), 0, 'half-filled rows hold no seat');

  // 5. Availability reports the combined count, and closes the slot at the limit.
  pilotRows = [PILOT('20/09/2026', '04:00 PM'), PILOT('20/09/2026', '04:00 PM')];
  leadRows = [CLAIM('20/09/2026', '04:00 PM')];
  const availability = await pilotLeadService.getSlotAvailability('20/09/2026');
  const fourPm = availability.slots.find((s: any) => s.time === '04:00 PM');
  assert.ok(fourPm, '04:00 PM is offered');
  assert.strictEqual(fourPm.bookedCount, 3, 'availability counts both tables');
  assert.strictEqual(fourPm.remainingSeats, 0);
  assert.strictEqual(fourPm.isBookedOut, true, 'the slot closes once every demo teacher is taken');

  const fivePm = availability.slots.find((s: any) => s.time === '05:00 PM');
  assert.ok(fivePm, '05:00 PM is offered');
  assert.strictEqual(fivePm.isBookedOut, false, 'an untouched slot stays open');

  // 6. Hidden slots never reach the booking widget at all.
  settingsRow = { value: { demoTeachersCount: 3, todayCutoffHour: 16, hiddenSlots: ['04:00 PM'] } };
  const hidden = await pilotLeadService.getSlotAvailability('20/09/2026');
  assert.ok(!hidden.slots.some((s: any) => s.time === '04:00 PM'), 'an admin-hidden slot is not offered');

  (Module as any)._load = originalLoad;
  (Module as any)._resolveFilename = originalResolve;
  console.log('slot capacity: 10/10 checks passed');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
