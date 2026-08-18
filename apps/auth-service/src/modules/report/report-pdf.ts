import PDFDocument from 'pdfkit';
import { NOT_AVAILABLE, type LearningStatus, type SessionReport } from '@futurespark/constants';
import { parseClassSummary, toPdfSafeText, truncate, type ParsedSummary } from './summary-parser';
import { FINQUO_LOGO_PNG } from './logo';

/**
 * Renders the parent-facing session report.
 *
 * The structured layout follows the approved report design: light page, logo
 * masthead with a metadata grid, bordered stat cards, real talk-time bars, a
 * 2×2 learning snapshot, indicator dots, a multi-colour word cloud and two
 * tinted callouts. Printed on white because this document is read on a phone in
 * a WhatsApp thread and often printed for a fridge door.
 *
 * Only the built-in Helvetica family is used, so there is no font file to ship
 * and no chance of a missing font turning a real report into blank boxes. The
 * cost is a WinAnsi character set, which `toPdfSafeText` already accounts for.
 */

const BRAND = {
  purple: '#714ade',
  purpleDim: '#4c2eb0',
  teal: '#09b1bb',
  /** The report design's yellow — talk-time teacher bar, highlight callout. */
  yellow: '#fdae27',
  orange: '#f8721f',
  blue: '#3b68fc',
  /** Legacy accent kept for the prose-path mentor note bar. */
  amber: '#f8721f',
  ink: '#101322',
  body: '#33384d',
  muted: '#6b7280',
  hairline: '#e3e2ee',
  wash: '#f6f5fc',
  /** Fill for the metric cards and the word-cloud panel. */
  cardFill: '#f4f6f8',
  /** The empty part of a talk-time bar. */
  track: '#eceef2',
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
  rawSummary: string,
  report?: SessionReport | null
): Promise<RenderedReport> => {
  const parsed = parseClassSummary(rawSummary);

  const doc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
    bufferPages: true, // required for the legacy path's "Page N of M" footer
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

  if (report) {
    // The structured Student Session Report. Every session renders identically
    // because the layout is applied to data rather than parsed out of prose.
    drawHeader(doc, ctx, report);
    drawGlance(doc, report);
    drawProse(doc, 'This session', report.parentSummary);
    drawSnapshot(doc, report);
    drawIndicators(doc, report);
    drawWordCloud(doc, report);
    drawLearningGoals(doc, report);
    drawProse(doc, 'Next session focus', report.nextSessionFocus);
    drawCallout(doc, "This week's highlight", report.assessment.highlight, {
      bar: BRAND.yellow,
      bg: '#fdf4e2',
    });
    drawCallout(doc, 'Try this at home', report.parentConnection, {
      bar: BRAND.purple,
      bg: '#f1eefb',
    });
    if (ctx.mentorNote) drawMentorNote(doc, ctx);
    drawEndFooter(doc, ctx, report);
  } else {
    // Classes analysed before the structured report existed still hold a prose
    // summary, and their PDFs must keep rendering.
    drawMasthead(doc, ctx);
    drawFactStrip(doc, ctx);
    if (parsed.metrics.length > 0) drawMetrics(doc, parsed);
    if (ctx.quizScore !== null && ctx.quizScore !== undefined) drawQuizResult(doc, ctx);
    drawSections(doc, parsed);
    if (ctx.mentorNote) drawMentorNote(doc, ctx);
    drawFooters(doc, ctx);
  }

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

/* ══════════════════════════════════════════════════════════════════════════
 * STRUCTURED REPORT LAYOUT
 * ═══════════════════════════════════════════════════════════════════════ */

/** Dot colour per progress band. Never red — none of the three is a failure. */
const STATUS_DOTS: Record<LearningStatus, string> = {
  Emerging: BRAND.orange,
  Developing: BRAND.yellow,
  Proficient: BRAND.teal,
};

const na = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return NOT_AVAILABLE;
  const s = String(value).trim();
  return s.length > 0 ? s : NOT_AVAILABLE;
};

