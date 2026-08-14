import PDFDocument from 'pdfkit';
import { parseClassSummary, toPdfSafeText, truncate, type ParsedSummary } from './summary-parser';

/**
 * Renders the parent-facing session report.
 *
 * Printed on white with the product's own purple, because this document is read
 * on a phone in a WhatsApp thread and often printed for a fridge door — the
 * admin panel's dark theme is unreadable in both. Only the built-in Helvetica
 * family is used, so there is no font file to ship, no embedding step, and no
 * chance of a missing font turning a real report into blank boxes. The cost is a
 * WinAnsi character set, which `toPdfSafeText` already accounts for.
 */

const BRAND = {
  purple: '#714ade',
  purpleDim: '#4c2eb0',
  teal: '#09b1bb',
  amber: '#f8721f',
  ink: '#101322',
  body: '#33384d',
  muted: '#6b7280',
  hairline: '#e3e2ee',
  wash: '#f6f5fc',
};

const PAGE = {
  size: 'A4' as const,
  margin: 48,
  // A4 is 595.28pt wide; 48pt margins leave a 499pt column, which sets running
  // text at roughly 90 characters — wide, so body copy is set at 10.5/16 to keep
  // the measure comfortable.
  width: 595.28 - 96,
};

export interface ReportContext {
  studentName: string;
  parentName?: string | null;
  mentorName: string;
  programName: string;
  sessionTitle: string;
  sessionNumber?: number | null;
  /** Already formatted for the family's locale by the caller. */
  classDate: string;
  classTime: string;
  durationLabel?: string | null;
  brandName: string;
  /** Quiz outcome, when the mentor has already marked it. */
  quizScore?: number | null;
  quizMaxScore?: number | null;
  mentorNote?: string | null;
  contactLine?: string | null;
}

export interface RenderedReport {
  buffer: Buffer;
  fileName: string;
  parsed: ParsedSummary;
}

/**
 * Filename the parent sees in WhatsApp.
 *
 * Cut on a word boundary, not mid-word: a hard slice produced
 * "Compound-Interest-in-Real-Li_Report.pdf", which looks like a corrupted
 * download rather than a document someone made for you.
 */
const buildFileName = (ctx: ReportContext): string => {
  const slug = (value: string, max: number) => {
    const words = toPdfSafeText(value)
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .filter(Boolean);

    const kept: string[] = [];
    for (const word of words) {
      const candidate = kept.length === 0 ? word : `${kept.join('-')}-${word}`;
      if (candidate.length > max) break;
      kept.push(word);
    }
    // A single word longer than the budget still has to appear somehow.
    return kept.length > 0 ? kept.join('-') : words[0]?.slice(0, max) ?? '';
  };

  const parts = [slug(ctx.studentName, 24) || 'Student', slug(ctx.sessionTitle, 32) || 'Session'];
  return `${parts.join('_')}_Report.pdf`;
};

export const renderSessionReportPdf = async (
  ctx: ReportContext,
  rawSummary: string
): Promise<RenderedReport> => {
  const parsed = parseClassSummary(rawSummary);

  const doc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
    bufferPages: true, // required for the "Page N of M" footer
    info: {
      Title: `${ctx.studentName} — ${ctx.sessionTitle}`,
      Author: ctx.brandName,
      Subject: `Session progress report for ${ctx.programName}`,
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  drawMasthead(doc, ctx);
  drawFactStrip(doc, ctx);
  if (parsed.metrics.length > 0) drawMetrics(doc, parsed);
  if (ctx.quizScore !== null && ctx.quizScore !== undefined) drawQuizResult(doc, ctx);
  drawSections(doc, parsed);
  if (ctx.mentorNote) drawMentorNote(doc, ctx);
  drawFooters(doc, ctx);

  doc.end();
  const buffer = await finished;

  return { buffer, fileName: buildFileName(ctx), parsed };
};

/* ── Drawing ─────────────────────────────────────────────────────────────── */

type Doc = PDFKit.PDFDocument;

const text = (value: string | null | undefined): string => toPdfSafeText(value ?? '').trim();

/** "HIGH" -> "High". The metrics block shouts; a report card should not. */
const titleCaseWord = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
};

