/**
 * Turns the AI class summary into something a PDF can lay out.
 *
 * The summary is produced by Groq/Llama against a fixed prompt (see
 * learning-service's GroqTranscriptionService), so it *usually* arrives as a
 * banner, a metrics block, and five numbered sections. "Usually" is the operative
 * word — it is model output, and a parser that assumes the shape holds will one
 * day render a blank report for a real parent. Every step here degrades: if the
 * structure cannot be found, the whole cleaned text is rendered as prose instead.
 */

export interface SummaryMetric {
  label: string;
  value: string;
}

export interface SummarySection {
  title: string;
  /** Bullet text with the leading marker removed. */
  bullets: string[];
  /** Free paragraphs that were not bullets. */
  paragraphs: string[];
}

export interface ParsedSummary {
  metrics: SummaryMetric[];
  sections: SummarySection[];
  /** One sentence fit for a WhatsApp message body. Never empty. */
  headline: string;
  /** HIGH / MEDIUM / MODERATE, when the metrics block reported it. */
  engagement?: string;
  /** True when no structure was recognised and `sections` holds raw prose. */
  degraded: boolean;
}

/* ── Character handling ──────────────────────────────────────────────────────
 * PDFKit's built-in Helvetica is a WinAnsi font: it has no glyph for an emoji,
 * a rupee sign, or anything else outside Latin-1 plus a handful of typographic
 * extras. Unmappable codepoints do not throw — they silently become blanks or
 * boxes in a document that goes to a parent — so they are mapped or removed
 * here, once, rather than discovered in a PDF viewer.
 * ────────────────────────────────────────────────────────────────────────── */

/** Codepoints WinAnsi carries above U+00FF. */
const WINANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** Substitutions worth making before anything is dropped. */
const TRANSLITERATIONS: Array<[RegExp, string]> = [
  // "Rs " and not "Rs. ": the full stop reads as a sentence boundary to
  // `deriveHeadline`, which then cut the WhatsApp message body off at
  // "...a deposit of Rs." — a broken sentence in the one line a parent reads first.
  [/₹/g, 'Rs '],
  [/[→➡➔]/g, '->'],
  [/[←]/g, '<-'],
  [/[✓✔✅]/g, '[x]'],
  [/[❌✗✘]/g, '[ ]'],
  [/ /g, ' '],
  [/[─-╿]/g, '-'], // box drawing
];

export const toPdfSafeText = (input: string): string => {
  let text = String(input ?? '');
  for (const [pattern, replacement] of TRANSLITERATIONS) {
    text = text.replace(pattern, replacement);
  }

  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x0a || code === 0x09) {
      out += char;
      continue;
    }
    if (code < 0x20) continue;
    if (code <= 0xff) {
      out += char;
      continue;
    }
    if (WINANSI_EXTRAS.has(code)) {
      out += char;
      continue;
    }
    // Everything else — emoji, CJK, symbols — has no glyph. Dropped, but a
    // decorative emoji sitting alone on a heading leaves the heading intact.
  }
  return out;
};

/* ── Parsing ─────────────────────────────────────────────────────────────── */