/**
 * The masthead: logo + wordmark, week counter, caption, metadata grid, and the
 * teal rule that closes it. First page only — everything after flows.
 */
const drawHeader = (doc: Doc, ctx: ReportContext, report: SessionReport): void => {
  const top = 44;

  // Logo mark + stacked wordmark. The PNG is embedded in the build; if it is
  // ever unreadable the wordmark still names the product on its own.
  try {
    doc.image(FINQUO_LOGO_PNG, PAGE.margin, top, { height: 34 });
  } catch {
    /* wordmark only */
  }
  doc.font('Helvetica-Bold').fontSize(15).fillColor(BRAND.ink)
    .text('FINQUO', PAGE.margin + 44, top + 2, { lineBreak: false });
  doc.font('Helvetica').fontSize(13).fillColor(BRAND.body)
    .text('Junior', PAGE.margin + 44, top + 18, { lineBreak: false });

  const week = report.weekNumber ?? ctx.sessionNumber ?? null;
  const weekTotal = report.weekTotal;
  if (week) {
    doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.muted)
      .text(`Week ${week}${weekTotal ? ` of ${weekTotal}` : ''}`, PAGE.margin, top + 2, {
        width: PAGE.width,
        align: 'right',
        lineBreak: false,
      });
  }

  // "1:1 FINANCIAL LITERACY — SESSION REPORT"
  const caption = `${text(ctx.programName)} — Session report`.toUpperCase();
  doc.font('Helvetica').fontSize(8.5).fillColor('#7d8aa3')
    .text(caption, PAGE.margin, top + 50, { characterSpacing: 1.8, width: PAGE.width, lineBreak: false });

  // Metadata grid: 3 columns × 2 rows.
  const sessionLabel = ctx.sessionNumber
    ? `Session ${ctx.sessionNumber}`
    : text(ctx.sessionTitle) || NOT_AVAILABLE;
  const topic = text(report.sessionTopic) || text(ctx.sessionTitle) || NOT_AVAILABLE;
  const duration = na(report.timing.duration !== NOT_AVAILABLE ? report.timing.duration : ctx.durationLabel);

  const cells: Array<[string, string]> = [
    ['Student', text(ctx.studentName) || NOT_AVAILABLE],
    ['Facilitator', text(ctx.mentorName) || NOT_AVAILABLE],
    ['Session', sessionLabel],
    ['Topic', topic],
    ['Date', text(ctx.classDate) || NOT_AVAILABLE],
    ['Duration', duration],
  ];

  const gridTop = top + 72;
  const rowHeight = 34;
  const colWidth = PAGE.width / 3;

  cells.forEach(([label, value], index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = PAGE.margin + col * colWidth;
    const y = gridTop + row * rowHeight;

    doc.font('Helvetica').fontSize(7.5).fillColor(BRAND.muted)
      .text(label.toUpperCase(), x, y, { characterSpacing: 1, width: colWidth - 10, lineBreak: false });
    doc.font('Helvetica').fontSize(11).fillColor(BRAND.ink)
      .text(value, x, y + 11, { width: colWidth - 10, lineBreak: false, ellipsis: true });
  });

  const ruleY = gridTop + rowHeight * 2 + 4;
  doc.save();
  doc.rect(PAGE.margin, ruleY, PAGE.width, 2).fill(BRAND.teal);
  doc.restore();

  doc.y = ruleY + 26;
};

/**
 * SESSION AT A GLANCE — three bordered stat cards, the talk-time bars, and six
 * grey metric cards.
 */
