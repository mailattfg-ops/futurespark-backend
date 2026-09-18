#!/usr/bin/env node
/**
 * Move a student's scheduled classes from one programme to another.
 *
 * Needed because a class stores the programme it was created with and never
 * revisits it. When a child is booked under the wrong programme — most often
 * the parent-account fallback, which offers the FAMILY's programme to a child
 * who has no paid enrolment of their own — every class made that day keeps the
 * wrong programme for good, and the scheduler groups them under it.
 *
 * A class also points at a Session row, and sessions belong to a programme. So
 * moving the programme without re-pointing the session would leave the class
 * showing a curriculum item from a programme it is no longer in. Sessions are
 * matched by `order`: Session 2 of L1 becomes Session 2 of L2.
 *
 * Dry run by default. Nothing is written until --apply.
 *
 *   node scripts/repoint-class-program.js --student niyafah@finquo.ai \
 *     --from "Financial Literacy - Pilot Program L1 (UAE)" \
 *     --to   "Financial Literacy - Pilot Program L2 (UAE)"
 *
 *   ... then the same command with --apply
 *
 * Flags:
 *   --student <email|id>   the child whose classes move (required)
 *   --from <title|id>      programme to move away from (required)
 *   --to <title|id>        programme to move into (required)
 *   --include-cancelled    cancelled classes are skipped unless this is given
 *   --apply                actually write
 */
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(REPO_ROOT, 'apps', 'auth-service');

// The root .env is the only one — see the repo's single-env rule.
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

const studentRef = value('--student');
const fromRef = value('--from');
const toRef = value('--to');
const includeCancelled = flag('--include-cancelled');
const apply = flag('--apply');

if (!studentRef || !fromRef || !toRef) {
  console.error('Usage: node scripts/repoint-class-program.js --student <email|id> --from <title|id> --to <title|id> [--include-cancelled] [--apply]');
  process.exit(1);
}

const { PrismaClient } = require(path.join(AUTH_DIR, 'prisma', 'client'));
const db = new PrismaClient();

const looksLikeId = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v);

const findProgram = async (ref) => {
  if (looksLikeId(ref)) return db.program.findUnique({ where: { id: ref } });
  const hits = await db.program.findMany({ where: { title: { equals: ref, mode: 'insensitive' } } });
  if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} programmes — pass the id instead.`);
  return hits[0] ?? null;
};

const ist = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

(async () => {
  const student = looksLikeId(studentRef)
    ? await db.student.findUnique({ where: { id: studentRef }, include: { enrollments: true } })
    : await db.student.findUnique({ where: { email: studentRef }, include: { enrollments: true } });
  if (!student) throw new Error(`No student for "${studentRef}".`);

  const from = await findProgram(fromRef);
  const to = await findProgram(toRef);
  if (!from) throw new Error(`No programme matched --from "${fromRef}".`);
  if (!to) throw new Error(`No programme matched --to "${toRef}".`);
  if (from.id === to.id) throw new Error('--from and --to are the same programme.');

  console.log(`\nStudent : ${student.firstName} ${student.lastName} <${student.email}>`);
  console.log(`From    : ${from.title}`);
  console.log(`To      : ${to.title}`);
  console.log(`Mode    : ${apply ? 'APPLY — rows will be written' : 'dry run — nothing will be written'}\n`);

  // Enrolment is not changed here, only reported: a class in a programme the
  // child is not enrolled in is the very mismatch this script exists to undo.
  const enrolledInTarget = student.enrollments.some((e) => e.programId === to.id);
  console.log(
    enrolledInTarget
      ? `Enrolment: already enrolled in "${to.title}"${
          student.enrollments.find((e) => e.programId === to.id)?.paymentApproved ? ' (paid)' : ' (UNPAID)'
        }`
      : `Enrolment: NOT enrolled in "${to.title}" — add it in Customers → Add Program, or the scheduler will not offer it.`
  );

  const classes = await db.scheduledClass.findMany({
    where: {
      studentId: student.id,
      programId: from.id,
      ...(includeCancelled ? {} : { status: { not: 'CANCELLED' } }),
    },
    orderBy: { startTime: 'asc' },
  });

  if (classes.length === 0) {
    console.log(`\nNo classes found on "${from.title}" for this student. Nothing to do.`);
    await db.$disconnect();
    return;
  }

  // Sessions of both programmes, keyed by order — the mapping the move needs.
  const [fromSessions, toSessions] = await Promise.all([
    db.session.findMany({ where: { programId: from.id }, select: { id: true, order: true, title: true } }),
    db.session.findMany({ where: { programId: to.id }, select: { id: true, order: true, title: true } }),
  ]);
  const fromById = new Map(fromSessions.map((s) => [s.id, s]));
  const toByOrder = new Map(toSessions.map((s) => [s.order, s]));

  const plan = [];
  const blocked = [];

  for (const cls of classes) {
    const oldSession = cls.sessionId ? fromById.get(cls.sessionId) : null;

    // A class with no session, or one whose session belongs elsewhere, still
    // moves — but its session is cleared rather than guessed at.
    if (!cls.sessionId) {
      plan.push({ cls, oldSession: null, newSession: null, note: 'no session attached' });
      continue;
    }
    if (!oldSession) {
      plan.push({ cls, oldSession: null, newSession: null, note: `session ${cls.sessionId} is not in "${from.title}" — will be cleared` });
      continue;
    }
    const newSession = toByOrder.get(oldSession.order);
    if (!newSession) {
      blocked.push({ cls, oldSession, reason: `"${to.title}" has no session at order ${oldSession.order}` });
      continue;
    }
    plan.push({ cls, oldSession, newSession, note: null });
  }

  console.log(`\n${classes.length} class(es) on "${from.title}":\n`);
  for (const row of plan) {
    const s = row.oldSession ? `S${row.oldSession.order}: ${row.oldSession.title}` : '(no session)';
    const t = row.newSession ? `S${row.newSession.order}: ${row.newSession.title}` : '(session cleared)';
    console.log(`  ${ist(row.cls.startTime)}  [${row.cls.status}]`);
    console.log(`      ${s}`);
    console.log(`   →  ${t}${row.note ? `   (${row.note})` : ''}`);
  }
  for (const row of blocked) {
    console.log(`  ${ist(row.cls.startTime)}  [${row.cls.status}]  BLOCKED — ${row.reason}`);
  }

  if (blocked.length) {
    console.log(`\n${blocked.length} class(es) cannot move: the target programme has no session at that order.`);
    console.log('Add the missing session to the target programme first, or move those classes by hand.');
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to write ${plan.length} change(s).`);
    await db.$disconnect();
    return;
  }

  // One transaction: a half-moved set would leave the student's history split
  // across two programmes with no record of why.
  await db.$transaction(
    plan.map((row) =>
      db.scheduledClass.update({
        where: { id: row.cls.id },
        data: { programId: to.id, sessionId: row.newSession ? row.newSession.id : null },
      })
    )
  );
  console.log(`\nDone. ${plan.length} class(es) moved to "${to.title}".`);
  if (!enrolledInTarget) {
    console.log('Remember the enrolment — without one the scheduler will not offer this programme for the next session.');
  }
  await db.$disconnect();
})().catch(async (err) => {
  console.error(`\nFAILED: ${err.message}`);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
