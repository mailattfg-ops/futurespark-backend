import { FONT } from './fonts';

/**
 * The approved Finquo Junior session report, drawn to the design.
 *
 * Two pages, fixed. Every session produces the same document in the same
 * places, because a parent comparing week 6 against week 7 should be reading a
 * change in their child, not a change in the layout. Everything that varies —
 * a longer name, more topics, a wordier outcome — is bounded here rather than
 * allowed to reflow the page.
 *
 * Coordinates come from the approved PDF itself, measured rather than eyeballed.
 */

/* ── Design tokens ───────────────────────────────────────────────────────── */

export const C = {
  ink: '#0f1419',
  body: '#6b7280',
  muted: '#9ca3af',
  cream: '#faf9f6',
  border: '#e7e4dd',
  borderDim: '#d9d5cc',
  white: '#ffffff',
  teal: '#06a9b5',
  amber: '#feb121',
  indigo: '#5f54e4',
  coral: '#fc6a1e',
} as const;

/** The rotation used for topic dots, activity markers and cloud accents. */
export const ACCENTS = [C.teal, C.amber, C.indigo, C.coral] as const;

export const PAGE = {
  size: 'A4' as const,
  /** pdfkit's A4: 595.28 × 841.89pt. */
  width: 595.28,
  height: 841.89,
  margin: 40,
};

/** Right edge of the content column. */
const R = PAGE.width - PAGE.margin;
/** Content column width. */
const W = R - PAGE.margin;
const M = PAGE.margin;

/* ── Small drawing primitives ────────────────────────────────────────────── */

type Doc = PDFKit.PDFDocument;

/** Run `fn` with a fill/stroke opacity, then put it back. */
const withOpacity = (doc: Doc, opacity: number, fn: () => void): void => {
  doc.save();
  doc.fillOpacity(opacity).strokeOpacity(opacity);
  fn();
  doc.restore();
};

/** A tint of an accent — used for chips and row washes. */
const tint = (doc: Doc, color: string, opacity: number, fn: () => void): void => {
  withOpacity(doc, opacity, () => {
    doc.fillColor(color);
    fn();
  });
};

interface TextOpts {
  size: number;
  color?: string;
  font?: string;
  spacing?: number;
  /** Right-align the text so it ENDS at this x. */
  rightAt?: number;
  width?: number;
}

/** Draw a single line and return the x it ended at. */
const line = (doc: Doc, text: string, x: number, y: number, o: TextOpts): number => {
  doc.font(o.font ?? FONT.body).fontSize(o.size).fillColor(o.color ?? C.ink);
  const opts = { characterSpacing: o.spacing ?? 0, lineBreak: false as const };
  const w = doc.widthOfString(text, opts);
  const startX = o.rightAt !== undefined ? o.rightAt - w : x;
  doc.text(text, startX, y, opts);
  return startX + w;
};

/**
 * Draw a line centred on `cx`.
 *
 * The font is selected before measuring. Measuring inline in a `rightAt`
 * argument looks equivalent but is not: the expression runs before the draw
 * call switches fonts, so the width comes from whatever face was last used and
 * the text lands off-centre by however much the two differ.
 */
const centered = (doc: Doc, text: string, cx: number, y: number, o: TextOpts): number => {
  doc.font(o.font ?? FONT.body).fontSize(o.size);
  const w = doc.widthOfString(text, { characterSpacing: o.spacing ?? 0, lineBreak: false });
  return line(doc, text, cx - w / 2, y, o);
};

/**
 * A section heading: letterspaced mono, a hairline that fills the gap, and an
 * optional caption sitting at the right edge.
 *
 * The rule is measured rather than fixed so a longer heading never collides
 * with it — the failure mode that makes a generated document look generated.
 */
const sectionHeader = (doc: Doc, title: string, y: number, caption?: string | null): void => {
  const size = 6;
  const spacing = 1;
  const endX = line(doc, title, M, y, {
    size,
    font: FONT.monoBold,
    color: C.ink,
    spacing,
  });

  let ruleEnd = R;
  if (caption) {
    doc.font(FONT.mono).fontSize(5.2);
    const capW = doc.widthOfString(caption, { lineBreak: false });
    line(doc, caption, 0, y + 0.7, { size: 5.2, font: FONT.mono, color: C.body, rightAt: R });
    ruleEnd = R - capW - 7.5;
  }

  const ruleStart = endX + 7.5;
  if (ruleEnd > ruleStart) {
    doc.rect(ruleStart, y + 3, ruleEnd - ruleStart, 0.8).fill(C.border);
  }
};

/** A bordered panel. `fill` null leaves it white. */
const card = (
  doc: Doc,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string | null = null,
  radius = 6
): void => {
  // Set the weight BEFORE stroking. pdfkit carries lineWidth across calls, so a
  // card drawn after the donut inherited its 10pt ring and came out framed in a
  // thick beige band.
  doc.lineWidth(0.75);
  doc.roundedRect(x, y, w, h, radius);
  doc.fillAndStroke(fill ?? C.white, C.border);
};