const drawGlance = (doc: Doc, report: SessionReport): void => {
  drawSectionHeading(doc, 'Session at a glance', 62);

  /* Three stat cards. */
  const statGap = 12;
  const statWidth = (PAGE.width - statGap * 2) / 3;
  const statHeight = 48;
  ensureSpace(doc, statHeight + 14);
  const statTop = doc.y;

  const stats: Array<[string, string]> = [
    ['Start', na(report.timing.startTime)],
    ['End', na(report.timing.endTime)],
    ['Total duration', na(report.timing.duration)],
  ];

  stats.forEach(([label, value], index) => {
    const x = PAGE.margin + index * (statWidth + statGap);
    doc.save();
    doc.roundedRect(x, statTop, statWidth, statHeight, 8).lineWidth(0.8).stroke(BRAND.hairline);
    doc.restore();

    doc.font('Helvetica').fontSize(7).fillColor(BRAND.muted)
      .text(label.toUpperCase(), x + 12, statTop + 10, {
        characterSpacing: 0.9, width: statWidth - 24, lineBreak: false, ellipsis: true,
      });

    if (value === NOT_AVAILABLE) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(BRAND.muted)
        .text(value, x + 12, statTop + 26, { width: statWidth - 24, lineBreak: false, ellipsis: true });
    } else {
      doc.font('Helvetica-Bold').fontSize(13).fillColor(BRAND.ink)
        .text(value, x + 12, statTop + 24, { width: statWidth - 24, lineBreak: false, ellipsis: true });
    }
  });

  doc.y = statTop + statHeight + 14;

  /* Talk-time panel with proportional bars. */
  drawTalkTime(doc, report);

  /* Six metric cards, two rows of three. */
  const i = report.interactions;
  const higher = i.higherOrderQuestions;
  const higherPct =
    higher !== null && i.teacherQuestions !== null && i.teacherQuestions > 0
      ? Math.round((higher / i.teacherQuestions) * 100)
      : null;

  const metrics: Array<[string, string]> = [
    [String(na(i.teacherQuestions)), 'Teacher questions'],
    [String(na(i.studentQuestions)), 'Student questions'],
    [higher === null ? NOT_AVAILABLE : `${higher}${higherPct !== null ? ` (${higherPct}%)` : ''}`, 'Higher-order questions'],
    [String(na(i.meaningfulResponses)), 'Meaningful responses'],
    [String(na(i.independentResponses)), 'Independent responses'],
    [String(na(i.promptedResponses)), 'Prompted responses'],
  ];

  const cardGap = 12;
  const cardWidth = (PAGE.width - cardGap * 2) / 3;
  const cardHeight = 44;

  for (let row = 0; row < 2; row += 1) {
    ensureSpace(doc, cardHeight + 10);
    const y = doc.y;
    for (let col = 0; col < 3; col += 1) {
      const [value, label] = metrics[row * 3 + col];
      const x = PAGE.margin + col * (cardWidth + cardGap);

      doc.save();
      doc.roundedRect(x, y, cardWidth, cardHeight, 8).fill(BRAND.cardFill);
      doc.restore();

      if (value === NOT_AVAILABLE) {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(BRAND.muted)
          .text(value, x + 12, y + 11, { width: cardWidth - 24, lineBreak: false, ellipsis: true });
      } else {
        doc.font('Helvetica-Bold').fontSize(13).fillColor(BRAND.ink)
          .text(value, x + 12, y + 8, { width: cardWidth - 24, lineBreak: false, ellipsis: true });
      }
      doc.font('Helvetica').fontSize(6.8).fillColor(BRAND.muted)
        .text(label.toUpperCase(), x + 12, y + 27, {
          characterSpacing: 0.7, width: cardWidth - 24, lineBreak: false, ellipsis: true,
        });
    }
    doc.y = y + cardHeight + 10;
  }

  doc.y += 8;
};