const drawMasthead = (doc: Doc, ctx: ReportContext): void => {
  const top = PAGE.margin;

  // A solid band rather than a logo: there is no image asset to depend on, and a
  // missing one would leave a hole at the top of every report.
  doc.save();
  doc.rect(0, 0, doc.page.width, 96).fill(BRAND.purple);
  doc.rect(0, 92, doc.page.width, 4).fill(BRAND.amber);
  doc.restore();

  doc
    .fillColor('#ffffff')
    .font('Helvetica-Bold')
    .fontSize(17)
    .text(text(ctx.brandName).toUpperCase(), PAGE.margin, top - 12, { characterSpacing: 1.4 });

  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor('#e7e1ff')
    .text('SESSION PROGRESS REPORT', PAGE.margin, top + 12, { characterSpacing: 2 });

  doc.y = 128;

  doc
    .fillColor(BRAND.ink)
    .font('Helvetica-Bold')
    .fontSize(21)
    .text(text(ctx.studentName), PAGE.margin, doc.y, { width: PAGE.width });

  const sessionLabel = ctx.sessionNumber
    ? `Session ${ctx.sessionNumber} — ${text(ctx.sessionTitle)}`
    : text(ctx.sessionTitle);

  doc
    .moveDown(0.25)
    .font('Helvetica')
    .fontSize(11.5)
    .fillColor(BRAND.purpleDim)
    .text(text(ctx.programName), { width: PAGE.width })
    .fillColor(BRAND.muted)
    .fontSize(10.5)
    .text(sessionLabel, { width: PAGE.width });

  doc.moveDown(0.9);
};

/** Date / mentor / duration, as a hairline-ruled row of label-value pairs. */
const drawFactStrip = (doc: Doc, ctx: ReportContext): void => {
  const facts: Array<[string, string]> = [
    ['Date', text(ctx.classDate)],
    ['Time', text(ctx.classTime)],
    ['Mentor', text(ctx.mentorName)],
  ];
  if (ctx.durationLabel) facts.push(['Duration', text(ctx.durationLabel)]);

  const top = doc.y;
  const height = 46;

  doc.save();
  doc.roundedRect(PAGE.margin, top, PAGE.width, height, 6).fill(BRAND.wash);
  doc.restore();

  const columnWidth = PAGE.width / facts.length;
  facts.forEach(([label, value], index) => {
    const x = PAGE.margin + index * columnWidth + 14;
    const width = columnWidth - 20;

    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(BRAND.muted)
      .text(label.toUpperCase(), x, top + 10, { width, characterSpacing: 1, lineBreak: false, ellipsis: true });

    // `ellipsis` is what keeps this inside its column. With lineBreak:false and
    // no ellipsis, PDFKit draws the full string past `width` — a long mentor
    // name ran straight through the cell to its right.
    doc
      .font('Helvetica-Bold')
      .fontSize(10.5)
      .fillColor(BRAND.ink)
      .text(value || '-', x, top + 23, { width, lineBreak: false, ellipsis: true });
  });

  doc.y = top + height + 22;
};

const drawSectionHeading = (doc: Doc, heading: string): void => {
  ensureSpace(doc, 64);
  const y = doc.y;

  // Accent tick to the left of the heading — cheap, and it gives the eye
  // something to scan down when the report runs to two or three pages.
  doc.save();
  doc.rect(PAGE.margin, y + 2, 3, 12).fill(BRAND.teal);
  doc.restore();

  doc
    .font('Helvetica-Bold')
    .fontSize(11.5)
    .fillColor(BRAND.ink)
    .text(heading, PAGE.margin + 12, y, { width: PAGE.width - 12 });

  doc.moveDown(0.45);
};