const BANNER = /^[=\-_*]{4,}$/;
/** "1. EXECUTIVE OVERVIEW & CONTEXT" — the number is what makes it a heading. */
const NUMBERED_HEADING = /^\s*(\d{1,2})[.)]\s+(.{3,120})$/;
/** "- Total Spoken Word Count: 812 words" */
const METRIC_LINE = /^\s*[-*•]?\s*([A-Za-z][A-Za-z0-9 &/()'%-]{2,60}?)\s*:\s*(.+)$/;
const BULLET_LINE = /^\s*[-*•]\s+(.*)$/;

/** Sections that must never reach a parent's PDF. */
const EXCLUDED_HEADINGS = [/full transcript/i, /^transcript$/i, /raw transcript/i];

const isExcluded = (title: string): boolean => EXCLUDED_HEADINGS.some((p) => p.test(title));

/** Strip the leading emoji/symbol run a heading usually starts with. */
const cleanHeading = (raw: string): string =>
  toPdfSafeText(raw)
    .replace(/^[\s\-–—:]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

const titleCase = (heading: string): string => {
  // The model shouts its headings. Sentence case reads better in a document a
  // parent actually sits down with.
  if (heading !== heading.toUpperCase()) return heading;
  return heading
    .toLowerCase()
    .replace(/(^|[\s(/&-])([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
};

export const parseClassSummary = (rawSummary: string): ParsedSummary => {
  const safe = toPdfSafeText(rawSummary || '');
  const lines = safe.split(/\r?\n/);

  const metrics: SummaryMetric[] = [];
  const sections: SummarySection[] = [];
  let engagement: string | undefined;

  let current: SummarySection | null = null;
  let inMetricsBlock = false;
  let skippingSection = false;

  const pushCurrent = () => {
    if (current && (current.bullets.length > 0 || current.paragraphs.length > 0)) {
      sections.push(current);
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed.length === 0 || BANNER.test(trimmed)) continue;

    // A metrics block is announced by its own heading and ends at the next one.
    if (/interaction\s*&?\s*engagement\s*metrics/i.test(trimmed) || /^exact .*metrics$/i.test(cleanHeading(trimmed))) {
      pushCurrent();
      inMetricsBlock = true;
      skippingSection = false;
      continue;
    }

    // Banner titles like "SESSION NOTES" / "UNIFIED MASTER CLASS SUMMARY" are
    // scaffolding, not content.
    if (/^(session notes|unified master class summary.*)$/i.test(cleanHeading(trimmed))) {
      pushCurrent();
      inMetricsBlock = false;
      skippingSection = false;
      continue;
    }

    const headingMatch = trimmed.match(NUMBERED_HEADING);
    if (headingMatch) {
      pushCurrent();
      inMetricsBlock = false;
      const title = titleCase(cleanHeading(headingMatch[2]));
      if (isExcluded(title)) {
        skippingSection = true;
        continue;
      }
      skippingSection = false;
      current = { title, bullets: [], paragraphs: [] };
      continue;
    }

    if (skippingSection) continue;

    if (inMetricsBlock) {
      const metricMatch = trimmed.match(METRIC_LINE);
      if (metricMatch) {
        const label = metricMatch[1].trim();
        const value = metricMatch[2].trim();
        metrics.push({ label, value });
        if (/engagement rating/i.test(label)) engagement = value;
      }
      continue;
    }

    const bulletMatch = trimmed.match(BULLET_LINE);
    if (bulletMatch) {
      const text = bulletMatch[1].trim();
      if (text.length === 0) continue;
      if (!current) current = { title: 'Session notes', bullets: [], paragraphs: [] };
      current.bullets.push(text);
      continue;
    }

    if (!current) current = { title: 'Session notes', bullets: [], paragraphs: [] };
    current.paragraphs.push(trimmed);
  }

  pushCurrent();

  // Nothing recognised — render the cleaned text as prose rather than an empty
  // document. A parent reading slightly rough formatting is a far better outcome
  // than a parent receiving a blank page.
  const degraded = sections.length === 0 && metrics.length === 0;
  if (degraded) {
    const paragraphs = safe
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !BANNER.test(l));
    if (paragraphs.length > 0) {
      sections.push({ title: 'Session notes', bullets: [], paragraphs });
    }
  }

  return { metrics, sections, headline: deriveHeadline(sections), engagement, degraded };
};

/**
 * A single sentence for the WhatsApp message body.
 *
 * Prefers the overview section, then the topics covered, then anything at all.
 * Never returns an empty string: the template variable would be rejected by
 * Meta, and a parent would get a message with a hole in it.
 */
const deriveHeadline = (sections: SummarySection[]): string => {
  const preferred =
    sections.find((s) => /overview|context|executive/i.test(s.title)) ??
    sections.find((s) => /topic|concept|covered/i.test(s.title)) ??
    sections[0];

  const candidate = preferred?.bullets[0] ?? preferred?.paragraphs[0] ?? '';

  // Split only where a terminator is followed by something that can START a
  // sentence. Without the lookahead, "Rs. 10,000", "e.g. compounding" and "Dr.
  // Rao" all read as sentence ends and the headline arrives as a fragment.
  const sentence = candidate.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z])/)[0]?.trim() ?? '';

  if (sentence.length >= 20) return truncate(sentence, 300);
  if (candidate.trim().length > 0) return truncate(candidate.trim(), 300);
  return 'A full write-up of the session is attached.';
};

export const truncate = (text: string, max: number): string => {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
};