/** An SVG arc, for the donut. Angles in degrees, 0 = east, clockwise. */
const arcPath = (cx: number, cy: number, r: number, fromDeg: number, sweepDeg: number): string => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const sx = cx + r * Math.cos(rad(fromDeg));
  const sy = cy + r * Math.sin(rad(fromDeg));
  const to = fromDeg + sweepDeg;
  const ex = cx + r * Math.cos(rad(to));
  const ey = cy + r * Math.sin(rad(to));
  const large = Math.abs(sweepDeg) > 180 ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey}`;
};

/* ── The document the design is drawn from ───────────────────────────────── */

export interface TopicChip {
  label: string;
}

export interface ActivityItem {
  label: string;
  done: boolean;
}

export interface CloudWord {
  word: string;
  weight: number;
}

export interface ReportDocument {
  /* Identity — from the class record */
  studentName: string;
  mentorName: string;
  sessionNumber: number | null;
  sessionTotal: number | null;
  sessionTitle: string;
  /** "Banking Arc · Deposits, interest and why banks pay you to save" */
  arcLine: string | null;
  dateLabel: string;
  timeLabel: string;
  durationLabel: string;

  /* AI — measured from the recording */
  studentPercent: number | null;
  mentorPercent: number | null;
  studentTime: string;
  mentorTime: string;
  /** Change in the student's share against the previous session, in points. */
  shareDelta: number | null;
  /** Student share for the last few sessions, oldest first, this one last. */
  shareHistory: number[];
  /** Null when the split could not be measured — never shown as a zero. */
  talkMeasured: boolean;
  questionsAsked: number | null;
  meaningfulAnswers: number | null;
  /**
   * The questions asked — the denominator meaningful answers are shown against.
   *
   * The analysis counts meaningful RESPONSES, which can exceed the number of
   * questions because one question often draws several answers; against that
   * raw figure the card once read "18 / 9 · 200%". `meaningfulAnswers` is
   * therefore capped at this number upstream, so the pair reads the way a
   * parent reads it: of the N questions asked, how many drew a real answer.
   */
  answersOutOf: number | null;
  highlights: string[];
  wordCloud: CloudWord[];

  /* Curriculum — fixed for this session */
  topicHub: string | null;
  topics: TopicChip[];
  learningOutcomes: string[];
  inSession: ActivityItem[];
  takeHome: ActivityItem[];

  /* Footer band */
  nextSessionNumber: number | null;
  nextSessionTitle: string | null;
  nextSessionWhen: string | null;
  rescheduleUrl: string | null;
  /** True when the curriculum has nothing after this session. */
  isFinalSession: boolean;
  /** The programme's own name, used to sign off the final session by name. */
  programmeName: string | null;

  brandName: string;
  footerNote: string;
}

/* ── Page furniture ──────────────────────────────────────────────────────── */

const masthead = (doc: Doc, rightLabel: string): void => {
  const end = line(doc, 'finquo', M, 37.6, { size: 12.8, font: FONT.display, color: C.ink });
  line(doc, ' junior', end, 37.6, { size: 12.8, font: FONT.display, color: C.teal });
  line(doc, rightLabel, 0, 42.3, { size: 5.6, font: FONT.mono, color: C.body, spacing: 0.9, rightAt: R });
  doc.rect(M, 59.2, W, 0.8).fill(C.ink);
};

const pageFooter = (doc: Doc, left: string, page: number, total: number): void => {
  line(doc, left, M, 808.1, { size: 4.9, font: FONT.mono, color: C.muted, spacing: 0.8 });
  line(doc, `PAGE ${page} / ${total}`, 0, 808.1, {
    size: 4.9,
    font: FONT.mono,
    color: C.muted,
    spacing: 0.8,
    rightAt: R,
  });
};

/* ── Page 1 ──────────────────────────────────────────────────────────────── */

const identityBlock = (doc: Doc, d: ReportDocument): void => {
  line(doc, 'STUDENT', M, 70.8, { size: 5.6, font: FONT.mono, color: C.body, spacing: 1.2 });
  line(doc, d.studentName, M, 78, { size: 25.5, font: FONT.display, color: C.ink });

  // The session pill, sized to its own text so "SESSION 6 / 8" and
  // "SESSION 06 / 24" both sit correctly against the right edge.
  if (d.sessionNumber !== null) {
    const num = String(d.sessionNumber).padStart(2, '0');
    const totalStr = d.sessionTotal ? ` / ${d.sessionTotal}` : '';
    doc.font(FONT.monoBold).fontSize(6);
    const numW = doc.widthOfString(`SESSION ${num}`, { characterSpacing: 0.8, lineBreak: false });
    doc.font(FONT.mono);
    const totW = totalStr ? doc.widthOfString(totalStr, { characterSpacing: 0.8, lineBreak: false }) : 0;
    const pillW = numW + totW + 20;
    const pillX = R - pillW;
    doc.roundedRect(pillX, 93, pillW, 15, 7.5).fill(C.ink);
    const afterNum = line(doc, `SESSION ${num}`, pillX + 10, 96.7, {
      size: 6,
      font: FONT.monoBold,
      color: C.cream,
      spacing: 0.8,
    });
    if (totalStr) {
      line(doc, totalStr, afterNum, 96.7, { size: 6, font: FONT.mono, color: C.muted, spacing: 0.8 });
    }
  }

  line(doc, d.sessionTitle, M, 113, { size: 14.2, font: FONT.display, color: C.ink });
  if (d.arcLine) {
    line(doc, d.arcLine, M, 135.2, { size: 7.1, font: FONT.body, color: C.body });
  }
};

const infoStrip = (doc: Doc, d: ReportDocument): void => {
  const y = 152.2;
  const h = 34.5;
  // The dividers are the backing panel showing through the gaps between cells,
  // which keeps every rule exactly the same weight.
  doc.rect(M, y, W, h).fill(C.border);

  const cells: Array<[string, string]> = [
    ['DATE', d.dateLabel],
    ['TIME', d.timeLabel],
    ['DURATION', d.durationLabel],
    ['MENTOR', d.mentorName],
  ];
  const gap = 1.3;
  const cellW = (W - 0.75 * 2 - gap * 3) / 4;
  let x = M + 0.75;
  for (const [label, value] of cells) {
    doc.rect(x, y + 0.75, cellW, h - 1.5).fill(C.cream);
    line(doc, label, x + 8.2, 160.9, { size: 4.9, font: FONT.mono, color: C.body, spacing: 0.9 });
    line(doc, value, x + 8.2, 168.5, { size: 7.5, font: FONT.bodyBold, color: C.ink });
    x += cellW + gap;
  }
};

const voiceBalance = (doc: Doc, d: ReportDocument): void => {
  sectionHeader(doc, 'VOICE BALANCE', 202.5, 'who did the talking');

  /* ── Left: this session ── */
  card(doc, M, 218.6, 224.3, 142.5);
  line(doc, 'THIS SESSION', 49.4, 227.6, { size: 4.9, font: FONT.mono, color: C.body, spacing: 0.9 });

  const cx = 87;
  const cy = 275.2;
  const ringR = 27.55;
  doc.lineWidth(9.97);
  doc.circle(cx, cy, ringR).stroke(C.border);

  const share = d.studentPercent;
  if (d.talkMeasured && share !== null) {
    // Starts at the top and runs clockwise, so the filled arc reads as a
    // proportion rather than a decoration.
    doc.path(arcPath(cx, cy, ringR, -90, (share / 100) * 360))
      .lineWidth(9.97)
      .stroke(C.teal);
    centered(doc, `${Math.round(share)}%`, cx, 267, {
      size: 14.2,
      font: FONT.bodyBold,
      color: C.ink,
    });
    centered(doc, d.studentName.split(' ')[0].toUpperCase(), cx, 278.8, {
      size: 3.6,
      font: FONT.mono,
      color: C.body,
      spacing: 0.8,
    });
  } else {
    // Not measured is not zero. An empty ring with a dash says so; a 0% ring
    // would tell a parent their child never spoke.
    centered(doc, '—', cx, 267, { size: 14.2, font: FONT.bodyBold, color: C.muted });
    centered(doc, 'NOT MEASURED', cx, 278.8, {
      size: 3.6,
      font: FONT.mono,
      color: C.muted,
      spacing: 0.8,
    });
  }

  const legend = (
    y: number,
    dotColor: string,
    label: string,
    percent: number | null,
    time: string,
    delta: number | null
  ): void => {
    doc.circle(137.2, y + 3, 3).fill(dotColor);
    line(doc, label, 143.9, y - 0.7, { size: 5.2, font: FONT.mono, color: C.body, spacing: 0.9 });
    const pctText = percent === null ? '—' : `${Math.round(percent)}%`;
    const after = line(doc, pctText, 134.2, y + 7.5, { size: 10.5, font: FONT.bodyBold, color: C.ink });
    const afterTime = line(doc, ` ${time}`, after, y + 10.3, { size: 6.6, font: FONT.mono, color: C.body });

    if (delta !== null && delta !== 0) {
      const txt = `${delta > 0 ? '+' : ''}${delta} vs last`;
      doc.font(FONT.mono).fontSize(5.1);
      const tw = doc.widthOfString(txt, { characterSpacing: 0.4, lineBreak: false });
      const chipX = afterTime + 4;
      tint(doc, C.teal, 0.14, () => {
        doc.roundedRect(chipX, y + 8.9, tw + 7, 9.8, 4.9).fill(C.teal);
      });
      line(doc, txt, chipX + 3.5, y + 11.4, { size: 5.1, font: FONT.mono, color: C.teal, spacing: 0.4 });
    }
  };

  legend(251.2, C.teal, d.studentName.split(' ')[0].toUpperCase(), share, d.studentTime, d.shareDelta);
  legend(282, C.border, 'MENTOR', d.mentorPercent, d.mentorTime, null);

  /* ── Right: the trend ── */
  card(doc, 274.1, 218.6, 281.3, 142.5);
  const firstName = d.studentName.split(' ')[0].toUpperCase();
  // "LAST 1 SESSIONS" is the kind of detail that tells a parent the document
  // was assembled by a machine that was not paying attention.
  const trendCaption =
    d.shareHistory.length === 1
      ? `${firstName}'S SHARE · FIRST SESSION (%)`
      : d.shareHistory.length > 1
        ? `${firstName}'S SHARE · LAST ${d.shareHistory.length} SESSIONS (%)`
        : `${firstName}'S SHARE (%)`;
  line(doc, trendCaption, 283.7, 227.6, {
    size: 4.9,
    font: FONT.mono,
    color: C.body,
    spacing: 0.9,
  });

  const plotX0 = 302.5;
  const plotX1 = 538.35;
  const plotBottom = 329.5;
  const plotTop = 249.4;

  /* The axis fits the data instead of being fixed at 20–60.
   *
   * The approved design was drawn against a child sitting in the thirties and
   * forties, so a fixed 20–60 looked right. A real first session came back at
   * 16%, which a fixed axis clamps onto the bottom gridline — the chart would
   * then show 20 while the label said 16, which is worse than no chart.
   *
   * Rounded outwards to tens with a little air, so the common case still
   * produces exactly the 20/40/60 the design specifies. */
  const values = d.shareHistory.length > 0 ? d.shareHistory : [0];
  const axisLo = Math.max(0, Math.floor((Math.min(...values) - 10) / 10) * 10);
  const axisHi = Math.min(100, Math.max(axisLo + 20, Math.ceil((Math.max(...values) + 10) / 10) * 10));
  const yFor = (v: number) =>
    plotBottom - ((v - axisLo) / (axisHi - axisLo)) * (plotBottom - plotTop);

  const pts = d.shareHistory;

  // Only draw the axis when something is going to be plotted against it. An
  // empty grid with a sentence running through it reads as a broken chart
  // rather than as an honest "we could not measure this".
  if (pts.length > 0) {
    for (const v of [axisLo, (axisLo + axisHi) / 2, axisHi]) {
      doc.rect(302.4, yFor(v), 235.9, 0.5).fill(C.border);
      line(doc, String(Math.round(v)), 0, yFor(v) - 2.9, { size: 4.7, font: FONT.mono, color: C.body, rightAt: 299 });
    }
  }

  if (pts.length >= 2) {
    const step = (plotX1 - plotX0) / (pts.length - 1);
    const xy = pts.map((v, i) => [plotX0 + i * step, yFor(v)] as const);

    // Area first, so the line sits on top of its own shading.
    withOpacity(doc, 0.09, () => {
      doc.moveTo(xy[0][0], xy[0][1]);
      for (const [x, y] of xy.slice(1)) doc.lineTo(x, y);
      doc.lineTo(xy[xy.length - 1][0], plotBottom);
      doc.lineTo(xy[0][0], plotBottom);
      doc.fill(C.teal);
    });

    doc.moveTo(xy[0][0], xy[0][1]);
    for (const [x, y] of xy.slice(1)) doc.lineTo(x, y);
    doc.lineWidth(1.46).stroke(C.teal);

    xy.forEach(([x, y], i) => {
      const last = i === xy.length - 1;
      doc.circle(x, y, last ? 3.05 : 2.2).lineWidth(last ? 1.75 : 1.31).fillAndStroke(C.white, C.teal);
      centered(doc, `S${i + 1}`, x, 336.9, { size: 4.9, font: FONT.mono, color: C.body });
    });

    const [lx, ly] = xy[xy.length - 1];
    line(doc, `${Math.round(pts[pts.length - 1])}%`, 0, ly - 14, {
      size: 6.2,
      font: FONT.bodyBold,
      color: C.ink,
      rightAt: lx + 5,
    });
  } else if (pts.length === 1) {
    /* A first session.
     *
     * One reading is not a trend, so nothing is joined up and no direction is
     * implied — but it is plotted against the same axis the later sessions will
     * use, which makes it the baseline rather than an empty box. A parent
     * opening report one and report two should see the same chart growing, not
     * a blank panel replaced by a line. */
    const x = (plotX0 + plotX1) / 2;
    const y = yFor(pts[0]);

    // A drop line reads as a measurement taken; a lone dot reads as a stray mark.
    withOpacity(doc, 0.35, () => {
      doc.moveTo(x, y).lineTo(x, plotBottom).lineWidth(1).dash(2, { space: 2 }).stroke(C.teal);
    });
    doc.undash();

    doc.circle(x, y, 3.05).lineWidth(1.75).fillAndStroke(C.white, C.teal);
    centered(doc, `${Math.round(pts[0])}%`, x, y - 14, {
      size: 6.2,
      font: FONT.bodyBold,
      color: C.ink,
    });
    centered(doc, 'S1', x, 336.9, { size: 4.9, font: FONT.mono, color: C.body });
    centered(doc, 'First session · the baseline next week is measured against', x, 347, {
      size: 5.6,
      font: FONT.body,
      color: C.muted,
    });
  } else {
    centered(doc, 'The talk split could not be measured for this session.', (plotX0 + plotX1) / 2, 285, {
      size: 6.6,
      font: FONT.body,
      color: C.muted,
    });
  }
};