const drawMetrics = (doc: Doc, parsed: ParsedSummary): void => {
  // Only the handful a parent can act on. The full list runs to eight rows of
  // word counts, which reads as instrumentation rather than as a report.
  //
  // Each card gets a `format` because the raw metric strings are written for a
  // log, not a card: "61% Priya Raman / 39% Aarav" is 27 characters and will not
  // fit in a 135pt cell at any readable size. What a parent wants from it is one
  // number — how much of the hour their own child spoke.
  const wanted: Array<{ match: RegExp; label: string; format?: (value: string) => string }> = [
    { match: /engagement rating/i, label: 'Engagement', format: (v) => titleCaseWord(v) },
    {
      match: /contribution share|speaker.*share/i,
      label: 'Student talk time',
      // "{mentor}% {name} / {student}% {name}" — the SECOND percentage is the
      // child's, matching how learning-service composes the line.
      format: (v) => {
        const percentages = v.match(/\d{1,3}\s*%/g);
        return percentages && percentages.length >= 2 ? percentages[1].replace(/\s+/g, '') : truncate(v, 18);
      },
    },
    { match: /question.*(asked|exchange)|interactive prompt/i, label: 'Questions asked', format: (v) => (v.match(/\d+/)?.[0] ?? v) },
  ];

  const cards = wanted
    .map(({ match, label, format }) => {
      const metric = parsed.metrics.find((m) => match.test(m.label));
      if (!metric) return null;
      const value = (format ? format(metric.value) : metric.value).trim();
      return value.length > 0 ? { label, value: truncate(value, 18) } : null;
    })
    .filter((card): card is { label: string; value: string } => card !== null);

  if (cards.length === 0) return;

  drawSectionHeading(doc, 'How the session went');

  const top = doc.y;
  const gap = 10;
  const cardWidth = (PAGE.width - gap * (cards.length - 1)) / cards.length;
  const height = 54;

  cards.forEach((card, index) => {
    const x = PAGE.margin + index * (cardWidth + gap);

    doc.save();
    doc.roundedRect(x, top, cardWidth, height, 6).fill('#ffffff');
    doc.roundedRect(x, top, cardWidth, height, 6).lineWidth(0.8).stroke(BRAND.hairline);
    doc.restore();

    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(BRAND.muted)
      .text(card.label.toUpperCase(), x + 12, top + 12, {
        width: cardWidth - 24,
        characterSpacing: 0.8,
        lineBreak: false,
        ellipsis: true,
      });

    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(BRAND.purpleDim)
      .text(card.value, x + 12, top + 27, { width: cardWidth - 24, lineBreak: false, ellipsis: true });
  });

  doc.y = top + height + 20;
};

const drawQuizResult = (doc: Doc, ctx: ReportContext): void => {
  drawSectionHeading(doc, 'Quiz result');

  const score = ctx.quizScore ?? 0;
  const max = ctx.quizMaxScore ?? 0;
  const label = max > 0 ? `${score} out of ${max} points` : `${score} points`;

  const top = doc.y;
  doc.save();
  doc.roundedRect(PAGE.margin, top, PAGE.width, 38, 6).fill(BRAND.wash);
  doc.restore();

  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor(BRAND.purpleDim)
    .text(label, PAGE.margin + 14, top + 12, { width: PAGE.width - 28, lineBreak: false });

  doc.y = top + 38 + 20;
};

