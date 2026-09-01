/**
 * Self-check for the CAPI payload. Run:
 *   npx ts-node --transpile-only apps/learning-service/src/modules/shared/meta-capi.check.ts
 * Sends nothing: global fetch is stubbed, so this is safe to run anywhere.
 */
import assert from 'assert';
import crypto from 'crypto';

const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const realFetch = globalThis.fetch;
let captured: { url: string; body: any } | null = null;
globalThis.fetch = (async (url: any, init: any) => {
  captured = { url: String(url), body: JSON.parse(init.body) };
  return { ok: true, status: 200, text: async () => '{}' } as any;
}) as any;

const run = async () => {
  const { sendLeadEvent } = await import('./meta-capi');

  // 1. Unconfigured is a silent no-op, not a throw.
  delete process.env.META_PIXEL_ID;
  delete process.env.META_ACCESS_TOKEN;
  assert.strictEqual(await sendLeadEvent({ email: 'a@b.com' }), null, 'no env → null');
  process.env.META_PIXEL_ID = '123';
  process.env.META_ACCESS_TOKEN = 'YOUR_META_ACCESS_TOKEN';
  assert.strictEqual(await sendLeadEvent({ email: 'a@b.com' }), null, 'placeholder token → null');

  // 2. Configured: normalisation happens BEFORE hashing.
  process.env.META_ACCESS_TOKEN = 'tok';
  const id = await sendLeadEvent({
    email: '  Parent@Example.COM ',
    phone: '+91 98765-43210',
    firstName: ' Safwa ',
    eventId: 'evt-1',
  });
  assert.strictEqual(id, 'evt-1', 'given eventId is used verbatim');
  const ev = captured!.body.data[0];
  assert.strictEqual(ev.event_name, 'Lead');
  assert.strictEqual(ev.action_source, 'website');
  assert.strictEqual(ev.event_id, 'evt-1');
  assert.ok(Math.abs(ev.event_time - Math.floor(Date.now() / 1000)) < 5, 'event_time is now, in seconds');
  assert.deepStrictEqual(ev.user_data.em, [sha('parent@example.com')], 'email trimmed + lowercased');
  assert.deepStrictEqual(ev.user_data.ph, [sha('919876543210')], 'phone digits only, country code kept');
  assert.deepStrictEqual(ev.user_data.fn, [sha('safwa')], 'name trimmed + lowercased');
  assert.ok(captured!.url.includes('/v23.0/123/events'), 'pixel id in path');
  assert.ok(!('test_event_code' in captured!.body), 'no test code unless env set');

  // 3. No eventId → a generated one, and only the fields present are hashed.
  captured = null;
  const gen = await sendLeadEvent({ email: 'x@y.com' });
  assert.ok(gen && gen.length > 10 && gen !== 'evt-1', 'generates an event id');
  const ev2 = captured!.body.data[0];
  assert.deepStrictEqual(Object.keys(ev2.user_data), ['em'], 'absent phone/name are omitted, not empty hashes');

  // 4. A Meta refusal throws, so the caller's .catch logs it.
  globalThis.fetch = (async () => ({ ok: false, status: 400, text: async () => 'bad token' })) as any;
  await assert.rejects(() => sendLeadEvent({ email: 'x@y.com' }), /Meta CAPI 400/, 'non-ok throws');

  globalThis.fetch = realFetch;
  console.log('meta-capi: 12/12 checks passed');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