const participation = (doc: Doc, d: ReportDocument): void => {
  sectionHeader(doc, 'PARTICIPATION', 377.2);

  card(doc, M, 393.4, 252.8, 71.2, C.cream);
  line(doc, 'QUESTIONS ASKED BY MENTOR', 50.2, 403.9, {
    size: 4.9,
    font: FONT.mono,
    color: C.body,
    spacing: 0.9,
  });
  line(doc, d.questionsAsked === null ? '—' : String(d.questionsAsked), 50.2, 411.7, {
    size: 18.8,
    font: FONT.bodyBold,
    color: d.questionsAsked === null ? C.muted : C.ink,
  });
  line(doc, 'PROMPTS, CHECKS AND OPEN QUESTIONS DURING THE SESSION.', 50.2, 438, {
    size: 6,
    font: FONT.mono,
    color: C.body,
    spacing: 0.2,
  });

  card(doc, 301.9, 393.4, 253.5, 71.2, C.cream);
  line(doc, 'MEANINGFUL ANSWERS GIVEN', 312.3, 403.9, {
    size: 4.9,
    font: FONT.mono,
    color: C.body,
    spacing: 0.9,
  });

  const answers = d.meaningfulAnswers;
  const asked = d.answersOutOf;
  if (answers === null || asked === null || asked === 0 || answers > asked) {
    /* Show the count alone rather than a ratio that cannot be right.
     *
     * A percentage over 100 is always a bug somewhere upstream, and printing it
     * to a parent is worse than printing nothing — so the number that IS
     * trustworthy is kept and the ratio is dropped. */
    const showable = answers !== null && answers >= 0;
    line(doc, showable ? String(answers) : '—', 312.3, 411.7, {
      size: 18.8,
      font: FONT.bodyBold,
      color: showable ? C.ink : C.muted,
    });
    line(
      doc,
      showable ? 'ANSWERS THAT SHOWED REAL THINKING.' : 'NOT MEASURED FOR THIS SESSION.',
      312.3,
      447,
      { size: 6, font: FONT.mono, color: C.body, spacing: 0.2 }
    );
  } else {
    const after = line(doc, String(answers), 312.3, 411.7, {
      size: 18.8,
      font: FONT.bodyBold,
      color: C.ink,
    });
    line(doc, ` / ${asked}`, after, 419, { size: 10, font: FONT.body, color: C.body });

    const pct = Math.round((answers / asked) * 100);
    const trackW = 233.3;
    doc.roundedRect(312, 440.2, trackW, 3, 1.5).fill(C.border);
    doc.roundedRect(312, 440.2, Math.max(2, trackW * Math.min(1, answers / asked)), 3, 1.5).fill(C.amber);
    // "Of the answers given" — the denominator is the child's own answers, so
    // saying so keeps the sentence true to the arithmetic above it.
    line(doc, `${pct}% OF ANSWERS SHOWED REASONING, NOT JUST YES/NO.`, 312.3, 447, {
      size: 6,
      font: FONT.mono,
      color: C.body,
      spacing: 0.2,
    });
  }
};

