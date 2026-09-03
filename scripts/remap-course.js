/**
 * Move students from the one accidental catch-all programme onto their real
 * level programmes (L1 / L2 / ...). Run from the backend root on the server.
 *
 * DRY RUN (prints the full plan, changes nothing):
 *   node scripts/remap-course.js --from "Old Course Title" --map "L1=Level 1 Course Title" --map "L2=Level 2 Course Title"
 *
 * APPLY (same command plus --apply):
 *   node scripts/remap-course.js --from "..." --map "L1=..." --map "L2=..." --apply
 *
 * Which level a student belongs to comes from Student.level (the L1/L2 on the
 * directory card). A student whose level is empty or has no --map entry is
 * listed as UNRESOLVED and left untouched — fix the level in the admin app or
 * add an override:  --student "child@email.com=L2"
 *
 * What one remap touches, and why each piece matters:
 *   Enrollment.programId        the enrolment itself (course name everywhere)
 *   Enrollment.paidInstallmentIds  re-pointed at the new programme's matching
 *                               installments (same plan type + order) so paid
 *                               sessions stay unlocked
 *   ScheduledClass programId+sessionId  past and future classes move to the
 *                               new programme's session rows (matched by
 *                               title, then by order) so progress counts stay right
 *   ParentAccount.programId     legacy per-family course pointer parents still see
 *   User.qualifiedPrograms      mentors qualified for the old course get the new
 *                               ones added, or the scheduler would hide them all
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('../apps/auth-service/prisma/client');
const db = new PrismaClient();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const getAll = (flag) =>
  args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const FROM = getAll('--from')[0];
const MAPS = Object.fromEntries(
  getAll('--map').map((m) => {
    const [k, ...rest] = m.split('=');
    return [k.trim().toUpperCase(), rest.join('=').trim()];
  })
);
const OVERRIDES = Object.fromEntries(
  getAll('--student').map((m) => {
    const [email, key] = m.split('=');
    return [email.trim().toLowerCase(), (key || '').trim().toUpperCase()];
  })
);
if (!FROM || Object.keys(MAPS).length === 0) {
  console.log('Usage: node scripts/remap-course.js --from "Old Title" --map "L1=New L1 Title" --map "L2=New L2 Title" [--student "email=L1"] [--apply]');
  process.exit(1);
}

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const main = async () => {
  // ── Resolve programmes ──────────────────────────────────────────────────
  const programs = await db.program.findMany({
    include: {
      sessions: { orderBy: { order: 'asc' } },
      paymentPlans: { include: { installments: { orderBy: { order: 'asc' } } } },
    },
  });
  const byTitle = (t) => programs.find((p) => p.id === t || norm(p.title) === norm(t));
  const oldProg = byTitle(FROM);
  if (!oldProg) {
    console.log(`No programme titled "${FROM}". Available:`);
    programs.forEach((p) => console.log(`  - ${p.title}`));
    process.exit(1);
  }
  const targets = {};
  for (const [key, title] of Object.entries(MAPS)) {
    const p = byTitle(title);
    if (!p) { console.log(`--map ${key}: no programme titled "${title}"`); process.exit(1); }
    if (p.id === oldProg.id) { console.log(`--map ${key} points at the OLD programme itself.`); process.exit(1); }
    targets[key] = p;
  }

  console.log(`\nFROM: "${oldProg.title}" (${oldProg.sessions.length} sessions)`);
  for (const [k, p] of Object.entries(targets)) {
    console.log(`  ${k} -> "${p.title}" (${p.sessions.length} sessions)`);
    if (p.sessions.length === 0)
      console.log(`     !! WARNING: target has NO sessions — scheduled classes cannot be re-pointed. Copy the curriculum in first.`);
  }

  // session in target matching an old session: same title, else same order slot
  const matchSession = (oldSession, target) =>
    target.sessions.find((s) => norm(s.title) === norm(oldSession.title)) ||
    target.sessions.find((s) => s.order === oldSession.order) ||
    null;

  // old installment id -> target installment id via (plan type, order)
  const matchInstallment = (oldInstId, target) => {
    for (const plan of oldProg.paymentPlans) {
      const inst = plan.installments.find((i) => i.id === oldInstId);
      if (!inst) continue;
      const tPlan = target.paymentPlans.find((p2) => p2.type === plan.type);
      const tInst = tPlan && tPlan.installments.find((i) => i.order === inst.order);
      return tInst ? tInst.id : null;
    }
    return null;
  };

  // ── Plan per enrolled student ───────────────────────────────────────────
  const enrollments = await db.enrollment.findMany({
    where: { programId: oldProg.id },
    include: { student: { select: { id: true, email: true, firstName: true, lastName: true, level: true, country: true, parentAccountId: true } } },
  });
  console.log(`\n${enrollments.length} student(s) enrolled on the old programme.\n`);

  const unresolved = [];
  const plans = [];
  for (const enr of enrollments) {
    const st = enr.student;
    // Map keys can be plain "L1" or level+country like "L1-INDIA" / "L2-UAE",
    // matching however many courses the level was split into.
    const levelKey = OVERRIDES[st.email.toLowerCase()] || (st.level || '').toUpperCase().replace(/\s+/g, '');
    const c = (st.country || '').toUpperCase();
    const countryKey = c.includes('EMIRATES') || c.trim() === 'UAE' ? 'UAE' : c.includes('INDIA') ? 'INDIA' : c.replace(/\s+/g, '');
    const key = targets[`${levelKey}-${countryKey}`] ? `${levelKey}-${countryKey}` : levelKey;
    const target = targets[key];
    const name = `${st.firstName} ${st.lastName} <${st.email}>`;
    if (!target) {
      unresolved.push(`${name} — level "${st.level ?? '(empty)'}", country "${st.country ?? '(empty)'}" (key "${levelKey}-${countryKey}") has no --map entry`);
      continue;
    }

    const classes = await db.scheduledClass.findMany({
      where: {
        studentId: st.id,
        OR: [{ programId: oldProg.id }, { sessionId: { in: oldProg.sessions.map((s) => s.id) } }],
      },
      select: { id: true, sessionId: true, status: true },
    });
    const classMoves = classes.map((c) => {
      const oldSession = oldProg.sessions.find((s) => s.id === c.sessionId) || null;
      const newSession = oldSession ? matchSession(oldSession, target) : null;
      return { id: c.id, status: c.status, oldTitle: oldSession?.title ?? '(no session)', newSessionId: newSession?.id ?? null, newTitle: newSession?.title ?? null };
    });
    const paidMoves = enr.paidInstallmentIds.map((id) => ({ old: id, next: matchInstallment(id, target) }));

    plans.push({ enr, st, target, classMoves, paidMoves, name });
    console.log(`${name}`);
    console.log(`  ${key} -> "${target.title}"`);
    console.log(`  payment: approved=${enr.paymentApproved}, plan=${enr.selectedPlanType ?? '-'}, paid installments ${enr.paidInstallmentIds.length} (${paidMoves.filter((p) => p.next).length} matched on new programme)`);
    for (const m of classMoves)
      console.log(`  class [${m.status}] "${m.oldTitle}" -> ${m.newTitle ? `"${m.newTitle}"` : '!! NO MATCHING SESSION — left as is'}`);
    console.log('');
  }

  if (unresolved.length) {
    console.log('UNRESOLVED (untouched — set Student.level in the admin app or pass --student "email=L1"):');
    unresolved.forEach((u) => console.log(`  - ${u}`));
    console.log('');
  }

  // ── Parents still on the legacy pointer, mentors' qualifications ────────
  const parents = await db.parentAccount.findMany({
    where: { programId: oldProg.id },
    select: { id: true, email: true },
  });
  const parentTarget = (pid) => plans.find((p) => p.st.parentAccountId === pid)?.target ?? null;
  console.log(`${parents.length} parent account(s) carry the legacy course pointer; each follows their child's new programme.`);

  const mentors = await db.user.findMany({
    where: { qualifiedPrograms: { has: oldProg.id } },
    select: { id: true, email: true, qualifiedPrograms: true },
  });
  const newIds = Object.values(targets).map((t) => t.id);
  console.log(`${mentors.length} mentor(s) qualified for the old programme get the new programme(s) added.\n`);

  if (!APPLY) {
    console.log('DRY RUN — nothing changed. Re-run with --apply to execute.');
    return;
  }

  // ── Apply ───────────────────────────────────────────────────────────────
  for (const p of plans) {
    await db.$transaction(async (tx) => {
      const existing = await tx.enrollment.findUnique({
        where: { studentId_programId: { studentId: p.st.id, programId: p.target.id } },
      });
      const paid = p.paidMoves.map((m) => m.next).filter(Boolean);
      if (existing) {
        // already enrolled on the target (partial earlier fix) — merge and drop the old row
        await tx.enrollment.update({
          where: { id: existing.id },
          data: {
            paymentApproved: existing.paymentApproved || p.enr.paymentApproved,
            selectedPlanType: existing.selectedPlanType ?? p.enr.selectedPlanType,
            paidInstallmentIds: [...new Set([...existing.paidInstallmentIds, ...paid])],
          },
        });
        await tx.enrollment.delete({ where: { id: p.enr.id } });
      } else {
        await tx.enrollment.update({
          where: { id: p.enr.id },
          data: { programId: p.target.id, paidInstallmentIds: paid },
        });
      }
      for (const m of p.classMoves) {
        await tx.scheduledClass.update({
          where: { id: m.id },
          data: { programId: p.target.id, ...(m.newSessionId ? { sessionId: m.newSessionId } : {}) },
        });
      }
    });
    console.log(`applied: ${p.name} -> "${p.target.title}"`);
  }

  for (const parent of parents) {
    const t = parentTarget(parent.id);
    if (t) {
      await db.parentAccount.update({ where: { id: parent.id }, data: { programId: t.id } });
      console.log(`parent ${parent.email} -> "${t.title}"`);
    } else {
      console.log(`parent ${parent.email} — child unresolved, pointer left on the old programme`);
    }
  }

  for (const mentor of mentors) {
    await db.user.update({
      where: { id: mentor.id },
      data: { qualifiedPrograms: [...new Set([...mentor.qualifiedPrograms, ...newIds])] },
    });
  }
  if (mentors.length) console.log(`${mentors.length} mentor(s) now qualified for the new programme(s).`);

  console.log('\nDone. Spot-check one student portal and one parent view before deleting the old programme.');
};

main()
  .catch((e) => { console.error('FAILED:', e.message); process.exit(1); })
  .finally(() => db.$disconnect());
