#!/usr/bin/env node
/**
 * Why is the Messages inbox empty?
 *
 * Read-only. Answers, in order, the three things that can make the inbox show
 * "No contacts found" even though messages have been sent:
 *
 *   1. Are there any WhatsAppMessage rows at all?
 *   2. Do they carry a counterpart phone number the grouping can key on?
 *      (an OUTBOUND row keeps the customer in `to` and 'SYSTEM' in `from`;
 *      INBOUND is the reverse — a row with 'SYSTEM' on both ends threads
 *      nowhere)
 *   3. Does listThreads() actually return them, or throw?
 *
 * Phone numbers are masked. Nothing is written.
 *
 *   node scripts/whatsapp-inbox-doctor.js
 */
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const COMM_DIR = path.join(REPO_ROOT, 'apps', 'communication-service');

const envPath = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const { PrismaClient } = require(path.join(COMM_DIR, 'prisma', 'client'));
const db = new PrismaClient({ log: ['error'] });

const mask = (v) => {
  const s = String(v ?? '');
  if (!/\d/.test(s)) return s; // 'SYSTEM' and friends stay readable
  return s.length <= 4 ? s : `${'*'.repeat(s.length - 4)}${s.slice(-4)}`;
};
const ist = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

(async () => {
  console.log('\n─── 1. message rows ───────────────────────────────────────');
  const total = await db.whatsAppMessage.count();
  const byDirection = await db.whatsAppMessage.groupBy({ by: ['direction'], _count: { _all: true } });
  console.log(`total rows: ${total}`);
  for (const d of byDirection) console.log(`  ${d.direction}: ${d._count._all}`);
  if (total === 0) {
    console.log('\nNothing has been logged. The inbox is empty because no message row exists —');
    console.log('check WHATSAPP_OUTBOUND_MODE and the audience toggles, not the inbox code.');
    await db.$disconnect();
    return;
  }

  console.log('\n─── 2. the newest rows, as the grouping sees them ─────────');
  const baseSelect = {
    from: true, to: true, direction: true, type: true, body: true,
    status: true, createdAt: true,
  };
  // The media columns arrived with the inbox. If the database predates them,
  // every read of this table fails — which is itself the answer — so ask
  // without them rather than dying on the diagnosis.
  let rows;
  let mediaColumnsMissing = false;
  try {
    rows = await db.whatsAppMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: Object.assign({}, baseSelect, { mediaFile: true }),
    });
  } catch (err) {
    if (!/does not exist/i.test(String(err.message))) throw err;
    mediaColumnsMissing = true;
    rows = await db.whatsAppMessage.findMany({ orderBy: { createdAt: 'desc' }, take: 8, select: baseSelect });
    console.log('  !! mediaId / mediaFile / mediaMime are MISSING from this database.');
    console.log('     Every read of this table fails, so the inbox answers "Failed to load');
    console.log('     conversations". Fix: npm run db:push, then restart.');
    console.log('');
  }
  const digits = (v) => String(v ?? '').replace(/\D/g, '');
  let threadable = 0;
  for (const r of rows) {
    const counterpart = r.direction === 'INBOUND' ? digits(r.from) : digits(r.to);
    if (counterpart) threadable++;
    console.log(
      `  ${ist(r.createdAt)}  ${r.direction.padEnd(8)} ${r.type.padEnd(9)} ${r.status.padEnd(10)}` +
        ` from=${mask(r.from).padEnd(14)} to=${mask(r.to).padEnd(14)}` +
        ` threads-as=${counterpart ? mask(counterpart) : 'NOTHING — no phone on either end'}` +
        `${r.mediaFile ? '  [media]' : ''}`
    );
    console.log(`        "${String(r.body ?? '').replace(/\s+/g, ' ').slice(0, 70)}"`);
  }
  console.log(`\n${threadable}/${rows.length} of the newest rows can be grouped into a thread.`);

  console.log('\n─── 3. listThreads(), the call the inbox makes ────────────');
  if (mediaColumnsMissing) console.log('(expected to fail while those columns are absent)');
  try {
    // The server runs the compiled build; src/*.ts is only require-able with
    // ts-node, so prefer dist and say so if neither is there.
    const candidates = [
      path.join(COMM_DIR, 'dist', 'modules', 'whatsapp', 'conversations.service.js'),
      path.join(COMM_DIR, 'src', 'modules', 'whatsapp', 'conversations.service.ts'),
    ];
    const found = candidates.find((c) => fs.existsSync(c));
    if (!found) {
      console.log('conversations.service is not built here — run npm run build, then retry.');
      await db.$disconnect();
      return;
    }
    console.log(`using ${found.includes('dist') ? 'the compiled build' : 'the TypeScript source'}`);
    const { listThreads } = require(found);
    const threads = await listThreads(10, false);
    console.log(`returned ${threads.length} thread(s)`);
    for (const t of threads) {
      console.log(
        `  ${mask(t.phone)}  ${t.messageCount} msg  last ${ist(t.lastAt)} (${t.lastDirection})` +
          `  window ${t.windowOpen ? 'OPEN' : 'closed'}${t.hasMedia ? '  has media' : ''}`
      );
      console.log(`        "${String(t.lastMessage ?? '').replace(/\s+/g, ' ').slice(0, 70)}"`);
    }
    if (threads.length === 0) {
      console.log('\nRows exist but none grouped — see column 3 above for why.');
    } else {
      console.log('\nThe API layer is fine. If the page is still empty, the problem is between');
      console.log('the gateway and the browser: check that /api/whatsapp/conversations returns');
      console.log('this same JSON with an admin token, and that the running build has the route.');
    }
  } catch (err) {
    console.log(`listThreads threw: ${String(err.message).split('\n').slice(0, 4).join(' | ')}`);
    console.log('\nThat error is what the endpoint returns as "Failed to load conversations".');
  }

  await db.$disconnect();
})().catch(async (err) => {
  console.error(`\nFAILED: ${err.message}`);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