/** Teacher and student bars, widths proportional to their share of the hour. */
const drawTalkTime = (doc: Doc, report: SessionReport): void => {
  const t = report.talkTime;
  const nothing =
    t.teacherPercent === null && t.studentPercent === null &&
    na(t.teacher) === NOT_AVAILABLE && na(t.student) === NOT_AVAILABLE;

  const pad = 14;
  const rowHeight = 30;
  const height = nothing ? 44 : 26 + rowHeight * 2 + 6;
  ensureSpace(doc, height + 14);
  const top = doc.y;

  doc.save();
  doc.roundedRect(PAGE.margin, top, PAGE.width, height, 8).lineWidth(0.8).stroke(BRAND.hairline);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(BRAND.muted)
    .text('TALK TIME', PAGE.margin + pad, top + 11, { characterSpacing: 1, lineBreak: false });

  if (nothing) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(BRAND.muted)
      .text(NOT_AVAILABLE, PAGE.margin + pad, top + 24, { lineBreak: false });
    doc.y = top + height + 14;
    return;
  }

  const innerWidth = PAGE.width - pad * 2;
  const rows: Array<{ name: string; amount: string; pct: number | null; color: string }> = [
    { name: 'Teacher', amount: t.teacher, pct: t.teacherPercent, color: BRAND.yellow },
    { name: 'Student', amount: t.student, pct: t.studentPercent, color: BRAND.teal },
  ];

  rows.forEach((row, index) => {
    const y = top + 26 + index * rowHeight;

    doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.body)
      .text(row.name, PAGE.margin + pad, y, { lineBreak: false });

    const amount = na(row.amount);
    const value =
      row.pct !== null
        ? amount === NOT_AVAILABLE ? `${row.pct}%` : `${amount} · ${row.pct}%`
        : amount;
    doc.font('Helvetica').fontSize(8.5).fillColor(BRAND.muted)
      .text(value, PAGE.margin + pad, y + 1, { width: innerWidth, align: 'right', lineBreak: false });

    // The bar: full-width track, fill clamped 0-100.
    const barY = y + 13;
    doc.save();
    doc.roundedRect(PAGE.margin + pad, barY, innerWidth, 5, 2.5).fill(BRAND.track);
    if (row.pct !== null && row.pct > 0) {
      const fillWidth = Math.max(5, (Math.min(100, row.pct) / 100) * innerWidth);
      doc.roundedRect(PAGE.margin + pad, barY, fillWidth, 5, 2.5).fill(row.color);
    }
    doc.restore();
  });

  doc.y = top + height + 14;
};

/** LEARNING SNAPSHOT — the four evidence paragraphs as a 2×2 card grid. */
const drawSnapshot = (doc: Doc, report: SessionReport): void => {
  const a = report.assessment;
  const cards: Array<[string, string]> = ([
    ['What was understood', a.conceptUnderstandingNote],
    ['Applied to real life', a.applicationNote],
    ['Money reasoning', a.financialReasoningNote],
    ['Working independently', a.independenceNote],
  ] as Array<[string, string]>).filter(([, note]) => text(note).length > 0);

  if (cards.length === 0) return;

  drawSectionHeading(doc, 'Learning snapshot', 90);

  const gap = 14;
  const cardWidth = (PAGE.width - gap) / 2;
  const pad = 12;

  for (let index = 0; index < cards.length; index += 2) {
    const pair = [cards[index], cards[index + 1]].filter(Boolean) as Array<[string, string]>;

    // Measure both bodies so the two cards in a row share one height.
    const heights = pair.map(([, note]) => {
      doc.font('Helvetica').fontSize(9.5);
      return doc.heightOfString(text(note), { width: cardWidth - pad * 2, lineGap: 3 });
    });
    const cardHeight = Math.max(...heights) + 34;

    ensureSpace(doc, cardHeight + 12);
    const y = doc.y;

    pair.forEach(([label, note], col) => {
      const x = PAGE.margin + col * (cardWidth + gap);

      doc.save();
      doc.roundedRect(x, y, cardWidth, cardHeight, 8).lineWidth(0.8).stroke(BRAND.hairline);
      doc.restore();

      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(BRAND.muted)
        .text(label.toUpperCase(), x + pad, y + 11, {
          characterSpacing: 0.9, width: cardWidth - pad * 2, lineBreak: false, ellipsis: true,
        });
      doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.body)
        .text(text(note), x + pad, y + 24, { width: cardWidth - pad * 2, lineGap: 3 });
    });

    doc.y = y + cardHeight + 12;
  }

  doc.y += 6;
};

