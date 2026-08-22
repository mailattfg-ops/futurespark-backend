/**
 * session-evidence.ts  —  NEW FILE
 * Package: @futurespark/constants (sits beside session-report.ts)
 *
 * The deterministic half of the analysis. Nothing here calls a model.
 *
 * ── The one idea this file exists for ────────────────────────────────────
 * The old pipeline asked the model for integers: "teacherQuestions": 55. A
 * language model asked for a bare count is estimating, not counting, and it
 * estimates differently every run — which is exactly the instability the
 * reports show. So the contract is inverted here:
 *
 *      the model lists EVENTS, each anchored to a numbered transcript turn;
 *      this file validates the anchors and calls .length.
 *
 * Same evidence in, same numbers out, forever. And because every item carries
 * a turn id, evidence gathered from overlapping multi-pass slices can be
 * merged exactly, instead of summed with `sumCounts` — which double-counted
 * anything that straddled a slice boundary.
 *
 * `LearningStatus`, `InteractionCounts` and `WordCloudEntry` are imported from
 * session-report.ts rather than redefined: the PDF renderer's shape stays the
 * single source of truth, and this file is only a new way of filling it.
 */

import { createHash } from 'crypto';
import type { InteractionCounts, LearningStatus, WordCloudEntry } from './session-report';

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. VERSIONING
 *
 * Every report records the suite that produced it. Without it, "the numbers
 * changed" is unfalsifiable — nobody can separate a prompt edit from model
 * drift from a genuine change in the child. Bump MINOR for wording, MAJOR for
 * anything that moves a count or a band boundary.
 * ═══════════════════════════════════════════════════════════════════════ */

export const PROMPT_SUITE_VERSION = '2.0.0';

export const hashText = (value: string): string =>
  createHash('sha256').update(value ?? '').digest('hex');

/**
 * The cache key, and the audit key.
 *
 * Two runs sharing a fingerprint MUST produce the same report; if they do not,
 * the provider is non-deterministic and should be pinned or swapped. Store it
 * on the recording row and return the stored report on re-run rather than
 * sampling the model again — a re-analysis that quietly produces different
 * numbers for an unchanged recording is the most damaging version of this bug,
 * because someone has usually already read the first one.
 */