const topicsCovered = (doc: Doc, d: ReportDocument): void => {
  const chips = d.topics.slice(0, 8);
  sectionHeader(doc, 'TOPICS COVERED', 480.7, chips.length ? `${chips.length} threads` : null);
  card(doc, M, 496.9, W, 136.5);

  if (chips.length === 0) {
    line(doc, 'No topic map recorded for this session.', 56, 560, {
      size: 7,
      font: FONT.body,
      color: C.muted,
    });
    return;
  }

  const spineY = 564.9;

  // The hub, sized to its own label.
  const hub = d.topicHub || 'Session';
  doc.font(FONT.display).fontSize(12.2);
  const hubW = Math.max(60, doc.widthOfString(hub, { lineBreak: false }) + 30);
  doc.roundedRect(47.9, 550.6, hubW, 28.7, 14.35).fill(C.ink);
  /* Optically centred, not arithmetically.
   *
   * The pill runs 550.6–579.3, so its middle is 564.95. A display face sets
   * its glyphs low in the em box, so placing the text box at the true centre
   * leaves it sitting high in the pill — which is the "little alignment issue"
   * on DEMO. The lift is the difference between the em box and the cap height. */
  centered(doc, hub, 47.9 + hubW / 2, 550.6 + (28.7 - 12.2 * 0.72) / 2 - 12.2 * 0.19, {
    size: 12.2,
    font: FONT.display,
    color: C.cream,
  });

  const spineStart = 47.9 + hubW + 1.5;
  doc.moveTo(spineStart, spineY).lineTo(543.2, spineY).lineWidth(1).stroke(C.border);

  // The last node stops short of the spine's end so its chip stays inside the
  // card even when the label is a long one.
  const first = spineStart + 35.7;
  // 500, not 510: the last chip is centred on its node, so the node has to sit
  // far enough from the card edge for a real label to fit beside it.
  const step = chips.length > 1 ? (500 - first) / (chips.length - 1) : 0;

  chips.forEach((chip, i) => {
    const x = first + i * step;
    const color = ACCENTS[i % ACCENTS.length];
    const up = i % 2 === 0;

    doc.moveTo(x, up ? 535.5 : spineY).lineTo(x, up ? spineY : 594.3).lineWidth(0.86).stroke(C.border);
    doc.circle(x, spineY, 2.3).fill(color);

    /* Fit the label to the space, rather than cutting at 18 characters.
     *
     * A fixed character cut turned every curriculum topic into "Understanding
     * ris…", "Types of insuranc…" — the ellipsis did the talking. The gap
     * between neighbouring nodes is what actually constrains a chip, and chips
     * alternate above and below the spine, so each one may use nearly the full
     * step. Only what genuinely will not fit is trimmed, and then on a word
     * boundary so a reader loses a word rather than half of one. */
    doc.font(FONT.body).fontSize(6.6);
    // Chips alternate above and below, so a chip's same-row neighbours are two
    // steps away; 1.75 of a step leaves a visible gap between them even after
    // the edge clamp below has nudged one sideways.
    const maxChipW = Math.max(64, (step || 120) * 1.75);
    let label = chip.label.trim();
    if (doc.widthOfString(label, { lineBreak: false }) + 26 > maxChipW) {
      const budget = maxChipW - 26 - doc.widthOfString('…', { lineBreak: false });
      while (label.length > 6 && doc.widthOfString(label, { lineBreak: false }) > budget) {
        const cut = label.slice(0, -1).trimEnd();
        const lastSpace = cut.lastIndexOf(' ');
        label = lastSpace > 6 && cut.length - lastSpace < 12 ? cut.slice(0, lastSpace) : cut;
      }
      label = `${label}…`;
    }
    const textW = doc.widthOfString(label, { lineBreak: false });
    const chipW = textW + 26;
    /* Centred on its node, but never over the card's edge.
     *
     * The last node sits near the right of the spine, so a wide label centred
     * on it hung outside the panel. Nudging the chip back inside keeps the
     * whole label readable; its connector still points at the node, so which
     * chip belongs to which thread stays unambiguous. */
    const chipX = Math.min(Math.max(x - chipW / 2, M + 6), R - chipW - 6);
    const chipY = up ? 519.7 : 594.3;

    doc.roundedRect(chipX, chipY, chipW, 15.8, 7.9).lineWidth(0.72).fillAndStroke(C.white, C.border);
    doc.circle(chipX + 7.9, chipY + 7.9, 1.85).fill(color);
    line(doc, label, chipX + 13.8, chipY + 4.7, { size: 6.6, font: FONT.body, color: C.ink });
  });
};