/** LEARNING INDICATORS — four divided rows, coloured dot + level on the right. */
const drawIndicators = (doc: Doc, report: SessionReport): void => {
  // 4 rows of 30 — reserve the whole table so the heading never strands.
  drawSectionHeading(doc, 'Learning indicators', 138);

  const a = report.assessment;
  const rows: Array<[string, LearningStatus | null]> = [
    ['Concept understanding', a.conceptUnderstanding],
    ['Real-life application', a.application],
    ['Financial reasoning', a.financialReasoning],
    ['Independent thinking', a.independence],
  ];

  const rowHeight = 30;
  const height = rowHeight * rows.length;
  ensureSpace(doc, height + 14);
  const top = doc.y;

  doc.save();
  doc.roundedRect(PAGE.margin, top, PAGE.width, height, 8).lineWidth(0.8).stroke(BRAND.hairline);
  doc.restore();

  rows.forEach(([label, status], index) => {
    const y = top + index * rowHeight;

    if (index > 0) {
      doc.save();
      doc.moveTo(PAGE.margin + 10, y).lineTo(PAGE.margin + PAGE.width - 10, y)
        .lineWidth(0.5).stroke(BRAND.hairline);
      doc.restore();
    }

    doc.font('Helvetica').fontSize(10).fillColor(BRAND.ink)
      .text(text(label), PAGE.margin + 14, y + 10, { width: PAGE.width * 0.6, lineBreak: false });

    if (status) {
      const labelWidth = doc.font('Helvetica').fontSize(9.5).widthOfString(status);
      const textX = PAGE.margin + PAGE.width - 14 - labelWidth;

      doc.save();
      doc.circle(textX - 10, y + rowHeight / 2, 3.5).fill(STATUS_DOTS[status]);
      doc.restore();
      doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.ink)
        .text(status, textX, y + 10.5, { lineBreak: false });
    } else {
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(BRAND.muted)
        .text(NOT_AVAILABLE, PAGE.margin + PAGE.width - 92, y + 11, {
          width: 78, align: 'right', lineBreak: false,
        });
    }
  });

  doc.y = top + height + 18;
};

const drawLearningGoals = (doc: Doc, report: SessionReport): void => {
  if (report.learningGoals.length === 0) return;
  drawSectionHeading(doc, "Today's learning goals");

  for (const goal of report.learningGoals) {
    doc.font('Helvetica').fontSize(10);
    const height = doc.heightOfString(text(goal), { width: PAGE.width - 16, lineGap: 3 });
    ensureSpace(doc, height + 6);
    const y = doc.y;

    doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.ink)
      .text('•', PAGE.margin + 2, y, { width: 10, lineBreak: false });
    doc.font('Helvetica').fontSize(10).fillColor(BRAND.body)
      .text(text(goal), PAGE.margin + 16, y, { width: PAGE.width - 16, lineGap: 3 });
    doc.moveDown(0.3);
  }
  doc.y += 10;
};

/**
 * The word cloud, drawn rather than described.
 *
 * A language model cannot produce an image, so it returns weighted words and
 * this lays them out. Greedy row packing, not a spiral: rows cannot overlap by
 * construction, which matters more on a document going to a parent than the
 * extra density a spiral would buy. Size tracks weight; colour cycles the five
 * brand hues so the panel reads as designed rather than computed.
 */
