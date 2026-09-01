/**
 * Self-check for the "is this programme free?" rule, which decides whether a
 * child's classes unlock without a Finance approval. Run:
 *   npx ts-node --transpile-only apps/auth-service/src/modules/user/free-program.check.ts
 * Touches no database.
 */
import assert from 'assert';
import { isFreePlanSet } from './user.service';

const plan = (price: number, installments: number[] = []) => ({
  price,
  installments: installments.map((amount) => ({ amount })),
});

// A zero-price plan is free — this is the case that was locking students out.
assert.strictEqual(isFreePlanSet([plan(0)]), true, 'single zero-price plan is free');

// Real money is not free, however it is expressed.
assert.strictEqual(isFreePlanSet([plan(5000)]), false, 'priced plan is not free');
assert.strictEqual(isFreePlanSet([plan(0, [2500, 2500])]), false, 'installments are the total when present');
assert.strictEqual(isFreePlanSet([plan(0, [0, 0])]), true, 'zero installments are still free');

// Mixed offerings are not free: a paid option means payment is expected.
assert.strictEqual(isFreePlanSet([plan(0), plan(5000)]), false, 'a paid alternative blocks free');
assert.strictEqual(isFreePlanSet([plan(0), plan(0, [0])]), true, 'every plan zero is free');

// No plan at all is unknown, not free — never auto-approve on missing data.
assert.strictEqual(isFreePlanSet([]), false, 'a programme with no plans is not free');

/* Installments override the price field entirely — the same rule Finance, the
 * students directory and the dashboard already use to decide what a plan costs.
 * So a plan carrying a stale price with zero-value installments totals zero and
 * is free. Deciding otherwise here would let Finance show "Free" while the
 * child's classes stayed locked, which is the exact divergence this fix exists
 * to remove. */
assert.strictEqual(isFreePlanSet([plan(9999, [0])]), true, 'installments override a stale price field');

console.log('free-program rule: 8/8 checks passed');
