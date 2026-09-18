#!/usr/bin/env node
/**
 * Give every child their own enrolment row, so the parent-level programme can
 * be retired.
 *
 * Programme and payment used to live on the PARENT (`ParentAccount.programId`
 * + `paymentApproved`), which works for one child and breaks for two: a family
 * with a child in L1 and a child in L2 has one programme field between them.
 * `Enrollment` — one row per child per programme, approved individually in
 * Finance — replaced it, but every screen still falls back to the parent's
 * programme when a child has no rows, and that fallback is what books children
 * into their sibling's programme.
 *
 * This creates the missing rows. Once every family has them the fallback can be
 * deleted from the code without anybody losing their programme.
 *
 * PAYMENT IS NOT COPIED TO EVERY CHILD. The old columns describe ONE enrolment,
 * so only one child can inherit the family's approval — the same rule
 * user.service already applies when adding a sibling. A child who has their own
 * `paymentApproved` keeps it; otherwise the earliest-created child inherits the
 * parent's, and later siblings land UNPAID and appear in Finance for approval.
 * Copying "paid" to a whole family would hand free classes to siblings who
 * never paid for them.
 *
 * Dry run by default. Nothing is written until --apply.
 *
 *   node scripts/backfill-child-enrolments.js
 *   node scripts/backfill-child-enrolments.js --parent parent1@gmail.com
 *   node scripts/backfill-child-enrolments.js --skip-student moved@child.com
 *   node scripts/backfill-child-enrolments.js --apply
 *
 * Flags:
 *   --parent <email|id>          only this family
 *   --skip-student <emails|ids>  comma-separated children to leave alone, for a
 *                                child who has moved out of the family's
 *                                programme and whose classes were re-pointed
 *   --apply                      actually write
 */
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(REPO_ROOT, 'apps', 'auth-service');

const envPath = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const apply = flag('--apply');
const parentFilter = value('--parent');
// A child who is not actually in the family's programme — usually because they
// moved level and their classes were re-pointed. Comma-separated emails or ids.
const skipStudents = new Set(
  (value('--skip-student') ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
);

const { PrismaClient } = require(path.join(AUTH_DIR, 'prisma', 'client'));
const db = new PrismaClient();

(async () => {
  const parents = await db.parentAccount.findMany({
    where: {
      programId: { not: null },
      ...(parentFilter
        ? /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(parentFilter)
          ? { id: parentFilter }
          : { email: parentFilter }
        : {}),
    },
    include: {
      program: { select: { id: true, title: true } },
      students: {
        orderBy: { createdAt: 'asc' },
        include: { enrollments: { select: { programId: true, paymentApproved: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\nMode    : ${apply ? 'APPLY — rows will be written' : 'dry run — nothing will be written'}`);
  console.log(`Parents : ${parents.length} with a parent-level programme${parentFilter ? ` (filtered to ${parentFilter})` : ''}\n`);

  if (parents.length === 0) {
    console.log('Nothing to backfill — no parent account carries a programme.');
    await db.$disconnect();
    return;
  }

  const toCreate = [];
  let alreadyFine = 0;
  let childless = 0;

  for (const parent of parents) {
    const programId = parent.programId;
    const title = parent.program?.title ?? programId;

    if (parent.students.length === 0) {
      childless++;
      console.log(`  ${parent.email}\n      no children yet — "${title}" will simply be dropped, nothing to carry over`);
      continue;
    }

    /* Who may inherit the family's single approval.
     *
     * Nobody, if a sibling ALREADY holds a paid enrolment for this programme:
     * the parent's flag describes that one seat, and handing it out again would
     * create a second paid enrolment the family never bought. Otherwise a child
     * with their own approval, else the earliest-created child.
     */
    const seatAlreadyHeld = parent.students.some((s) =>
      s.enrollments.some((e) => e.programId === programId && e.paymentApproved)
    );
    let inheritedBy = null;
    if (parent.paymentApproved && !seatAlreadyHeld) {
      const own = parent.students.find((s) => s.paymentApproved);
      inheritedBy = own ? own.id : parent.students[0].id;
    }

    console.log(
      `  ${parent.email}   programme "${title}"   family paid: ${parent.paymentApproved ? 'yes' : 'no'}` +
        (seatAlreadyHeld && parent.paymentApproved ? '   (seat already held by a sibling)' : '')
    );

    for (const student of parent.students) {
      if (skipStudents.has(student.email.toLowerCase()) || skipStudents.has(student.id.toLowerCase())) {
        console.log(`      ${student.email} — SKIPPED by --skip-student`);
        continue;
      }
      const has = student.enrollments.find((e) => e.programId === programId);
      if (has) {
        alreadyFine++;
        console.log(`      ${student.email} — already enrolled (${has.paymentApproved ? 'paid' : 'unpaid'}), untouched`);
        continue;
      }

      const paid = student.paymentApproved || student.id === inheritedBy;
      toCreate.push({
        studentId: student.id,
        programId,
        paymentApproved: paid,
        selectedPlanType: parent.selectedPlanType ?? null,
        paidInstallmentIds: paid ? parent.paidInstallmentIds ?? [] : [],
        _email: student.email,
        _why: student.paymentApproved
          ? 'own approval'
          : student.id === inheritedBy
            ? "inherits the family's approval"
            : 'sibling — starts unpaid, approve in Finance',
      });
      console.log(`      ${student.email} — CREATE enrolment, ${paid ? 'PAID' : 'UNPAID'} (${toCreate[toCreate.length - 1]._why})`);
    }
  }

  const unpaid = toCreate.filter((r) => !r.paymentApproved).length;
  console.log(`\nSummary: ${toCreate.length} enrolment(s) to create — ${toCreate.length - unpaid} paid, ${unpaid} unpaid`);
  console.log(`         ${alreadyFine} child(ren) already had the row; ${childless} parent(s) have no children.`);
  if (unpaid) {
    console.log(`\n${unpaid} child(ren) will need approving in Finance before their classes can be scheduled.`);
    console.log('That is deliberate: the parent-level columns describe one paid enrolment, not one per sibling.');
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    await db.$disconnect();
    return;
  }

  if (toCreate.length === 0) {
    console.log('\nNothing to write.');
    await db.$disconnect();
    return;
  }

  // One transaction: a half-finished backfill leaves some children on the
  // fallback and some not, which is harder to reason about than either end.
  await db.$transaction(
    toCreate.map(({ _email, _why, ...data }) =>
      db.enrollment.create({ data })
    )
  );
  console.log(`\nDone. ${toCreate.length} enrolment(s) created.`);
  console.log('Re-run without --apply to confirm it now reports nothing left to create.');
  await db.$disconnect();
})().catch(async (err) => {
  console.error(`\nFAILED: ${err.message}`);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
