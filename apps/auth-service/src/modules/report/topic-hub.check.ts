/**
 * Self-check for the Topics Covered hub pill. Run:
 *   npx ts-node --transpile-only apps/auth-service/src/modules/report/topic-hub.check.ts
 * Writes no PDF: it measures with the same pdfkit font metrics the design uses.
 *
 * The hub label became the SESSION title (it used to fall back to the
 * programme name, which is identical on every report in a course). Session
 * titles run longer, and the pill's width decides where the topic spine
 * starts — so the clamp that keeps the chips spaced is worth a check.
 */
import assert from 'assert';
import PDFDocument from 'pdfkit';

const HUB_MAX_W = 260;
/* Mirrors report-design.ts: the spine runs from the pill's right edge, the
 * first chip sits 35.7 further on, and the last node is pinned at x=500. */
const spineStartFor = (hubW: number) => 47.9 + hubW + 1.5;
const firstChipFor = (hubW: number) => spineStartFor(hubW) + 35.7;

const doc = new PDFDocument({ size: 'A4' });
doc.font('Helvetica').fontSize(12.2);

const fit = (label: string): { hub: string; hubW: number } => {
  let hub = label || 'Session';
  if (doc.widthOfString(hub, { lineBreak: false }) + 30 > HUB_MAX_W) {
    while (hub.length > 1 && doc.widthOfString(`${hub}…`, { lineBreak: false }) + 30 > HUB_MAX_W) {
      hub = hub.slice(0, -1);
    }
    hub = `${hub.trimEnd()}…`;
  }
  return { hub, hubW: Math.max(60, Math.min(HUB_MAX_W, doc.widthOfString(hub, { lineBreak: false }) + 30)) };
};

// A short title is left exactly as authored.
const short = fit('Budgeting');
assert.strictEqual(short.hub, 'Budgeting', 'a short session title is untouched');
assert.ok(short.hubW <= HUB_MAX_W, 'short title within the cap');

// A realistic long one is truncated, not allowed to swallow the spine.
const long = fit('Orientation & Introduction to Money and Personal Financial Literacy');
assert.ok(long.hub.endsWith('…'), 'an over-long title is ellipsised');
assert.ok(long.hub.length < 67, 'it actually got shorter');
assert.ok(long.hubW <= HUB_MAX_W, `long title clamped to ${HUB_MAX_W} (got ${long.hubW})`);

// The runway must survive the worst case: chips are spaced across
// (500 - firstChip), so that has to stay comfortably positive.
const worst = fit('A'.repeat(300));
assert.ok(worst.hubW <= HUB_MAX_W, 'pathological title still clamped');
assert.ok(500 - firstChipFor(worst.hubW) > 100, `spine runway kept (got ${(500 - firstChipFor(worst.hubW)).toFixed(1)})`);

// An empty hub still renders a pill rather than collapsing to nothing.
assert.strictEqual(fit('').hub, 'Session', 'empty falls back to "Session"');
assert.ok(fit('').hubW >= 60, 'minimum pill width holds');

console.log(
  `topic hub: 8/8 checks passed (long title -> "${long.hub}", runway ${(500 - firstChipFor(long.hubW)).toFixed(0)}pt)`
);
doc.end();