const sessionHighlights = (doc: Doc, d: ReportDocument): void => {
  const items = d.highlights.slice(0, 3);
  sectionHeader(doc, 'SESSION HIGHLIGHTS', 649.5, 'what went well');
  card(doc, M, 665.6, W, 82.5, C.cream);

  if (items.length === 0) {
    line(doc, 'No highlights were recorded for this session.', 59.9, 700, {
      size: 7.5,
      font: FONT.body,
      color: C.muted,
    });
    return;
  }

  items.forEach((text, i) => {
    const y = 677.8 + i * 25.2;
    doc.circle(51.4, y + 3.4, 1.9).fill(C.amber);
    doc.font(FONT.body).fontSize(7.5).fillColor(C.ink);
    doc.text(text, 59.9, y, { width: 486, height: 20, ellipsis: true, lineGap: 1.5 });
  });
};

/* ── Page 2 ──────────────────────────────────────────────────────────────── */

const wordCloud = (doc: Doc, d: ReportDocument): void => {
  sectionHeader(doc, 'WORDS FROM THE SESSION', 70.5, 'most used');
  // #F5F5F3 for this panel specifically, per the approved cloud design.
  card(doc, M, 86.6, W, 189.8, '#F5F5F3');

  // 30 offered; the placer lays out as many as genuinely fit the panel.
  const words = d.wordCloud.slice(0, 30).filter((w) => w.word.trim().length > 0);
  if (words.length === 0) {
    line(doc, 'No vocabulary was captured for this session.', 56, 175, {
      size: 7.5,
      font: FONT.body,
      color: C.muted,
    });
    return;
  }

  /* Colour, exactly as the approved page reads.
   *
   * Three registers, assigned by rank rather than at random so a re-sent
   * report is the same document: the big words are ink, four accents sit among
   * the upper ranks (bank teal, account amber, withdraw indigo, balance
   * coral in the reference), and the small tail is muted grey — which is what
   * keeps the panel airy instead of uniformly black.
   */

  /* Greedy placement on an outward spiral.
   *
   * Deterministic on purpose: the same session must produce the same cloud
   * every time it is rendered, or a re-sent report looks like a different one.
   * Words are placed largest first from the centre, and anything that cannot
   * find a free box inside the panel is dropped rather than allowed to overlap. */
  const bounds = { x0: M + 8, y0: 94, x1: R - 8, y1: 270 };
  const cx = (bounds.x0 + bounds.x1) / 2;
  const cy = (bounds.y0 + bounds.y1) / 2;
  const aspect = (bounds.y1 - bounds.y0) / (bounds.x1 - bounds.x0);
  const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];

  const hits = (b: { x0: number; y0: number; x1: number; y1: number }): boolean =>
    placed.some((p) => !(b.x1 < p.x0 || b.x0 > p.x1 || b.y1 < p.y0 || b.y0 > p.y1));

  words.forEach((entry, i) => {
    /* Sized by RANK, not by raw frequency.
     *
     * Real speech is steep: one word dominates and the rest sit in a long flat
     * tail. Sizing proportionally to counts rendered a genuine session as one
     * enormous "insurance" over a field of small regular words — the approved
     * page never looks like that. Its measured sizes (33.4, 30.8, 29.5, 25.3,
     * 24, 22.3 … 11.1) are a smooth geometric decay down the ranks, so that is
     * what is drawn: position in the most-used ORDER sets the size, and the
     * order itself still comes from the counts. */
    const n = words.length;
    let size = n <= 1 ? 33.4 : 33.4 * Math.pow(11 / 33.4, i / (n - 1));

    /* A phrase is several words long and can be wider than the panel at full
     * size — "Emergency Fund" at 33pt is not a small object. Shrink it until it
     * fits (never below 9pt) rather than dropping it, because a concept the
     * session actually taught is worth more than a strict size ladder.
     *
     * Width is measured in the HEAVIEST face so the fit holds whatever weight
     * the final size lands on — Bold is the widest of the three. */
    doc.font(FONT.bodyHeavy).fontSize(size);
    let tw = doc.widthOfString(entry.word, { lineBreak: false });
    const maxTermWidth = (bounds.x1 - bounds.x0) * 0.62;
    while (tw > maxTermWidth && size > 9) {
      size -= 1;
      doc.fontSize(size);
      tw = doc.widthOfString(entry.word, { lineBreak: false });
    }

    /* Weight and colour follow the FINAL size, after any shrink.
     *
     * They were chosen before it, so a long phrase shrunk from 33pt to 19pt
     * kept its Bold and its large-tier ink — breaking the very weight table
     * the sizes exist to enforce. Large tier 700, middle tier 600, the small
     * grey tail Regular so it recedes; accents on ranks 3, 5, 7, 9 — never the
     * top two, which anchor the panel in ink. */
    const face = size >= 20 ? FONT.bodyHeavy : size >= 14.5 ? FONT.bodyBold : FONT.body;

    /* Accents run the length of the cloud, not just its top.
     *
     * The rotation used to be spent on ranks 3, 5, 7 and 9 only — four colours
     * inside the first nine words, then a solid block of ink from rank 10 to
     * rank 16 and grey below. On a real 24-word cloud that reads as a wall of
     * black with a coloured hat. Every third word now takes the next accent,
     * so colour is distributed the whole way down while the top two stay ink
     * to anchor the panel and roughly two-thirds of words remain neutral. */
    const accented = i >= 2 && (i - 2) % 3 === 0;
    const color = accented
      ? ACCENTS[Math.floor((i - 2) / 3) % ACCENTS.length]
      : size < 16
        ? C.body
        : C.ink;
    doc.font(face).fontSize(size);
    tw = doc.widthOfString(entry.word, { lineBreak: false });
    // Geist's cap height leaves a lot of air in the em box; measuring the glyphs
    // rather than the line lets neighbours sit close without touching.
    const th = size * 0.72;

    /* A tight archimedean spiral.
     *
     * The steps are small (0.28 rad, 0.22pt) so a word tries hundreds of near
     * positions before giving up any ground — that is what makes the mass read
     * as one block rather than a scatter. The 0.5 vertical factor squashes the
     * spiral into the panel's landscape shape so the cloud fills the width
     * without leaving a band of empty paper top and bottom. */
    for (let step = 0; step < 4000; step++) {
      const angle = step * 0.28;
      const radius = step * 0.22;
      const x = cx + radius * Math.cos(angle) - tw / 2;
      // Squashed to the panel's own proportions. A circular spiral packs into a
      // tight disc floating in the middle of a landscape box; matching the
      // aspect pushes words outward sideways first, so the mass grows into the
      // width instead of leaving empty paper either side of it.
      const y = cy + radius * aspect * Math.sin(angle) - th / 2;
      /* Breathing room is what makes the cloud FILL the panel.
       *
       * Counter-intuitively, tighter padding produced a smaller cloud: the
       * words packed into a dense blob floating in the middle with paper all
       * round it. Pushing them apart grows the whole mass outward until it
       * meets the panel edges, which is what the approved design looks like —
       * the words are the same size either way, they just occupy the box. */
      const box = { x0: x - 4.5, y0: y - 3, x1: x + tw + 4.5, y1: y + th + 3 };
      if (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < bounds.y0 || box.y1 > bounds.y1) continue;
      if (hits(box)) continue;
      placed.push(box);
      // pdfkit positions text by its em box, so lift by the difference between
      // that and the glyph height measured above.
      doc.fillColor(color).text(entry.word, x, y - size * 0.19, { lineBreak: false });
      break;
    }
  });
};

