/**
 * Classes that have finished but were never marked complete.
 *
 * These are the ones that quietly cost you things: the mentor never signed off,
 * so the room can sit open holding a licensed Zoom seat, the recording sweep
 * never starts counting, and no report reaches the parent.
 *
 *   node scripts/unsigned-classes.js            # finished, still unsigned
 *   node scripts/unsigned-classes.js --days 30  # look further back (default 14)
 *   node scripts/unsigned-classes.js --all      # include demos
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('../apps/auth-service/prisma/client');

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const DAYS = flagValue('--days', 14);
const INCLUDE_DEMOS = args.includes('--all');

const main = async () => {
  const db = new PrismaClient();
  const now = new Date();
  const since = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);

  const rows = await db.scheduledClass.findMany({
    where: {
      // Finished by the clock, but nobody signed it off.
      endTime: { lt: now, gte: since },
      status: { notIn: ['COMPLETED', 'CANCELLED'] },
      ...(INCLUDE_DEMOS ? {} : { classType: 'REGULAR' }),
    },
    orderBy: { startTime: 'desc' },
    select: {
      id: true,
      startTime: true,
      endTime: true,
      status: true,
      classType: true,
      meetingLink: true,
      sessionId: true,
      student: { select: { firstName: true, lastName: true } },
      mentor: { select: { firstName: true, lastName: true, email: true } },
    },
  });

  if (rows.length === 0) {
    console.log(`No unsigned classes in the last ${DAYS} days. Every finished class has been marked complete.`);
    await db.$disconnect();
    return;
  }

  // Session titles come from the curriculum table, fetched in one go.
  const sessionIds = [...new Set(rows.map((r) => r.sessionId).filter(Boolean))];
  const sessions = sessionIds.length
    ? await db.session.findMany({ where: { id: { in: sessionIds } }, select: { id: true, title: true, order: true } })
    : [];
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  console.log(`${rows.length} finished class(es) never marked complete (last ${DAYS} days):\n`);

  /** Who is responsible, so the list can be chased rather than just read. */
  const byMentor = new Map();

  for (const r of rows) {
    const ageH = Math.round((now.getTime() - new Date(r.endTime).getTime()) / 3600000);
    const student = `${r.student?.firstName ?? ''} ${r.student?.lastName ?? ''}`.trim() || '(no student)';
    const mentor = `${r.mentor?.firstName ?? ''} ${r.mentor?.lastName ?? ''}`.trim() || '(unassigned)';
    const s = r.sessionId ? sessionById.get(r.sessionId) : null;
    const session = s ? `S${s.order}: ${s.title}` : r.classType === 'DEMO' ? 'Demo class' : '(no session)';

    console.log(`  ${new Date(r.startTime).toISOString().slice(0, 16).replace('T', ' ')}  ${ageH}h ago  [${r.status}]`);
    console.log(`     ${student} · ${session}`);
    console.log(`     mentor: ${mentor}${r.mentor?.email ? ` <${r.mentor.email}>` : ''}`);
    if (!r.meetingLink) console.log('     no meeting link on this class');
    console.log('');

    byMentor.set(mentor, (byMentor.get(mentor) ?? 0) + 1);
  }

  console.log('Unsigned per mentor:');
  [...byMentor.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([mentor, count]) => console.log(`  ${String(count).padStart(3)}  ${mentor}`));

  console.log(
    '\nMarking these complete now still generates the report, but will NOT close their Zoom rooms —\n' +
      'sign-off only ends a room within 3 hours of the class, so an old room is left alone in case\n' +
      'another class is using it.'
  );

  await db.$disconnect();
};

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
