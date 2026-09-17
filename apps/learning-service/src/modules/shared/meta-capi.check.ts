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
  const { sendLeadEvent, sendQualifiedLeadEvent } = await import('./meta-capi');

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

  // 4. Match-quality keys: external_id is hashed, the browser keys go raw.
  captured = null;
  await sendLeadEvent({
    email: 'x@y.com',
    externalId: 'lead-row-id',
    fbp: 'fb.1.1700000000000.123456',
    fbc: 'fb.1.1700000000000.AbCdEf',
    clientIpAddress: '203.0.113.9',
    clientUserAgent: 'Mozilla/5.0 test',
    eventSourceUrl: 'https://junior.finquo.ai/claim-free-class',
  });
  const ev3 = captured!.body.data[0];
  assert.strictEqual(ev3.user_data.external_id, sha('lead-row-id'), 'external_id is sha256 of the lead id');
  assert.strictEqual(ev3.user_data.fbp, 'fb.1.1700000000000.123456', 'fbp passes through unhashed');
  assert.strictEqual(ev3.user_data.fbc, 'fb.1.1700000000000.AbCdEf', 'fbc passes through unhashed');
  assert.strictEqual(ev3.user_data.client_ip_address, '203.0.113.9');
  assert.strictEqual(ev3.user_data.client_user_agent, 'Mozilla/5.0 test');
  assert.strictEqual(ev3.event_source_url, 'https://junior.finquo.ai/claim-free-class');

  // 5. The body parser every lead route shares: strings only, trimmed, capped, nothing invented.
  const { readLeadAttribution } = await import('./meta-capi');
  assert.deepStrictEqual(
    readLeadAttribution({ eventId: ' evt-9 ', fbp: 42, fbc: '', clientIpAddress: null, clientUserAgent: 'x'.repeat(600) }),
    { eventId: 'evt-9', clientIpAddress: undefined, clientUserAgent: 'x'.repeat(512), fbp: undefined, fbc: undefined, eventSourceUrl: undefined },
    'non-strings and blanks drop to undefined, long values are capped'
  );
  assert.deepStrictEqual(Object.values(readLeadAttribution(undefined)).filter(Boolean), [], 'no body → nothing');

  // 6. A Meta refusal throws, so the caller's .catch logs it.
  globalThis.fetch = (async () => ({ ok: false, status: 400, text: async () => 'bad token' })) as any;
  await assert.rejects(() => sendLeadEvent({ email: 'x@y.com' }), /Meta CAPI 400/, 'non-ok throws');

  /* ── the qualified-lead signal ───────────────────────────────────────────
   * A second event about the same person, days later. It must NOT reuse the
   * submission's event id (Meta would drop it as a duplicate) and must NOT be
   * called "Lead" (that would double-count the conversion the ads optimise on).
   */
  captured = null;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, status: 200, text: async () => '{}' } as any;
  }) as any;
  const qid = await sendQualifiedLeadEvent({
    email: 'parent@example.com',
    phone: '+91 98765 43210',
    externalId: 'lead-row-id',
    eventId: 'original-submission-id',
    fbc: 'fb.1.1700000000000.AbCdEf',
  });
  const q = captured!.body.data[0];
  assert.strictEqual(q.event_name, 'QualifiedLead', 'a custom name, not the standard Lead');
  assert.strictEqual(q.action_source, 'system_generated', "'crm' is not a value Meta accepts");
  assert.notStrictEqual(q.event_id, 'original-submission-id', 'a fresh id, or Meta dedupes it away');
  assert.strictEqual(q.event_id, qid, 'the id it reports is the id it sent');
  assert.deepStrictEqual(q.user_data.em, [sha('parent@example.com')], 'still matches on hashed email');
  assert.strictEqual(q.user_data.fbc, 'fb.1.1700000000000.AbCdEf', 'the stored click id still matches the ad');

  // Never throws: an enrolment must not fail because Meta is unreachable.
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as any;
  assert.strictEqual(await sendQualifiedLeadEvent({ email: 'a@b.com' }), null, 'a refusal is swallowed');


  globalThis.fetch = realFetch;

  console.log('meta-capi: 27/27 checks passed');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