const drawWordCloud = (doc: Doc, report: SessionReport): void => {
  const words = report.wordCloud;
  if (words.length === 0) return;

  const weights = words.map((w) => w.weight);
  const minW = Math.min(...weights);
  const maxW = Math.max(...weights);
  const MIN_PT = 10;
  const MAX_PT = 23;

  const sizeFor = (weight: number) =>
    maxW === minW ? 14 : MIN_PT + ((weight - minW) / (maxW - minW)) * (MAX_PT - MIN_PT);

  const CLOUD_COLORS = [BRAND.teal, BRAND.yellow, BRAND.purple, BRAND.orange, BRAND.blue];

  // Alternate large and small so one row is not all giants and the next all
  // whispers — that is what makes a generated cloud look computed.
  const ordered = [...words].sort((a, b) => b.weight - a.weight);
  const interleaved: typeof ordered = [];
  let head = 0;
  let tail = ordered.length - 1;
  while (head <= tail) {
    interleaved.push(ordered[head++]);
    if (head <= tail) interleaved.push(ordered[tail--]);
  }

  type Placed = { word: string; size: number; color: string; width: number };
  const rows: Placed[][] = [];
  let row: Placed[] = [];
  let rowWidth = 0;
  const GAP = 14;
  const INNER = PAGE.width - 32; // panel side padding

  /**
   * Title-case for display, leaving acronyms alone. Two inputs arrive here:
   * new reports carry the model's casing ("unit cost", "EMI"), and reports
   * stored before the casing fix are ALL-CAPS throughout. Per word: short
   * all-caps tokens (≤ 4 letters) are treated as acronyms and kept; everything
   * else gets one capital. "UNIT COST" -> "Unit Cost", "EMI" -> "EMI".
   */
  const displayWord = (word: string): string =>
    word
      .split(/\s+/)
      .map((token) =>
        token === token.toUpperCase() && token.length <= 4
          ? token
          : token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
      )
      .join(' ');

  interleaved.forEach((entry, index) => {
    const size = sizeFor(entry.weight);
    const label = displayWord(text(entry.word));
    doc.font('Helvetica-Bold').fontSize(size);
    const width = doc.widthOfString(label);

    if (rowWidth + width + GAP > INNER && row.length > 0) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    row.push({ word: label, size, color: CLOUD_COLORS[index % CLOUD_COLORS.length], width });
    rowWidth += width + GAP;
  });
  if (row.length > 0) rows.push(row);

  const rowHeights = rows.map((r) => Math.max(...r.map((w) => w.size)) * 1.5);
  const totalHeight = rowHeights.reduce((a, b) => a + b, 0) + 28;

  // Measurement done — now the heading, reserving the panel beneath it.
  drawSectionHeading(doc, 'Key concepts discussed', totalHeight);
  ensureSpace(doc, totalHeight);

  const top = doc.y;
  doc.save();
  doc.roundedRect(PAGE.margin, top, PAGE.width, totalHeight, 8).fill(BRAND.cardFill);
  doc.restore();

  let y = top + 16;
  rows.forEach((r, index) => {
    const width = r.reduce((sum, w) => sum + w.width, 0) + GAP * (r.length - 1);
    let x = PAGE.margin + (PAGE.width - width) / 2; // centred row
    const lineHeight = rowHeights[index];

    for (const w of r) {
      // Baseline-align within the row so mixed sizes sit on a common line
      // rather than floating at different heights.
      const yOffset = (lineHeight - w.size * 1.2) / 2;
      doc.font('Helvetica-Bold').fontSize(w.size).fillColor(w.color)
        .text(w.word, x, y + yOffset, { width: w.width + 2, lineBreak: false });
      x += w.width + GAP;
    }
    y += lineHeight;
  });

  doc.y = top + totalHeight + 18;
};

/** A plain headed paragraph. Skipped entirely when there is nothing to say. */
const drawProse = (doc: Doc, heading: string, body: string): void => {
  if (!body || text(body).length === 0) return;
  // Measure before the heading so heading + paragraph stay on one page.
  doc.font('Helvetica').fontSize(10.5);
  const height = doc.heightOfString(text(body), { width: PAGE.width, lineGap: 3.5 });
  drawSectionHeading(doc, heading, height + 8);
  doc.font('Helvetica').fontSize(10.5).fillColor(BRAND.body)
    .text(text(body), PAGE.margin, doc.y, { width: PAGE.width, lineGap: 3.5 });
  doc.y += 16;
};