const learningOutcomes = (doc: Doc, d: ReportDocument): void => {
  sectionHeader(doc, 'LEARNING OUTCOMES', 292.5);
  const items = d.learningOutcomes.slice(0, 5);

  if (items.length === 0) {
    line(doc, 'No outcomes are set for this session yet.', M, 320, {
      size: 7.5,
      font: FONT.body,
      color: C.muted,
    });
    return;
  }

  items.forEach((text, i) => {
    const y = 318.6 + i * 29.6;
    line(doc, String(i + 1).padStart(2, '0'), M, y + 0.5, {
      size: 5.6,
      font: FONT.mono,
      color: C.teal,
      spacing: 0.6,
    });
    doc.font(FONT.body).fontSize(7.5).fillColor(C.ink);
    doc.text(text, 54.7, y, { width: W - 15, height: 11, ellipsis: true, lineBreak: false });
    if (i < items.length - 1) {
      doc.rect(M, y + 18.9, W, 0.8).fill(C.border);
    }
  });
};

const activityCard = (
  doc: Doc,
  x: number,
  title: string,
  dotColor: string,
  items: ActivityItem[],
  filled: boolean
): void => {
  const y = 487.9;
  const w = filled ? 252.8 : 252;
  card(doc, x, y, w, 156, filled ? C.cream : null);

  doc.circle(x + 11.3, 499.9, 1.9).fill(dotColor);
  line(doc, title, x + 17.6, 496.5, { size: 5.2, font: FONT.monoBold, color: C.ink, spacing: 0.7 });
  const done = items.filter((i) => i.done).length;
  line(doc, `${done}/${items.length}`, 0, 496.5, {
    size: 5.2,
    font: FONT.mono,
    color: C.body,
    rightAt: x + w - 9,
  });
  doc.rect(x + 0.4, 511.5, w - 0.8, 0.8).fill(C.border);

  items.slice(0, 3).forEach((item, i) => {
    const ry = 520.9 + i * 40.5;
    const color = ACCENTS[i % ACCENTS.length];
    const rx = x + 9;
    const rw = w - 18;

    if (filled) {
      // A wash of the row's own accent, so the take-home list reads as a set
      // rather than three unrelated boxes.
      tint(doc, color, 0.07, () => doc.roundedRect(rx, ry, rw, 33, 4).fill(color));
      doc.roundedRect(rx, ry, rw, 33, 4).lineWidth(0.75).stroke(C.border);
    } else {
      doc.roundedRect(rx, ry, rw, 33, 4).lineWidth(0.75).fillAndStroke(C.white, C.border);
    }

    doc.rect(rx + 0.4, ry + 0.4, 1.8, 32.2).fill(color);
    tint(doc, color, 0.14, () => doc.roundedRect(rx + 8.6, ry + 8.6, 15.8, 15.8, 4).fill(color));
    centered(doc, String(i + 1).padStart(2, '0'), rx + 16.5, ry + 12.7, {
      size: 5.6,
      font: FONT.mono,
      color,
    });

    doc.font(FONT.body).fontSize(7.4).fillColor(C.ink);
    doc.text(item.label, rx + 31, ry + 12.3, { width: rw - 62, height: 10, ellipsis: true, lineBreak: false });

    const bx = rx + rw - 28;
    if (item.done) {
      doc.roundedRect(bx, ry + 11.9, 11.3, 11.2, 3).fill(C.teal);
      doc
        .moveTo(bx + 2.6, ry + 17.5)
        .lineTo(bx + 4.7, ry + 19.6)
        .lineTo(bx + 8.8, ry + 15.1)
        .lineWidth(1.77)
        .stroke(C.white);
    } else {
      doc.roundedRect(bx, ry + 12.2, 10.5, 10.5, 3).lineWidth(0.75).fillAndStroke(C.white, C.borderDim);
    }
  });
};