export const analysisFingerprint = (input: {
  transcript: string;
  slideContent: string;
  model: string;
  studentName: string;
}): string =>
  [
    PROMPT_SUITE_VERSION,
    input.model,
    hashText(input.transcript).slice(0, 16),
    hashText(input.slideContent ?? '').slice(0, 16),
    (input.studentName ?? '').trim().toLowerCase(),
  ].join('|');

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. TURNS
 *
 * Analysis used to run over raw prose sliced at fixed character offsets. Two
 * consequences: the model had no way to point at what it saw, and a boundary
 * could land mid-exchange so the same question was extracted twice.
 *
 * Numbering turns fixes both. Evidence cites [T###]; a citation can be checked;
 * duplicates across overlapping slices collapse on turn id.
 * ═══════════════════════════════════════════════════════════════════════ */

export interface Turn {
  id: number;
  speaker: 'teacher' | 'student' | 'unknown';
  text: string;
  /** Seconds from session start, when the transcript carried [mm:ss]. */
  atSeconds: number | null;
}

const TURN_LABEL_RE =
  /^\s*(?:[-*•–—]\s*)?(?:[[(]?(\d{1,2}):(\d{2})(?::(\d{2}))?[\])]?\s*)?([A-Za-z][A-Za-z0-9 .'_-]{0,40}?)\s*:\s*(.*)$/;

const firstWord = (full: string) => (full || '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';

const matchesRole = (label: string, tokens: string[]): boolean =>
  tokens.some((token) => label === token || label.startsWith(`${token} `) || label.startsWith(`${token}(`));

/**
 * Parse a speaker-labelled transcript into numbered turns.
 *
 * Consecutive lines from the same speaker are merged. A transcriber that emits
 * one line per sentence would otherwise inflate the turn count and move every
 * downstream ratio for reasons that have nothing to do with the lesson.
 */
export const toNumberedTurns = (
  transcript: string,
  studentName = 'Student',
  mentorName = 'Instructor'
): Turn[] => {
  const studentTokens = ['student', 'child', 'learner', 'pupil', (studentName || '').toLowerCase(), firstWord(studentName)]
    .filter((t) => t.length >= 2);
  const teacherTokens = ['teacher', 'mentor', 'instructor', 'tutor', 'trainer', (mentorName || '').toLowerCase(), firstWord(mentorName)]
    .filter((t) => t.length >= 2);

  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const line of (transcript ?? '').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    const matched = TURN_LABEL_RE.exec(line);
    let speaker: Turn['speaker'] | null = null;
    let text = line.trim();
    let atSeconds: number | null = null;

    if (matched) {
      const [, h, m, s, rawLabel, rest] = matched;
      const label = rawLabel.trim().toLowerCase();
      if (matchesRole(label, studentTokens)) speaker = 'student';
      else if (matchesRole(label, teacherTokens)) speaker = 'teacher';

      if (speaker) {
        text = (rest ?? '').trim();
        if (h !== undefined && m !== undefined) {
          atSeconds = s !== undefined
            ? Number(h) * 3600 + Number(m) * 60 + Number(s)
            : Number(h) * 60 + Number(m);
        }
      }
      // An unrecognised "word:" is ordinary speech ("So the point is:"), not a
      // speaker change — do not open a new turn for it.
    }

    if (speaker === null) {
      if (current) {
        current.text += ` ${text}`;
        continue;
      }
      speaker = 'unknown';
    }

    if (current && current.speaker === speaker) {
      current.text += ` ${text}`;
    } else {
      current = { id: turns.length + 1, speaker, text, atSeconds };
      turns.push(current);
    }
  }

  return turns;
};

/** How the model sees the transcript. The [T###] tag is what evidence cites. */
export const renderTurns = (turns: Turn[]): string =>
  turns
    .map((t) => {
      const who = t.speaker === 'teacher' ? 'Teacher' : t.speaker === 'student' ? 'Student' : 'Unclear';
      return `[T${String(t.id).padStart(3, '0')}] ${who}: ${t.text}`;
    })
    .join('\n');

/**
 * Slice on TURN boundaries, never mid-turn.
 *
 * `overlapTurns` carries a little context across each seam. Overlap is safe
 * precisely because evidence merges by turn id: a turn read by two passes
 * contributes once.
 */
export const sliceByTurns = (turns: Turn[], charsPerSlice: number, overlapTurns = 2): Turn[][] => {
  const cost = (turn: Turn) => turn.text.length + 24;
  const slices: Turn[][] = [];

  let bucket: Turn[] = [];
  let size = 0;
  /** Turns added since the last flush — guarantees forward progress. */
  let fresh = 0;

  for (const turn of turns) {
    if (size + cost(turn) > charsPerSlice && fresh > 0) {
      slices.push(bucket);

      const carry = bucket.slice(-overlapTurns);
      const carrySize = carry.reduce((sum, t) => sum + cost(t), 0);
      // Context is only worth carrying while it is context. Past a quarter of
      // the budget it displaces the turns the pass exists to read.
      const keep = carrySize < charsPerSlice * 0.25;

      bucket = keep ? [...carry] : [];
      size = keep ? carrySize : 0;
      fresh = 0;
    }

    bucket.push(turn);
    size += cost(turn);
    fresh += 1;
  }

  if (fresh > 0) slices.push(bucket);
  return slices;
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. THE SESSION LEXICON
 *
 * Free-text concept lists were the second-largest source of drift. One run
 * wrote "impulse buying", the next "impulsive purchase", the next "buying on
 * impulse" — three strings, one idea, and a word cloud of a different length
 * every time. `normalizeCloudWord` in session-report.ts cannot collapse those;
 * it only handles plurals.
 *
 * So the model no longer NAMES concepts. It SELECTS them, by exact string, from
 * a closed list built from this session's deck plus the programme vocabulary.
 * Anything genuinely discussed but absent from the list goes to
 * `unlistedConcepts`, which is reviewed internally and never rendered.
 * ═══════════════════════════════════════════════════════════════════════ */

export const CORE_FINANCIAL_VOCABULARY = [
  'Money', 'Saving', 'Spending', 'Budget', 'Income', 'Expense', 'Needs vs Wants',
  'Emergency Fund', 'Insurance', 'Premium', 'Bank Account', 'Interest', 'Compound Interest',
  'Loan', 'EMI', 'Credit', 'Debit', 'Credit Card', 'UPI', 'Digital Payment', 'Online Fraud',
  'Scam', 'Investment', 'Risk', 'Return', 'Inflation', 'Stock', 'Mutual Fund', 'Tax',
  'Pocket Money', 'Financial Goal', 'Profit', 'Loss', 'Discount', 'Unit Cost',
  'Impulsive Purchase', 'Opportunity Cost', 'Delayed Gratification', 'Real Cost',
  'Peer Pressure', 'FOMO', 'FOBO', 'Subscription Trap', 'Sale Trap', 'Influenced Buying',
  'Smart Spender', 'Buy It For Life', 'Circular Economy', 'Tendering',
];

/**
 * Build the closed concept list for one session.
 *
 * The deck's own terms lead — they are what this class was about — then the
 * core vocabulary fills the budget. Capped at 80: a longer list stops
 * constraining anything and starts costing tokens the transcript needs.
 */
/* ── Is this a concept, or just a line off a slide? ──────────────────────────
 *
 * The deck is read line by line, and every line used to become a "key concept".
 * A real session produced this list for a parent to read:
 *
 *   QUICK CHECK · Now think about it · THE STORM · WHO ARE INVOLVED ·
 *   Suddenly a ball hit the kitchen window - · What is Insurance?
 *
 * Those are slide headings and narration, not vocabulary. They tell a parent
 * nothing, and they crowd out the terms that do — premium, deductible, claim.
 *
 * Applied ONLY to deck-derived lines. CORE_FINANCIAL_VOCABULARY is hand-written
 * and contains deliberate exceptions ("Needs vs Wants", "Buy It For Life") that
 * these rules would throw away.
 */

/**
 * "X vs Y" is a concept in this curriculum, not a sentence.
 *
 * Needs vs Wants, Saving vs Investing, Emergency Saving vs Insurance — the
 * comparison IS the lesson, so the connective is allowed and the phrase is
 * given room for four words instead of three.
 */
const COMPARISON_WORDS = new Set(['vs', 'v', 'versus']);

/**
 * Capitals that are the word, not shouting.
 *
 * De-shouting a deck turns INSURANCE into Insurance, which is right, and UPI
 * into Upi, which is wrong — and these are exactly the terms an Indian family
 * would recognise on sight. Listed explicitly rather than guessed from length,
 * because RISK and ATM are both short and only one of them is an acronym.
 */
const ACRONYMS = new Set([
  'UPI', 'EMI', 'ATM', 'PIN', 'KYC', 'NAV', 'SIP', 'FD', 'RD', 'PPF', 'NPS',
  'GST', 'TDS', 'IPO', 'NFO', 'FOMO', 'FOBO', 'EPF', 'UAN', 'CIBIL', 'IFSC',
  'OTP', 'NEFT', 'RTGS', 'IMPS', 'PAN', 'ROI', 'CTC', 'HRA', 'LIC', 'IRDAI',
]);

/** A term almost never contains one of these; a sentence almost always does. */
const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'been',
  'if', 'that', 'this', 'these', 'those', 'how', 'what', 'who', 'whom', 'why', 'when',
  'where', 'which', 'about', 'above', 'below', 'it', 'its', 'to', 'for', 'with', 'in',
  'on', 'at', 'from', 'by', 'your', 'my', 'our', 'their', 'his', 'her', 'you', 'we',
  'they', 'i', 'let', 'lets', 'do', 'does', 'did', 'can', 'will', 'would', 'should',
  'into', 'than', 'then', 'so', 'but', 'as', 'up', 'out', 'now', 'here', 'there',
]);

/** Headings every deck has, which describe the slide rather than the subject. */
const SLIDE_FURNITURE = new Set([
  'quick check', 'check', 'recap', 'summary', 'review', 'activity', 'exercise',
  'warm up', 'warmup', 'wrap up', 'wrapup', 'agenda', 'objective', 'objectives',
  'outcome', 'outcomes', 'intro', 'introduction', 'discussion', 'scenario',
  'example', 'examples', 'task', 'question', 'questions', 'answer', 'answers',
  'homework', 'takeaway', 'takeaways', 'key term', 'key terms', 'mind map',
  'fun fact', 'stop', 'level', 'welcome', 'next', 'conclusion', 'overview',
  'contents', 'index', 'title', 'thank you', 'thanks', 'quiz', 'poll', 'note',
  'notes', 'tip', 'tips', 'remember', 'checkpoint', 'reflection', 'practice',
  'story', 'case study', 'did you know', 'lets begin', 'begin', 'end', 'the end',
  'group activity', 'class activity', 'your turn', 'my turn', 'think', 'imagine',
]);

/** True when a deck line reads like a term rather than a sentence or a heading. */
export const isConceptLike = (raw: string): boolean => {
  const term = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (term.length < 3 || term.length > 40) return false;

  // Sentence punctuation is the clearest tell: a term does not end in a comma,
  // ask a question or shout.
  if (/[?!,;:]/.test(term)) return false;
  if (/[-–—]$/.test(term)) return false;
  if (/\d/.test(term) && /\s/.test(term)) return false; // "STOP 2", "Level 3 recap"

  const words = term.split(' ');
  const lower = words.map((w) => w.toLowerCase().replace(/[^a-z']/g, ''));
  const isComparison = lower.some((w) => COMPARISON_WORDS.has(w));

  // A comparison earns one extra word: "Emergency Saving vs Insurance".
  if (words.length > (isComparison ? 4 : 3)) return false;

  if (lower.some((w) => FUNCTION_WORDS.has(w))) return false;
  if (lower.some((w) => w.includes("'"))) return false; // "That's", "Let's"

  if (SLIDE_FURNITURE.has(term.toLowerCase())) return false;

  return true;
};

/**
 * Decks shout their headings. A cloud of SHARING RISK next to "premium" reads
 * as two different kinds of thing, so an all-caps line is title-cased back.
 */
export const tidyDeckTerm = (raw: string): string => {
  const term = (raw ?? '').trim().replace(/\s+/g, ' ');

  /* Is it shouted? Judged on the real words only.
   *
   * "EMERGENCY SAVING vs INSURANCE" is shouted, but a plain toUpperCase()
   * comparison says otherwise because the connective is already lowercase —
   * which left it shouting in the middle of an otherwise title-cased cloud. */
  const spoken = term
    .split(' ')
    .filter((w) => !COMPARISON_WORDS.has(w.toLowerCase()) && !ACRONYMS.has(w.toUpperCase()));
  const shouted = spoken.length > 0 && spoken.every((w) => w === w.toUpperCase());
  if (!shouted) return term; // already mixed case, or all acronyms — leave it
  return term
    .toLowerCase()
    .split(' ')
    // "Vs" reads as a typo; the connective stays lowercase the way anyone
    // writing "Needs vs Wants" by hand would.
    .map((w) => {
      if (COMPARISON_WORDS.has(w)) return w;
      if (ACRONYMS.has(w.toUpperCase())) return w.toUpperCase();
      return w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w;
    })
    .join(' ');
};

/** Singular, lowercase form — the identity a concept is deduped on. */
const lexiconKey = (word: string): string => {
  const w = word.trim().toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ses") || w.endsWith("xes") || w.endsWith("ches") || w.endsWith("shes")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
};

export const buildSessionLexicon = (deckTerms: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  // Deck lines are filtered and de-shouted; the curated list is trusted as-is.
  const fromDeck = (deckTerms ?? []).filter(isConceptLike).map(tidyDeckTerm);

  for (const term of [...fromDeck, ...CORE_FINANCIAL_VOCABULARY]) {
    const clean = (term ?? '').trim().replace(/\s+/g, ' ');
    if (clean.length < 2 || clean.length > 40) continue;
    if (/^\d/.test(clean)) continue;
    // Deduped on the SINGULAR form, not the literal string. An exact-match
    // key let "Saving" and "Savings" both into the closed lexicon, and because
    // the cloud is built straight from lexicon hits they then rendered as two
    // entries at different sizes for one concept. Same rule as the renderer's
    // normalizeCloudWord, kept local because session-report imports THIS file.
    const key = lexiconKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 80) break;
  }
  return out;
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. THE EVIDENCE ENVELOPE
 *
 * What the analysis model now returns instead of a SessionReport. Counts,
 * percentages, statuses and word-cloud weights are absent by design — every
 * one of them was a model-authored number that moved between runs.
 * ═══════════════════════════════════════════════════════════════════════ */

export type ResponseKind =
  | 'recall'
  | 'reasoning'
  | 'calculation'
  | 'application'
  | 'self_correction'
  | 'acknowledgement';

export interface EvidenceItem {
  turn: number;
  text?: string;
  concept?: string;
  higherOrder?: boolean;
  meaningful?: boolean;
  independent?: boolean;
  kind?: ResponseKind;
}

export interface RawEvidence {
  teacherQuestions?: EvidenceItem[];
  studentQuestions?: EvidenceItem[];
  studentResponses?: EvidenceItem[];
  conceptsTaught?: EvidenceItem[];
  homeworkSet?: EvidenceItem[];
}

export type InternalFlagKind =
  | 'session_disruption'
  | 'mentor_note'
  | 'child_disclosure'
  | 'engagement'
  | 'content_gap'
  | 'safeguarding';

export interface InternalFlag {
  kind: InternalFlagKind;
  turn?: number | null;
  note: string;
}

/** The narrative half — the model's actual job now. */
export interface AnalysisNarrative {
  learningGoals: string[];
  topicsCovered: string[];
  topicsNotReached: string[];
  parentSummary: string;
  conceptUnderstandingNote: string;
  applicationNote: string;
  financialReasoningNote: string;
  independenceNote: string;
  highlight: string;
  questionQuality: string;
  keyLearningMoment: string;
  developmentArea: string;
  nextSessionFocus: string;
  parentConnection: string;
}

export interface AnalysisEnvelope {
  coverageNote: 'full' | 'gaps' | 'partial';
  evidence: RawEvidence;
  unlistedConcepts: string[];
  internalFlags: InternalFlag[];
  narrative: AnalysisNarrative;
}

const asTrimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asList = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value.map(asTrimmed).filter((v) => v.length > 0).slice(0, max)
    : [];

const asItems = (value: unknown): EvidenceItem[] =>
  Array.isArray(value)
    ? value
        .filter((v) => v && typeof v === 'object')
        .map((v: any) => ({
          turn: Number(v.turn),
          text: asTrimmed(v.text) || undefined,
          concept: asTrimmed(v.concept) || undefined,
          higherOrder: v.higherOrder === true,
          meaningful: v.meaningful === true,
          independent: v.independent === true,
          kind: typeof v.kind === 'string' ? (v.kind as ResponseKind) : undefined,
        }))
    : [];

/** Coerce untrusted model output into an envelope. Never throws. */
export const parseAnalysisEnvelope = (raw: any): AnalysisEnvelope => {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ev = (r.evidence ?? {}) as any;
  const n = (r.narrative ?? r) as any;

  return {
    coverageNote: r.coverageNote === 'gaps' || r.coverageNote === 'partial' ? r.coverageNote : 'full',
    evidence: {
      teacherQuestions: asItems(ev.teacherQuestions),
      studentQuestions: asItems(ev.studentQuestions),
      studentResponses: asItems(ev.studentResponses),
      conceptsTaught: asItems(ev.conceptsTaught),
      homeworkSet: asItems(ev.homeworkSet),
    },
    unlistedConcepts: asList(r.unlistedConcepts, 30),
    internalFlags: Array.isArray(r.internalFlags)
      ? r.internalFlags
          .filter((f: any) => f && typeof f === 'object' && asTrimmed(f.note))
          .map((f: any) => ({
            kind: (f.kind ?? 'mentor_note') as InternalFlagKind,
            turn: Number.isFinite(Number(f.turn)) ? Number(f.turn) : null,
            note: asTrimmed(f.note),
          }))
          .slice(0, 25)
      : [],
    narrative: {
      learningGoals: asList(n.learningGoals, 4),
      topicsCovered: asList(n.topicsCovered, 12),
      topicsNotReached: asList(n.topicsNotReached, 12),
      parentSummary: asTrimmed(n.parentSummary),
      conceptUnderstandingNote: asTrimmed(n.conceptUnderstandingNote),
      applicationNote: asTrimmed(n.applicationNote),
      financialReasoningNote: asTrimmed(n.financialReasoningNote),
      independenceNote: asTrimmed(n.independenceNote),
      highlight: asTrimmed(n.highlight),
      questionQuality: asTrimmed(n.questionQuality),
      keyLearningMoment: asTrimmed(n.keyLearningMoment),
      developmentArea: asTrimmed(n.developmentArea),
      nextSessionFocus: asTrimmed(n.nextSessionFocus),
      parentConnection: asTrimmed(n.parentConnection),
    },
  };
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. VALIDATION AND MERGE
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Drop evidence citing a turn that does not exist, or a turn belonging to the
 * wrong speaker.
 *
 * This is what makes the citation rule real rather than decorative. A model
 * padding its evidence to look thorough cites loosely, and every loose citation
 * is removed here instead of counted. A "teacher question" attributed to a
 * student turn is not a near miss; it is fabrication.
 *
 * The dedupe key is (turn, first six words), so two genuine questions inside
 * one turn both survive while the same question arriving from two overlapping
 * passes collapses to one.
 */
const validateItems = (
  items: EvidenceItem[] | undefined,
  turns: Map<number, Turn>,
  expect?: 'teacher' | 'student'
): EvidenceItem[] => {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];

  for (const item of items) {
    const turn = turns.get(Number(item?.turn));
    if (!turn) continue;
    if (expect && turn.speaker !== expect && turn.speaker !== 'unknown') continue;

    const signature = (item.text ?? item.concept ?? '').toLowerCase().split(/\s+/).slice(0, 6).join(' ');
    const key = `${item.turn}|${signature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out.sort((a, b) => a.turn - b.turn || (a.text ?? '').localeCompare(b.text ?? ''));
};

/**
 * Merge per-slice evidence from the multi-pass path.
 *
 * Replaces `sumCounts`. Summing per-slice integers counted a seam exchange
 * twice and could not be reconciled with the single-shot path; concatenating
 * turn-anchored items and deduping produces the same totals either way, which
 * is the whole point of the exercise.
 */
export const mergeEnvelopes = (parts: AnalysisEnvelope[]): AnalysisEnvelope => {
  const base: AnalysisEnvelope = {
    coverageNote: parts.some((p) => p.coverageNote !== 'full') ? 'gaps' : 'full',
    evidence: {
      teacherQuestions: [],
      studentQuestions: [],
      studentResponses: [],
      conceptsTaught: [],
      homeworkSet: [],
    },
    unlistedConcepts: [],
    internalFlags: [],
    narrative: parseAnalysisEnvelope({}).narrative,
  };

  for (const part of parts) {
    base.evidence.teacherQuestions!.push(...(part.evidence.teacherQuestions ?? []));
    base.evidence.studentQuestions!.push(...(part.evidence.studentQuestions ?? []));
    base.evidence.studentResponses!.push(...(part.evidence.studentResponses ?? []));
    base.evidence.conceptsTaught!.push(...(part.evidence.conceptsTaught ?? []));
    base.evidence.homeworkSet!.push(...(part.evidence.homeworkSet ?? []));
    base.unlistedConcepts.push(...part.unlistedConcepts);
    base.internalFlags.push(...part.internalFlags);
  }

  base.unlistedConcepts = [...new Set(base.unlistedConcepts.map((c) => c.trim()))].filter(Boolean).slice(0, 30);
  const flagSeen = new Set<string>();
  base.internalFlags = base.internalFlags.filter((f) => {
    const key = `${f.kind}|${f.turn}|${f.note.slice(0, 40).toLowerCase()}`;
    if (flagSeen.has(key)) return false;
    flagSeen.add(key);
    return true;
  });

  return base;
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. DERIVATION — the numbers on the PDF
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Internal band, one level richer than `LearningStatus`.
 *
 * `null` on the report means "no evidence". That is correct but ambiguous: it
 * cannot distinguish a child who showed nothing from a session that simply did
 * not generate enough observations to rate. The QA report gets the distinction;
 * the parent report maps 'insufficient' to null and the renderer skips the row.
 */
export type EvidenceBand = 'insufficient' | 'Emerging' | 'Developing' | 'Proficient';

/** Minimum substantive responses before any area is rated at all. */
export const MIN_SAMPLE = 6;

const bandFromRatio = (numerator: number, denominator: number): EvidenceBand => {
  if (denominator < MIN_SAMPLE) return 'insufficient';
  const ratio = numerator / denominator;
  if (ratio >= 0.6) return 'Proficient';
  if (ratio >= 0.34) return 'Developing';
  return 'Emerging';
};

const toStatus = (band: EvidenceBand): LearningStatus | null =>
  band === 'insufficient' ? null : band;

export interface DerivedMetrics {
  interactions: InteractionCounts;
  bands: {
    conceptUnderstanding: EvidenceBand;
    application: EvidenceBand;
    financialReasoning: EvidenceBand;
    independence: EvidenceBand;
  };
  statuses: {
    conceptUnderstanding: LearningStatus | null;
    application: LearningStatus | null;
    financialReasoning: LearningStatus | null;
    independence: LearningStatus | null;
  };
  wordCloud: WordCloudEntry[];
  homework: string[];
  /** Evidence that survived validation — the QA report's raw material. */
  evidence: Required<RawEvidence>;
  /** Items the model cited that did not check out. High values mean padding. */
  discarded: number;
}

/**
 * Turn validated evidence into every number the report prints.
 *
 * Word-cloud weights are derived here too, from the number of distinct turns a
 * concept appears in. The model used to assign weights 1-10 by "learning
 * importance", which is a judgement it re-made every run — so the same session
 * rendered a differently-sized cloud each time. Frequency of genuine discussion
 * is a worse proxy for importance than a good judgement would be, but it is a
 * stable one, and stability is what a parent-facing document needs.
 */
export const deriveMetrics = (
  envelope: AnalysisEnvelope,
  turns: Turn[],
  lexicon: string[]
): DerivedMetrics => {
  const index = new Map(turns.map((t) => [t.id, t]));
  const raw = envelope.evidence;

  const before =
    (raw.teacherQuestions?.length ?? 0) +
    (raw.studentQuestions?.length ?? 0) +
    (raw.studentResponses?.length ?? 0) +
    (raw.conceptsTaught?.length ?? 0) +
    (raw.homeworkSet?.length ?? 0);

  /* Did the model return anything we could actually verify? If every cited
   * turn failed validation, the counts below are all zero for want of data —
   * which must read as "not measured", never as "it did not happen". */
  const usable = before > 0;

  const teacherQuestions = validateItems(raw.teacherQuestions, index, 'teacher');
  const studentQuestions = validateItems(raw.studentQuestions, index, 'student');
  const studentResponses = validateItems(raw.studentResponses, index, 'student');
  const conceptsTaught = validateItems(raw.conceptsTaught, index);
  const homeworkSet = validateItems(raw.homeworkSet, index, 'teacher');

  const after =
    teacherQuestions.length +
    studentQuestions.length +
    studentResponses.length +
    conceptsTaught.length +
    homeworkSet.length;

  const higherOrder = teacherQuestions.filter((q) => q.higherOrder).length;
  const meaningful = studentResponses.filter((r) => r.meaningful).length;
  const independent = studentResponses.filter((r) => r.independent).length;
  const substantive = studentResponses.filter((r) => r.kind !== 'acknowledgement');
  const applications = studentResponses.filter((r) => r.kind === 'application').length;
  const reasoning = studentResponses.filter((r) => r.kind === 'reasoning' || r.kind === 'calculation').length;
  const selfCorrections = studentResponses.filter((r) => r.kind === 'self_correction').length;

  // Concepts are matched back to the lexicon case-insensitively and emitted in
  // LEXICON order, so two runs selecting the same concepts in a different
  // sequence still render an identical cloud.
  const allowed = new Map(lexicon.map((term) => [term.toLowerCase(), term]));
  const turnsByConcept = new Map<string, Set<number>>();
  for (const item of conceptsTaught) {
    const canonical = allowed.get((item.concept ?? '').trim().toLowerCase());
    if (!canonical) continue;
    if (!turnsByConcept.has(canonical)) turnsByConcept.set(canonical, new Set());
    turnsByConcept.get(canonical)!.add(item.turn);
  }

  const maxMentions = Math.max(1, ...[...turnsByConcept.values()].map((s) => s.size));
  const wordCloud: WordCloudEntry[] = lexicon
    .filter((term) => turnsByConcept.has(term))
    .map((term) => {
      const mentions = turnsByConcept.get(term)!.size;
      // 1-10, banded off the busiest concept in this session. Integer by
      // construction so it cannot wobble on a rounding boundary.
      const weight = Math.max(1, Math.min(10, Math.round((mentions / maxMentions) * 9) + 1));
      return { word: term, weight };
    })
    .sort((a, b) => b.weight - a.weight || a.word.localeCompare(b.word))
    .slice(0, 25);

  const bands = {
    // Of the responses that carried content, how many showed real thinking.
    conceptUnderstanding: bandFromRatio(meaningful, substantive.length),
    // Absolute, not a ratio: connecting a lesson to your own life once is
    // meaningful, and any denominator here would be arbitrary.
    application:
      applications === 0
        ? substantive.length >= MIN_SAMPLE
          ? 'Emerging'
          : 'insufficient'
        : applications >= 3
          ? 'Proficient'
          : 'Developing',
    financialReasoning: bandFromRatio(reasoning, substantive.length),
    independence: bandFromRatio(independent, studentResponses.length),
  } as DerivedMetrics['bands'];

  return {
    /* Zero is a CLAIM about the child; absence of evidence is not.
     *
     * Counting validated evidence items gives 0 for both "the model looked and
     * found none" and "the model returned nothing usable" — and the second is
     * a measurement failure, not a fact. A report telling a parent their child
     * asked 0 questions because an evidence array came back empty is the exact
     * failure InteractionCounts documents itself against, so an unusable
     * response reports null and the PDF prints "Not available". */
    interactions: usable
      ? {
          teacherQuestions: teacherQuestions.length,
          studentQuestions: studentQuestions.length,
          higherOrderQuestions: higherOrder,
          meaningfulResponses: meaningful,
          independentResponses: independent,
          promptedResponses: studentResponses.length - independent,
          selfCorrections,
        }
      : {
          teacherQuestions: null,
          studentQuestions: null,
          higherOrderQuestions: null,
          meaningfulResponses: null,
          independentResponses: null,
          promptedResponses: null,
          selfCorrections: null,
        },
    bands,
    statuses: {
      conceptUnderstanding: toStatus(bands.conceptUnderstanding),
      application: toStatus(bands.application),
      financialReasoning: toStatus(bands.financialReasoning),
      independence: toStatus(bands.independence),
    },
    wordCloud,
    homework: homeworkSet.map((h) => h.text ?? '').filter(Boolean),
    evidence: { teacherQuestions, studentQuestions, studentResponses, conceptsTaught, homeworkSet },
    discarded: Math.max(0, before - after),
  };
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. TALK TIME — say what was actually measured
 *
 * The shipped PDF printed "Teacher 66m 45s · 75%". That 75% was a WORD share
 * multiplied by the session duration, and word share is not time share: an
 * adult explaining runs at ~150 words a minute, a ten-year-old thinking aloud
 * at roughly half that, so a genuine 60/40 split of minutes prints as 75/25 and
 * the mentor looks worse than they were.
 *
 * When the transcript carries [mm:ss] stamps — the audio-chat path emits them —
 * this measures real elapsed seconds per speaker and the figure becomes true.
 * Otherwise it falls back to word share and says so in `basis`, so the renderer
 * can caption the panel honestly instead of implying a measurement.
 * ═══════════════════════════════════════════════════════════════════════ */

export interface TalkShare {
  teacherPercent: number | null;
  studentPercent: number | null;
  basis: 'timestamps' | 'word-share' | 'unmeasurable';
  /** The caption the PDF should print beneath the bars. */
  label: string;
}

export const deriveTalkShare = (turns: Turn[], totalSeconds?: number | null): TalkShare => {
  const stamped = turns.filter((t) => t.atSeconds !== null);

  /* Stamps are only a clock if they run FORWARD across the whole class.
   *
   * A recording over the upload limit is transcribed in chunks, and each chunk
   * is its own audio file — so its [mm:ss] restart at 00:00. Concatenated, the
   * stamps step backwards at every seam, and measuring spans across them
   * produces chunk-relative durations that are then printed as though a
   * stopwatch had run over the real class. That is the same fabrication as a
   * word share captioned "talk time", one layer down. When the sequence is not
   * monotonic we do not trust it as a clock; the word-share path below still
   * gives an honest, correctly-labelled answer. */
  let monotonic = true;
  for (let i = 1; i < stamped.length; i++) {
    if ((stamped[i].atSeconds as number) < (stamped[i - 1].atSeconds as number)) {
      monotonic = false;
      break;
    }
  }

  const usableStamps = monotonic && stamped.length >= Math.max(6, turns.length * 0.6);

  if (usableStamps) {
    let teacherSeconds = 0;
    let studentSeconds = 0;
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      if (turn.atSeconds === null) continue;
      const next = turns.slice(i + 1).find((t) => t.atSeconds !== null);
      const end = next?.atSeconds ?? totalSeconds ?? turn.atSeconds;
      const span = Math.max(0, end - turn.atSeconds);
      if (turn.speaker === 'teacher') teacherSeconds += span;
      else if (turn.speaker === 'student') studentSeconds += span;
    }
    const total = teacherSeconds + studentSeconds;
    if (total > 0 && teacherSeconds > 0 && studentSeconds > 0) {
      const teacherPercent = Math.round((teacherSeconds / total) * 100);
      return {
        teacherPercent,
        studentPercent: 100 - teacherPercent,
        basis: 'timestamps',
        label: 'Talk time',
      };
    }
  }

  let teacherWords = 0;
  let studentWords = 0;
  for (const turn of turns) {
    const words = turn.text.split(/\s+/).filter(Boolean).length;
    if (turn.speaker === 'teacher') teacherWords += words;
    else if (turn.speaker === 'student') studentWords += words;
  }

  const total = teacherWords + studentWords;
  // A split is reported only when BOTH speakers were identified. The old code
  // banked an unlabelled transcript entirely to the mentor and printed
  // "Teacher 100% / Student 0%" for a class the child talked through.
  if (total === 0 || teacherWords === 0 || studentWords === 0) {
    // The label is a HEADING, so it stays a heading even here — the VALUE
    // beside it carries "Not available". Putting the words in the label
    // rendered the summary line as "Teacher not available: Not available".
    return { teacherPercent: null, studentPercent: null, basis: 'unmeasurable', label: 'Talk time' };
  }

  const teacherPercent = Math.round((teacherWords / total) * 100);
  return {
    teacherPercent,
    studentPercent: 100 - teacherPercent,
    basis: 'word-share',
    label: 'Share of words spoken',
  };
};

/** Word/sentence tallies kept for the activity log. Not parent-facing. */
export const transcriptStats = (turns: Turn[]) => {
  const text = turns.map((t) => t.text).join(' ');
  return {
    turnCount: turns.length,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    sentenceCount: Math.max(1, text.split(/[.!?]+/).filter(Boolean).length),
    studentTurns: turns.filter((t) => t.speaker === 'student').length,
    teacherTurns: turns.filter((t) => t.speaker === 'teacher').length,
    unlabelledTurns: turns.filter((t) => t.speaker === 'unknown').length,
  };
};