/** A tinted panel with a coloured left rule — the highlight / at-home blocks. */
const drawCallout = (
  doc: Doc,
  heading: string,
  body: string,
  colors: { bar: string; bg: string }
): void => {
  if (!body || text(body).length === 0) return;

  doc.font('Helvetica').fontSize(10);
  const height = doc.heightOfString(text(body), { width: PAGE.width - 34, lineGap: 3.5 });
  drawSectionHeading(doc, heading, height + 30);
  const top = doc.y;

  doc.save();
  doc.roundedRect(PAGE.margin, top, PAGE.width, height + 22, 8).fill(colors.bg);
  doc.rect(PAGE.margin, top, 3, height + 22).fill(colors.bar);
  doc.restore();

  doc.font('Helvetica').fontSize(10).fillColor(BRAND.body)
    .text(text(body), PAGE.margin + 18, top + 11, { width: PAGE.width - 34, lineGap: 3.5 });

  doc.y = top + height + 22 + 16;
};

/** The closing brand strip: logo, programme line, provenance note. */
const drawEndFooter = (doc: Doc, ctx: ReportContext, report: SessionReport): void => {
  ensureSpace(doc, 64);
  const top = doc.y + 6;

  doc.save();
  doc.moveTo(PAGE.margin, top).lineTo(PAGE.margin + PAGE.width, top).lineWidth(0.6).stroke(BRAND.hairline);
  doc.restore();

  try {
    doc.image(FINQUO_LOGO_PNG, PAGE.margin, top + 12, { height: 20 });
  } catch {
    /* text lines only */
  }

  const week = report.weekNumber ?? ctx.sessionNumber ?? null;
  const weekPart = week ? ` | Week ${week}${report.weekTotal ? ` of ${report.weekTotal}` : ''}` : '';
  const line = `${text(ctx.brandName)} | ${text(ctx.programName)}${weekPart}`;

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND.ink)
    .text(line, PAGE.margin + 30, top + 13, { width: PAGE.width - 30, lineBreak: false, ellipsis: true });
  doc.font('Helvetica').fontSize(8).fillColor(BRAND.muted)
    .text('Prepared from the session recording and session learning objectives.', PAGE.margin + 30, top + 25, {
      width: PAGE.width - 30, lineBreak: false, ellipsis: true,
    });

  doc.y = top + 44;
};

/* ══════════════════════════════════════════════════════════════════════════
 * LEGACY PROSE LAYOUT — classes analysed before the structured report existed
 * ═══════════════════════════════════════════════════════════════════════ */

const drawMasthead = (doc: Doc, ctx: ReportContext): void => {
  const top = PAGE.margin;

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
    .text('STUDENT SESSION REPORT', PAGE.margin, top + 12, { characterSpacing: 2 });

  doc.y = 128;

  doc
    .fillColor(BRAND.ink)
    .font('Helvetica-Bold')
    .fontSize(21)
    .text(text(ctx.studentName), PAGE.margin, doc.y, { width: PAGE.width });

  const topic = text(ctx.sessionTitle);
  const sessionLabel = ctx.sessionNumber ? `Week ${ctx.sessionNumber} — ${topic}` : topic;

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

/**
 * `keepWith` is how much of the section's own content must fit under the
 * heading on the same page. Without it a heading could sit alone at the foot
 * of a page with its table starting on the next — which read as a mistake.
 */
const drawSectionHeading = (doc: Doc, heading: string, keepWith = 40): void => {
  ensureSpace(doc, 26 + Math.min(keepWith, 420));
  const y = doc.y;

  // Accent tick to the left of the heading — cheap, and it gives the eye
  // something to scan down when the report runs long.
  doc.save();
  doc.rect(PAGE.margin, y + 1, 3, 11).fill(BRAND.teal);
  doc.restore();

  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(BRAND.ink)
    .text(heading.toUpperCase(), PAGE.margin + 12, y + 2, {
      characterSpacing: 1.6,
      width: PAGE.width - 12,
    });

  doc.moveDown(0.9);
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
  const limit = doc.page.height - doc.page.margins.bottom - 20;
  if (doc.y + needed > limit) {
    doc.addPage();
    doc.y = doc.page.margins.top;
  }
};
