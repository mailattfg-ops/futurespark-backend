/**
 * Self-check for "which lesson was in this room at this moment". Run:
 *   npx ts-node --transpile-only apps/auth-service/src/modules/schedule/class-in-room.check.ts
 * Stubs the datasource; touches no database.
 *
 * This decides which child's lesson a recording's summary is written onto, so
 * the property that matters most is the refusal: when two classes could match,
 * it must return nothing rather than pick one.
 */
import assert from 'assert';
import Module from 'module';

const rows: any[] = [];
let lastWhere: any = null;
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.endsWith('database/datasource')) {
    return {
      db: {
        scheduledClass: {
          findMany: (args: any) => {
            lastWhere = args.where;
            const at = args.where.startTime.lte as Date; // at + 30min
            const floor = args.where.endTime.gte as Date; // at - 60min
            return Promise.resolve(
              rows.filter(
                (r) => r.meetingLink === args.where.meetingLink && r.startTime <= at && r.endTime >= floor
              )
            );
          },
        },
      },
      withDbRetry: (fn: () => unknown) => fn(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const ROOM = 'https://us06web.zoom.us/j/8217';
const cls = (id: string, startIso: string, mins: number, sessionId: string) => ({
  id,
  meetingLink: ROOM,
  status: 'SCHEDULED',
  studentId: 'stu-1',
  mentorId: 'men-1',
  sessionId,
  programId: 'prog-1',
  startTime: new Date(startIso),
  endTime: new Date(new Date(startIso).getTime() + mins * 60000),
});

const run = async () => {
  const { scheduleService } = await import('./schedule.service');

  const orientation = cls('c-orientation', '2026-08-30T04:30:00Z', 70, 'sess-orientation');
  const budgeting = cls('c-budgeting', '2026-09-01T15:30:00Z', 70, 'sess-budgeting');
  rows.push(orientation, budgeting);

  // The bug, as a test: each recording resolves to its OWN lesson.
  const a = await scheduleService.classInRoomAt(ROOM, new Date('2026-08-30T04:32:00Z'));
  assert.strictEqual(a?.sessionId, 'sess-orientation', "August recording is the Orientation lesson");

  const b = await scheduleService.classInRoomAt(ROOM, new Date('2026-09-01T15:33:00Z'));
  assert.strictEqual(b?.sessionId, 'sess-budgeting', 'September recording is the Budgeting lesson');

  // Early start and overrun still resolve.
  assert.ok(await scheduleService.classInRoomAt(ROOM, new Date('2026-09-01T15:05:00Z')), '25 min early resolves');
  assert.ok(await scheduleService.classInRoomAt(ROOM, new Date('2026-09-01T17:20:00Z')), '40 min overrun resolves');

  // A time no class covers resolves to nothing.
  assert.strictEqual(await scheduleService.classInRoomAt(ROOM, new Date('2026-09-05T10:00:00Z')), null, 'no class, no answer');

  // Two classes in one room at one time: refuse rather than guess.
  rows.push(cls('c-double', '2026-09-01T15:30:00Z', 70, 'sess-other'));
  assert.strictEqual(
    await scheduleService.classInRoomAt(ROOM, new Date('2026-09-01T15:33:00Z')),
    null,
    'ambiguous room refuses'
  );
  rows.pop();

  // Bad inputs never throw and never match.
  assert.strictEqual(await scheduleService.classInRoomAt('', new Date('2026-09-01T15:33:00Z')), null, 'no link, no answer');
  assert.strictEqual(await scheduleService.classInRoomAt(ROOM, new Date('nonsense')), null, 'bad date, no answer');

  // Cancelled classes are excluded at the query level.
  assert.deepStrictEqual(lastWhere.status, { not: 'CANCELLED' }, 'cancelled classes never own a recording');

  console.log('class-in-room: 9/9 checks passed');
};

run()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => { (Module as any)._load = originalLoad; });
