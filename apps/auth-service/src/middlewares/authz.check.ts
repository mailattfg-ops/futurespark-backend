/**
 * Self-check for the BOLA/BFLA gates. Run:
 *   npx ts-node --transpile-only apps/auth-service/src/middlewares/authz.check.ts
 * Pure logic — fake req/res, no server, no database.
 *
 * These mirror the audit's attack scenarios: a student token reaching for the
 * student list, another child's record, a password reset, a role it typed into
 * a header itself. Every one must end in 403, and every legitimate caller must
 * still pass.
 */
import assert from 'assert';
import { requireRole, allowSelfOr } from './identity';

/** Runs a gate and reports what it decided. */
const outcome = (gate: any, role: string, userId: string, params: Record<string, string> = {}) => {
  let status = 0;
  let passed = false;
  const req: any = { headers: { 'x-user-role': role, 'x-user-id': userId }, params };
  const res: any = { status: (s: number) => ({ json: (_: any) => { status = s; } }) };
  gate(req, res, () => { passed = true; });
  return passed ? 'PASS' : status;
};

const STAFF_VIEW = ['ADMIN', 'SCHEDULER', 'FINANCE_ADMIN', 'QA_AUDITOR', 'WAREHOUSE_ADMIN', 'ENROLLMENT_ADVISOR'];

// ── Test: student calling bulk student list (audit scenario 2) ────────────
const listGate = requireRole(...STAFF_VIEW);
assert.strictEqual(outcome(listGate, 'STUDENT', 's1'), 403, 'student is refused the student list');
assert.strictEqual(outcome(listGate, 'PARENT', 'p1'), 403, 'parent is refused the student list');
assert.strictEqual(outcome(listGate, 'TEACHER', 't1'), 403, 'mentor is refused the full directory');
assert.strictEqual(outcome(listGate, 'DISPLAY', 'd1'), 403, 'the wall display reads nothing here');
assert.strictEqual(outcome(listGate, 'ADMIN', 'a1'), 'PASS', 'admin still lists students');
assert.strictEqual(outcome(listGate, 'SCHEDULER', 'sc1'), 'PASS', 'scheduler still lists students');
assert.strictEqual(outcome(listGate, 'FINANCE_ADMIN', 'f1'), 'PASS', 'finance dashboard still works');

// ── Test: student reaching another student by id (audit scenarios 1, 6) ───
const recordGate = allowSelfOr('id', ...STAFF_VIEW);
assert.strictEqual(outcome(recordGate, 'STUDENT', 'student-A', { id: 'student-B' }), 403, 'changing the id in the URL gains nothing');
assert.strictEqual(outcome(recordGate, 'STUDENT', 'student-A', { id: 'student-A' }), 'PASS', 'their own record still opens');
assert.strictEqual(outcome(recordGate, 'PARENT', 'parent-A', { id: 'parent-B' }), 403, 'IDOR on another family is refused');
assert.strictEqual(outcome(recordGate, 'PARENT', 'parent-A', { id: 'parent-A' }), 'PASS', 'a parent reads their own account');
assert.strictEqual(outcome(recordGate, 'ADMIN', 'a1', { id: 'student-B' }), 'PASS', 'staff read any record');

// ── Test: password reset stays staff-only (the takeover route) ────────────
const resetGate = requireRole('ADMIN', 'SCHEDULER');
assert.strictEqual(outcome(resetGate, 'STUDENT', 's1'), 403, 'a student cannot reset passwords');
assert.strictEqual(outcome(resetGate, 'TEACHER', 't1'), 403, 'nor can a mentor');
assert.strictEqual(outcome(resetGate, 'QA_AUDITOR', 'q1'), 403, 'view-only staff cannot reset either');
assert.strictEqual(outcome(resetGate, 'ADMIN', 'a1'), 'PASS', 'admin resets passwords');

// ── Test: forged / absent identity headers (audit scenario 5) ─────────────
// These headers are HMAC-verified upstream, but the gates themselves must
// still refuse garbage rather than pass it.
assert.strictEqual(outcome(listGate, '', ''), 403, 'no role header: refused');
assert.strictEqual(outcome(listGate, 'admin', 'a1'), 403, 'role matching is exact — "admin" is not ADMIN');
assert.strictEqual(outcome(recordGate, '', '', { id: 'x' }), 403, 'no identity: self-check cannot pass');
const emptyParam = allowSelfOr('id', 'ADMIN');
assert.strictEqual(outcome(emptyParam, 'STUDENT', '', { id: '' }), 403, 'empty id never equals empty identity');

// ── Test: mentor manages own calendar only ────────────────────────────────
const calGate = allowSelfOr('id', 'ADMIN', 'SCHEDULER');
assert.strictEqual(outcome(calGate, 'TEACHER', 'mentor-A', { id: 'mentor-A' }), 'PASS', 'a mentor edits their own availability');
assert.strictEqual(outcome(calGate, 'TEACHER', 'mentor-A', { id: 'mentor-B' }), 403, 'but not a colleague\'s');

console.log('authz gates: 21/21 refusal and passage checks passed');
