/**
 * Self-check for the presence watch window. Run:
 *   npx ts-node --transpile-only apps/integration-service/src/modules/zoom/presence/watch-window.check.ts
 * Talks to no database and no network: it stubs both and inspects the query.
 *
 * The rule under test: a room is polled when its OWN slot is current, OR when a
 * class running now is using its link. The second arm is what keeps a REUSED
 * room visible — one link serves every session, and its meeting row keeps the
 * date of the first class booked on it.
 */
import assert from 'assert';
import Module from 'module';

// Stub the datasource before the service imports it.
const captured: any[] = [];
const originalResolve = (Module as any)._resolveFilename;
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.endsWith('database/datasource')) {
    return {
      db: { meeting: { findMany: (args: any) => { captured.push(args); return Promise.resolve([]); } } },
      withDbRetry: (fn: () => unknown) => fn(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const run = async () => {
  const { ZoomPresenceService } = await import('./presence.service');

  // 1. auth-service unreachable → the link arm is omitted, never sent empty.
  const failing = async () => { throw new Error('down'); };
  (globalThis as any).fetch = failing;
  captured.length = 0;
  await ZoomPresenceService.getWatchWindowMeetings();
  let where = captured[0].where;
  assert.strictEqual(where.provider, 'ZOOM', 'still scoped to Zoom');
  assert.deepStrictEqual(where.status, { not: 'CANCELLED' }, 'still skips cancelled rooms');
  assert.strictEqual(where.OR.length, 1, 'no link arm when auth-service is unreachable');
  assert.ok(where.OR[0].AND, 'the time window survives on its own');

  // 2. Links returned → a second arm matches reused rooms by URL.
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({ data: ['https://us06web.zoom.us/j/8217?pwd=x', 'https://meet.google.com/abc-defg-hij'] }),
  });
  captured.length = 0;
  await ZoomPresenceService.getWatchWindowMeetings();
  where = captured[0].where;
  assert.strictEqual(where.OR.length, 2, 'time window OR reused link');
  assert.deepStrictEqual(
    where.OR[1],
    { meetUrl: { in: ['https://us06web.zoom.us/j/8217?pwd=x', 'https://meet.google.com/abc-defg-hij'] } },
    'reused rooms matched on the exact stored link'
  );

  // 3. A malformed payload must not become a `meetUrl: { in: [undefined] }`.
  (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ data: [null, 42, 'ok-link'] }) });
  captured.length = 0;
  await ZoomPresenceService.getWatchWindowMeetings();
  assert.deepStrictEqual(
    captured[0].where.OR[1],
    { meetUrl: { in: ['ok-link'] } },
    'non-string entries are dropped'
  );

  // 4. An empty list behaves like a failure: time window only.
  (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
  captured.length = 0;
  await ZoomPresenceService.getWatchWindowMeetings();
  assert.strictEqual(captured[0].where.OR.length, 1, 'no empty `in` clause');

  console.log('watch window: 8/8 checks passed');
};

run()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => { (Module as any)._load = originalLoad; (Module as any)._resolveFilename = originalResolve; });