const drawSections = (doc: Doc, parsed: ParsedSummary): void => {
  for (const section of parsed.sections) {
    if (section.bullets.length === 0 && section.paragraphs.length === 0) continue;

    drawSectionHeading(doc, section.title);

    for (const paragraph of section.paragraphs) {
      doc.font('Helvetica').fontSize(10.5);
      ensureSpace(doc, doc.heightOfString(paragraph, { width: PAGE.width, lineGap: 3.5 }) + 6);

      doc
        .fillColor(BRAND.body)
        .text(paragraph, PAGE.margin, doc.y, { width: PAGE.width, align: 'left', lineGap: 3.5 });
      doc.moveDown(0.4);
    }

    for (const bullet of section.bullets) {
      // Measure the whole bullet and reserve room for all of it. A flat estimate
      // let a three-line bullet start at the bottom of a page: PDFKit wrapped it
      // onto the next page by itself and left the "•" marker behind, alone, on
      // the previous one.
      doc.font('Helvetica').fontSize(10.5);
      const height = doc.heightOfString(bullet, { width: PAGE.width - 16, lineGap: 3.5 });
      ensureSpace(doc, height + 6);

      const y = doc.y;

      doc
        .font('Helvetica-Bold')
        .fontSize(10.5)
        .fillColor(BRAND.teal)
        .text('•', PAGE.margin + 2, y, { width: 10, lineBreak: false });

      doc
        .font('Helvetica')
        .fontSize(10.5)
        .fillColor(BRAND.body)
        .text(bullet, PAGE.margin + 16, y, { width: PAGE.width - 16, align: 'left', lineGap: 3.5 });

      doc.moveDown(0.35);
    }

    doc.moveDown(0.7);
  }
};

const drawMentorNote = (doc: Doc, ctx: ReportContext): void => {
  drawSectionHeading(doc, `A note from ${text(ctx.mentorName)}`);

  const note = text(ctx.mentorNote);

  // Measure with the font already selected — heightOfString reads the current
  // font and size, so measuring before setting them silently sizes the panel
  // against whatever the previous block used.
  doc.font('Helvetica-Oblique').fontSize(10.5);
  const height = doc.heightOfString(note, { width: PAGE.width - 30, lineGap: 3.5 });

  // Reserve the panel BEFORE reading doc.y: ensureSpace may break to a new page,
  // which moves the cursor the panel is drawn from.
  ensureSpace(doc, height + 34);
  const top = doc.y;

  doc.save();
  doc.roundedRect(PAGE.margin, top, PAGE.width, height + 24, 6).fill(BRAND.wash);
  doc.rect(PAGE.margin, top, 3, height + 24).fill(BRAND.amber);
  doc.restore();

  doc
    .font('Helvetica-Oblique')
    .fontSize(10.5)
    .fillColor(BRAND.body)
    .text(note, PAGE.margin + 16, top + 12, { width: PAGE.width - 30, lineGap: 3.5 });

  doc.y = top + height + 24 + 20;
};

const drawFooters = (doc: Doc, ctx: ReportContext): void => {
  const range = doc.bufferedPageRange();

  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);

    // Writing into the bottom margin is the whole point of a footer, and PDFKit
    // will otherwise add a page when the cursor crosses the margin boundary.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - 44;

    doc.save();
    doc.moveTo(PAGE.margin, y - 10).lineTo(doc.page.width - PAGE.margin, y - 10).lineWidth(0.6).stroke(BRAND.hairline);
    doc.restore();

    const left = ctx.contactLine
      ? text(ctx.contactLine)
      : `${text(ctx.brandName)} — written up automatically from the class recording.`;

    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(BRAND.muted)
      .text(left, PAGE.margin, y, { width: PAGE.width - 70, lineBreak: false });

    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(BRAND.muted)
      .text(`${i - range.start + 1} / ${range.count}`, doc.page.width - PAGE.margin - 60, y, {
        width: 60,
        align: 'right',
        lineBreak: false,
      });

    doc.page.margins.bottom = bottom;
  }
};

/** Break to a new page when the next block would not fit under the current one. */
const ensureSpace = (doc: Doc, needed: number): void => {
  const limit = doc.page.height - doc.page.margins.bottom - 56; // 56pt reserved for the footer
  if (doc.y + needed > limit) {
    doc.addPage();
    doc.y = doc.page.margins.top;
  }
};
