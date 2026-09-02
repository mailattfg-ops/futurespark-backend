/**
 * Self-check for the S1-00 closure. Run:
 *   npx ts-node --transpile-only apps/auth-service/src/middlewares/identity.check.ts
 * No server, no database — the middleware functions are attacked directly.
 *
 * Every case here is a request the finding proved possible. If one of these
 * assertions fails, the exposure is open again.
 */
import assert from 'assert';

process.env.INTERNAL_HMAC_KEY = 'check-hmac-key';
process.env.INTERNAL_API_KEY = 'check-internal-key';

import { signInternalHeaders } from '@futurespark/authentication';
import { requireVerifiedIdentity, stripPasswordHashes } from './identity';

const call = (path: string, headers: Record<string, string>) => {
  let status: number | null = null;
  let passed = false;
  const req: any = { path, headers };
  const res: any = {
    status: (s: number) => { status = s; return res; },
    json: (_b: unknown) => res,
  };
  requireVerifiedIdentity(req, res, () => { passed = true; });
  return { status, passed, identity: req.verifiedIdentity };
};

// 1. The finding's headline: no credentials at all reads nothing.
assert.deepStrictEqual(call('/users/customers', {}), { status: 401, passed: false, identity: undefined },
  'anonymous request to the roster is refused');

// 2. A bare asserted role — the forgery this service used to trust — is refused.
assert.strictEqual(call('/users/customers/students', { 'x-user-role': 'ADMIN', 'x-user-id': 'x' }).status, 401,
  'an unsigned ADMIN header means nothing');

// 3. Genuine gateway traffic passes untouched, identity attached.
const signed = call('/schedules', signInternalHeaders('user-1', 'SCHEDULER'));
assert.strictEqual(signed.passed, true, 'signed identity passes');
assert.deepStrictEqual({ userId: signed.identity.userId, role: signed.identity.role }, { userId: 'user-1', role: 'SCHEDULER' });

// 4. A signature for one role does not authorise another.
const tampered = { ...signInternalHeaders('user-1', 'STUDENT'), 'x-user-role': 'ADMIN' };
assert.strictEqual(call('/users', tampered).status, 401, 'role tampering breaks the signature');

// 5. Replayed headers die at the 30-second window.
const stale = signInternalHeaders('user-1', 'ADMIN');
stale['x-internal-timestamp'] = String(Math.floor(Date.now() / 1000) - 3600);
assert.strictEqual(call('/users', stale).status, 401, 'hour-old headers are refused');

// 6. The machine lane no longer treats absence of credentials as authorisation.
assert.strictEqual(call('/schedules/internal/class-at', {}).status, 401,
  'anonymous machine call refused when the key is configured');
assert.strictEqual(call('/schedules/internal/class-at', { 'x-internal-key': 'wrong' }).status, 401,
  'wrong key refused');
assert.strictEqual(call('/schedules/internal/active-links', { 'x-internal-key': 'check-internal-key' }).passed, true,
  'the real key passes');
assert.strictEqual(call('/audit/record', { 'x-internal-key': 'check-internal-key' }).passed, true,
  'audit record is a machine path');

// 7. No response carries a password hash, however deeply nested.
const body: any = {
  success: true,
  data: [
    { email: 'p@x.com', passwordHash: 'SECRET', students: [{ name: 'child', passwordHash: 'SECRET2' }] },
  ],
};
let sent: any = null;
const res2: any = { json: (b: unknown) => { sent = b; return res2; } };
res2.json = res2.json.bind(res2);
stripPasswordHashes({} as any, res2, () => {});
res2.json(body);
assert.strictEqual(sent.data[0].passwordHash, undefined, 'parent hash stripped');
assert.strictEqual(sent.data[0].students[0].passwordHash, undefined, 'nested student hash stripped');
assert.strictEqual(sent.data[0].email, 'p@x.com', 'real fields survive');

console.log('identity: 11/11 checks passed');
