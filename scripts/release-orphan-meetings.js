/**
 * Free Zoom/Meet host seats held by meetings whose class no longer exists.
 *
 * Deleting a class used to leave its meeting behind (fixed going forward in
 * schedule.service.releaseRoomIfUnused). Those leftovers still answer the
 * double-booking check and still hold a licensed seat, which is how you get
 * "This mentor is already booked..." for a class you deleted, and "All 3 Zoom
 * host seats are already hosting a meeting" when the calendar shows two.
 *
 * DRY RUN (prints what it would release, changes nothing):
 *   node scripts/release-orphan-meetings.js
 *
 * APPLY:
 *   node scripts/release-orphan-meetings.js --apply
 *
 * Options:
 *   --all   also release orphans already in the past (default: only meetings
 *           that can still block a booking, i.e. ending now or later)
 *
 * Marking the row CANCELLED is what frees the seat — both the allocator and the
 * double-booking check ignore CANCELLED. The meeting may still exist inside
 * Zoom; the script prints its join URL so you can delete it there if you want
 * the Zoom account tidy too.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { PrismaClient: AuthClient } = require('../apps/auth-service/prisma/client');
const { PrismaClient: IntegrationClient } = require('../apps/integration-service/prisma/client');

const APPLY = process.argv.includes('--apply');
const INCLUDE_PAST = process.argv.includes('--all');

/** The Zoom meeting id or Meet code inside a room URL — links carry ?pwd= and other noise. */
const roomCodeOf = (url) => {
  if (!url) return '';
  const zoom = String(url).match(/\/j\/(\d+)/);
  if (zoom && zoom[1]) return zoom[1];
  const tail = String(url).trim().split('?')[0].split('#')[0].split('/').pop() || '';
  return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(tail) ? tail : '';
};

const main = async () => {
  const auth = new AuthClient();
  const integration = new IntegrationClient();

  // Every room a real class still points at — these must never be touched.
  const classes = await auth.scheduledClass.findMany({
    where: { meetingLink: { not: null } },
    select: { meetingLink: true },
  });
  const liveExact = new Set();
  const liveCodes = new Set();
  for (const c of classes) {
    if (!c.meetingLink) continue;
    liveExact.add(c.meetingLink.trim());
    const code = roomCodeOf(c.meetingLink);
    if (code) liveCodes.add(code);
  }
  console.log(`${classes.length} class(es) currently hold ${liveCodes.size} distinct room(s).`);

  const where = { status: { not: 'CANCELLED' } };
  if (!INCLUDE_PAST) where.endTime = { gte: new Date() };

  const meetings = await integration.meeting.findMany({
    where,
    select: {
      id: true,
      title: true,
      provider: true,
      status: true,
      startTime: true,
      endTime: true,
      meetUrl: true,
      zoomJoinUrl: true,
      zoomHostEmail: true,
    },
    orderBy: { startTime: 'asc' },
  });

  const orphans = meetings.filter((m) => {
    const urls = [m.zoomJoinUrl, m.meetUrl].filter(Boolean);
    for (const u of urls) {
      if (liveExact.has(String(u).trim())) return false;
      const code = roomCodeOf(u);
      if (code && liveCodes.has(code)) return false;
    }
    return true;
  });

  console.log(
    `\n${meetings.length} active meeting(s) examined${INCLUDE_PAST ? '' : ' (ending now or later)'} — ` +
      `${orphans.length} hold a seat with NO class behind them.\n`
  );

  if (orphans.length === 0) {
    console.log('Nothing to release. If a booking is still blocked, the conflicting class is real.');
  }

  for (const m of orphans) {
    console.log(`  [${m.provider}] ${m.startTime.toISOString()} → ${m.endTime.toISOString()}`);
    console.log(`     title : ${m.title}`);
    console.log(`     seat  : ${m.zoomHostEmail || '(none recorded)'}`);
    console.log(`     room  : ${m.zoomJoinUrl || m.meetUrl}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to release these seats.');
  } else if (orphans.length > 0) {
    const { count } = await integration.meeting.updateMany({
      where: { id: { in: orphans.map((m) => m.id) } },
      data: { status: 'CANCELLED' },
    });
    console.log(`\nReleased ${count} seat(s). Re-try your booking — those windows are free now.`);
    console.log('The meetings may still be listed inside Zoom; delete them there if you want it tidy.');
  }

  await auth.$disconnect();
  await integration.$disconnect();
};

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