const activities = (doc: Doc, d: ReportDocument): void => {
  sectionHeader(doc, 'ACTIVITIES', 471.7);
  activityCard(doc, M, 'IN SESSION · DONE', C.teal, d.inSession, false);
  activityCard(doc, 302.6, 'TAKE HOME · TO DO', C.amber, d.takeHome, true);
};

const nextSessionBand = (doc: Doc, d: ReportDocument): void => {
  doc.roundedRect(M, 735.8, W, 65.2, 6).fill(C.ink);

  /* The last session of the arc is an occasion, not a blank. */
  const eyebrow = d.isFinalSession
    ? 'PROGRAMME COMPLETE'
    : `NEXT SESSION${d.nextSessionNumber !== null ? ` · ${String(d.nextSessionNumber).padStart(2, '0')}` : ''}`;
  /* The sign-off.
   *
   * A parent reaching the end of an arc should be told so warmly and by name.
   * "Aarav has finished every session in this programme" is a status line; this
   * is the last thing the family reads from us, so it reads like a send-off.
   * Named rather than pronouned — the child's pronouns are not something this
   * system is told, and guessing them in a congratulation is worse than not. */
  const heading = d.isFinalSession
    ? d.programmeName
      ? `The last session of ${d.programmeName}`
      : 'The last session of this programme'
    : d.nextSessionTitle || 'To be scheduled';
  const footnote = d.isFinalSession
    ? `Wishing ${d.studentName.split(' ')[0]} all the best for the journeys ahead.`
    : d.nextSessionWhen;

  line(doc, eyebrow, 53.2, 747.5, { size: 4.9, font: FONT.mono, color: C.amber, spacing: 1.2 });

  /* Bounded by the reschedule box, not by hope.
   *
   * A title long enough to reach it used to run underneath it and off the page.
   * The heading is a NAME, so if one ever arrives long it is cut rather than
   * allowed to collide. */
  const headingLimit = (d.rescheduleUrl ? 393.4 : R) - 53.2 - 14;
  doc.font(FONT.display).fontSize(13.5);
  let shown = heading;
  if (doc.widthOfString(shown, { lineBreak: false }) > headingLimit) {
    while (shown.length > 8 && doc.widthOfString(`${shown}…`, { lineBreak: false }) > headingLimit) {
      shown = shown.slice(0, -1);
    }
    shown = `${shown.trimEnd()}…`;
  }
  // Clear of the eyebrow: a 13.5pt display face needs its ascent, and at 756
  // the two lines collided.
  line(doc, shown, 53.2, 759.5, { size: 13.5, font: FONT.display, color: C.cream });

  if (footnote) {
    line(doc, footnote, 53.2, 780, { size: 6, font: FONT.mono, color: C.cream, spacing: 0.5 });
  }

  // Nothing left to reschedule once the programme is finished.
  if (d.rescheduleUrl && !d.isFinalSession) {
    doc.roundedRect(393.4, 753.4, 148.5, 29.2, 4).lineWidth(0.75).stroke(C.cream);
    line(doc, 'NEED TO RESCHEDULE?', 0, 760.1, {
      size: 4.9,
      font: FONT.mono,
      color: C.cream,
      spacing: 0.8,
      rightAt: 533,
    });
    centered(doc, d.rescheduleUrl, 393.4 + 74.25, 768.7, { size: 6, font: FONT.mono, color: C.cream });
  }
};

/* ── Entry point ─────────────────────────────────────────────────────────── */

/** Draw the whole two-page report onto an already-created document. */
export const drawSessionReport = (doc: Doc, d: ReportDocument): void => {
  masthead(doc, 'SESSION REPORT · CONFIDENTIAL TO PARENT');
  identityBlock(doc, d);
  infoStrip(doc, d);
  voiceBalance(doc, d);
  participation(doc, d);
  topicsCovered(doc, d);
  sessionHighlights(doc, d);
  pageFooter(doc, `${d.brandName.toUpperCase()} · THINK FORGE GLOBAL LLP`, 1, 2);

  doc.addPage();

  const sessionBit = d.sessionNumber !== null ? ` · SESSION ${String(d.sessionNumber).padStart(2, '0')}` : '';
  masthead(doc, `${d.studentName.toUpperCase()}${sessionBit} · ${d.dateLabel.toUpperCase()}`);
  wordCloud(doc, d);
  learningOutcomes(doc, d);
  activities(doc, d);
  nextSessionBand(doc, d);
  pageFooter(doc, d.footerNote, 2, 2);
};
