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

/* ── The word cloud ──────────────────────────────────────────────────────────
 *
 * "WORDS FROM THE SESSION · most used" means exactly that: the words actually
 * spoken, counted. It was previously built from the concept lexicon, which is a
 * list of PHRASES — so the panel filled with "Health Insurance", "SHARING RISK"
 * and, before the deck filter, whole sentences off a slide. None of that is a
 * word cloud; it is a table of contents set in different sizes.
 */

/** Words that carry no meaning in a cloud: grammar, and the noise of speech. */
const CLOUD_STOPWORDS = new Set([
  // grammar
  'the', 'and', 'that', 'have', 'for', 'not', 'with', 'you', 'this', 'but', 'his', 'her',
  'they', 'she', 'him', 'from', 'their', 'what', 'about', 'which', 'who', 'when', 'will',
  'there', 'can', 'all', 'would', 'has', 'one', 'our', 'out', 'get', 'been', 'them', 'into',
  'him', 'some', 'could', 'other', 'than', 'then', 'its', 'also', 'because', 'any', 'these',
  'those', 'how', 'why', 'where', 'was', 'were', 'are', 'did', 'does', 'doing', 'done',
  'had', 'having', 'here', 'more', 'most', 'much', 'very', 'such', 'own', 'same', 'over',
  'under', 'again', 'once', 'both', 'each', 'few', 'nor', 'too', 'only', 'off', 'onto',
  'per', 'via', 'yet', 'let', 'lets', 'may', 'might', 'must', 'shall', 'should', 'still',
  'upon', 'while', 'with', 'within', 'without', 'your', 'yours', 'mine', 'ours', 'theirs',
  // speech
  'yeah', 'yes', 'okay', 'right', 'like', 'know', 'think', 'just', 'actually', 'really',
  'mean', 'sort', 'kind', 'well', 'now', 'see', 'say', 'said', 'says', 'tell', 'told',
  'going', 'gonna', 'want', 'need', 'good', 'great', 'nice', 'sure', 'maybe', 'thing',
  'things', 'something', 'anything', 'nothing', 'everything', 'someone', 'everyone',
  'lot', 'lots', 'bit', 'little', 'big', 'small', 'new', 'old', 'first', 'last', 'next',
  'come', 'came', 'take', 'took', 'give', 'gave', 'make', 'made', 'put', 'look', 'looks',
  'use', 'used', 'try', 'trying', 'let', 'even', 'ever', 'never', 'always', 'sometimes',
  'today', 'yesterday', 'tomorrow', 'time', 'times', 'way', 'ways', 'part', 'point',
  'question', 'answer', 'correct', 'wrong', 'exactly', 'perfect', 'understand', 'understood',
  'hello', 'hi', 'bye', 'please', 'thanks', 'thank', 'sorry', 'welcome', 'session', 'class',
  'teacher', 'student', 'sir', 'madam', 'ma’am',
  // Words that carry the sentence rather than the subject. A lesson is full of
  // "means", "happens" and "people"; none of them is what the lesson was about.
  'mean', 'means', 'meaning', 'happen', 'happens', 'happened', 'give', 'gives',
  'given', 'keep', 'keeps', 'ask', 'asks', 'asked', 'help', 'helps', 'people',
  'person', 'every', 'many', 'higher', 'lower', 'bad', 'better', 'best', 'worse',
  'call', 'calls', 'called', 'important', 'different', 'difference', 'example',
  'number', 'numbers', 'start', 'starts', 'started', 'end', 'ends', 'ended',
  // Spoken numbers. "five thousand rupees" should leave rupees, not five.
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety', 'hundred', 'thousand', 'lakh', 'lakhs', 'crore', 'crores',
  'million', 'billion', 'half', 'zero',
  'yourself', 'myself', 'himself', 'herself', 'itself', 'themselves', 'ourselves',
  // Seen leaking through on real sessions: sequence words, lesson furniture and
  // units of time. "years" next to "premium" tells a parent nothing.
  'after', 'before', 'during', 'comes', 'move', 'moves', 'moved', 'check',
  'checks', 'checked', 'checking', 'amount', 'amounts', 'year', 'years',
  'month', 'months', 'day', 'days', 'week', 'weeks', 'hour', 'hours',
  'scenario', 'scenarios', 'case', 'cases', 'step', 'steps', 'later', 'earlier',
]);

/**
 * The most-spoken meaningful words, largest first.
 *
 * `exclude` takes the names in the room: a child's own name is among the most
 * frequent words in any lesson and tells a parent nothing they do not know.
 */
/** How many terms the panel is given to lay out. */
/** How many terms the cloud panel shows. */
export const CLOUD_MAX_TERMS = 30;

/**
 * How many candidates are offered to the pruning pass.
 *
 * More than the cloud will ever show, because pruning only ever removes: if
 * exactly thirty are offered and a third are filler, the parent gets twenty.
 * Offering half again as many leaves the model room to cut and still fill the
 * panel. The final list is trimmed back to CLOUD_MAX_TERMS afterwards.
 */
export const CLOUD_CANDIDATE_MAX = 48;

/**
 * Below this many surviving candidates, words said only ONCE are let back in.
 *
 * The said-twice floor was tuned for a dense, all-English ninety-minute class,
 * where anything mentioned once is usually noise. A demo, a short class, or a
 * lesson taught partly in Malayalam produces a fraction of the English tokens
 * — the tokenizer reads Latin script only — and under the same floor a real
 * session rendered "No vocabulary was captured" while the child had spent an
 * hour talking about money, plans and school. In a thin transcript, said once
 * IS the vocabulary.
 */
export const CLOUD_SINGLETON_RELAX_BELOW = 20;

const CURATED_LOWER = new Set(CORE_FINANCIAL_VOCABULARY.map((t) => t.toLowerCase()));

/** Whether a lexicon entry deserves to stay one term in the cloud. */
export const phraseKeptWhole = (term: string): boolean => {
  const clean = String(term ?? '').trim();
  if (!clean.includes(' ')) return false;
  const words = clean.toLowerCase().split(/\s+/);
  if (words.some((w) => COMPARISON_WORDS.has(w))) return true;
  return CURATED_LOWER.has(clean.toLowerCase());
};

export const buildWordCloud = (
  turns: Turn[],
  exclude: string[] = [],
  /**
   * Multi-word concepts to look for before single words are counted.
   *
   * The session lexicon is exactly this list — the curated financial vocabulary
   * plus the deck's own filtered terms — so "Needs vs Wants" and "Health
   * Insurance" survive as one idea instead of being shredded into "needs",
   * "wants" and two copies of "insurance".
   */
  phrases: string[] = []
): WordCloudEntry[] => {
  const skip = new Set(CLOUD_STOPWORDS);
  for (const name of exclude) {
    for (const part of String(name ?? '').toLowerCase().split(/\s+/)) {
      if (part.length > 1) skip.add(part);
    }
  }

  /* Phrases are matched longest-first and their words consumed.
   *
   * Without consuming, "health insurance" would also add a point to "health"
   * and to "insurance" — the same breath counted three times, which inflates
   * whichever generic word the session repeats most. A standalone "insurance"
   * elsewhere in the transcript still counts on its own, which is right. */
  const candidates = phrases
    .map((p) => String(p ?? '').trim().replace(/\s+/g, ' '))
    .filter((p) => {
      const n = p.split(' ').length;
      return n >= 2 && n <= 3;
    })
    .map((p) => ({ display: p, tokens: p.toLowerCase().split(' ') }))
    .sort((a, b) => b.tokens.length - a.tokens.length);

  /* ── The allowlist ────────────────────────────────────────────────────────
   *
   * A word reaches the cloud because the lesson is ABOUT it, not because it
   * failed to appear on a list of bad words. The blocklist this replaces was
   * unwinnable by construction: every class produced filler nobody had
   * enumerated ("you're", "basically", "discussing", "goes"), we added those
   * exact words, and the next class produced different ones.
   *
   * The lexicon — the deck's own terms plus the curated financial vocabulary —
   * decides membership, supplies the canonical spelling, and folds word forms:
   * "saving", "savings" and "saves" all resolve to the deck's own "Saving"
   * instead of occupying three slots at three sizes.
   * ──────────────────────────────────────────────────────────────────────── */
  const allowed = new Map<string, string>();
  for (const phrase of phrases) {
    const term = String(phrase ?? '').trim();
    if (!term || term.includes(' ')) continue; // multi-word terms are handled above
    for (const key of wordVariants(term)) {
      if (!allowed.has(key)) allowed.set(key, term);
    }
  }

  /** The lesson's own word for this spoken form, or null if it is not one. */
  const canonicalFor = (word: string): string | null => {
    for (const key of wordVariants(word)) {
      const hit = allowed.get(key);
      if (hit) return hit;
    }
    return null;
  };

  /* `cap` and `midCap` catch proper nouns the exclude list cannot know about.
   *
   * Decks carry story characters ("What if Aarav Falls!"), and once the
   * possessive is folded away "Aarav" reads like vocabulary. But a name betrays
   * itself: it is capitalised at EVERY occurrence, including mid-sentence,
   * which no ordinary word is. Words that also occur lowercase — insurance,
   * premium — are untouched. Countries go with the names, which is right: a
   * parent learns nothing from "japan" in a cloud about insurance. */
  const counts = new Map<
    string,
    { display: string; n: number; cap: number; midCap: number; inLexicon: boolean }
  >();
  const bump = (
    key: string,
    display: string,
    capitalised = false,
    midSentence = false,
    inLexicon = false
  ) => {
    const existing = counts.get(key);
    if (existing) {
      existing.n += 1;
      if (inLexicon) existing.inLexicon = true;
      if (capitalised) {
        existing.cap += 1;
        if (midSentence) existing.midCap += 1;
      }
    } else {
      counts.set(key, {
        display,
        n: 1,
        cap: capitalised ? 1 : 0,
        midCap: capitalised && midSentence ? 1 : 0,
        inLexicon,
      });
    }
  };

  for (const turn of turns) {
    const text = String(turn.text ?? '');
    const raw: string[] = [];
    const atSentenceStart: boolean[] = [];
    const tokenRe = /[A-Za-z'’]+/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRe.exec(text))) {
      raw.push(match[0]);
      // A capital after . ! ? : or at the turn's opening is ordinary sentence
      // casing; a capital anywhere else is the word's own.
      const before = text.slice(0, match.index).replace(/["'’”)\]\s]+$/g, '');
      const prev = before.slice(-1);
      atSentenceStart.push(before.length === 0 || prev === '.' || prev === '!' || prev === '?' || prev === ':');
    }
    // Possessives and contractions fold onto their base word: "let's" becomes
    // "let" (a stopword), "Aarav's" becomes "Aarav". Without this the
    // apostrophe form dodges every filter and lands in the cloud verbatim.
    const words = raw.map(stripContraction);
    const lower = words.map((w) => w.toLowerCase());
    const consumed = new Array(words.length).fill(false);

    for (const phrase of candidates) {
      const len = phrase.tokens.length;
      for (let i = 0; i + len <= lower.length; i++) {
        if (consumed.slice(i, i + len).some(Boolean)) continue;
        let match = true;
        for (let j = 0; j < len; j++) {
          if (lexiconKey(lower[i + j]) !== lexiconKey(phrase.tokens[j])) { match = false; break; }
        }
        if (!match) continue;
        for (let j = 0; j < len; j++) consumed[i + j] = true;
        bump(phrase.tokens.join(' '), phrase.display, false, false, true);
      }
    }

    for (let i = 0; i < words.length; i++) {
      if (consumed[i]) continue;
      const word = words[i];
      if (word.length < 3 || word.length > 18) continue;
      if (skip.has(lower[i])) continue;
      // No vowel means a transcription artefact, not a word.
      if (!/[aeiou]/.test(lower[i])) continue;

      /* Folded onto the lesson's own term where there is one, so every form of
       * a concept — saving / savings / saves — is one entry at one size, spelled
       * the way the deck spells it. */
      const canonical = canonicalFor(lower[i]);
      bump(
        canonical ? lexiconKey(canonical.toLowerCase()) : lexiconKey(lower[i]),
        canonical ?? (ACRONYMS.has(word.toUpperCase()) ? word.toUpperCase() : lower[i]),
        /^[A-Z]/.test(word),
        !atSentenceStart[i],
        canonical !== null
      );
    }
  }

  /* ── Candidates, not the final cloud ──────────────────────────────────────
   *
   * A strict lexicon-only gate was tried and was too narrow in practice: a real
   * class produced two words, because a deck names concepts in its own phrasing
   * and a spoken lesson ranges wider. So this returns the frequency-ranked
   * candidates, mechanically cleaned — contractions stripped, word forms folded
   * onto the lesson's own spelling, stopwords and proper nouns removed — and
   * each entry says whether it is lesson vocabulary.
   *
   * Judgement about what is a CONCEPT rather than a common word is made after
   * this, by the pruning pass in the transcription service. That is the one
   * question here that is genuinely a judgement, and it is the reason a word
   * like "discussing" cannot be caught by any rule short of knowing what a
   * lesson is about.
   * ──────────────────────────────────────────────────────────────────────── */

  /* Merge the forms of a word that is NOT lesson vocabulary.
   *
   * Deck terms already fold onto the deck's own spelling. Everything else was
   * keyed on the plural rule alone, so "buy" and "buying" — or "save" and
   * "saving" — sat in the cloud as two entries at two sizes for one idea.
   *
   * Grouped by overlapping variant sets rather than by a stem, because
   * stemming without a dictionary invents words: the -es rule alone turns
   * "business" into "busin". Two forms meet in the same group only if one's
   * variants contain the other's key, and the most-spoken form supplies the
   * spelling. */
  const groups = new Map<string, { display: string; n: number; cap: number; midCap: number; inLexicon: boolean }>();
  const variantOwner = new Map<string, string>();

  for (const [key, entry] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const keys = key.includes(' ') ? [key] : wordVariants(key);
    let owner: string | undefined;
    for (const v of keys) {
      const found = variantOwner.get(v);
      if (found) { owner = found; break; }
    }

    if (owner) {
      const target = groups.get(owner)!;
      target.n += entry.n;
      target.cap += entry.cap;
      target.midCap += entry.midCap;
      if (entry.inLexicon) target.inLexicon = true;
    } else {
      groups.set(key, { ...entry });
      owner = key;
    }
    for (const v of keys) if (!variantOwner.has(v)) variantOwner.set(v, owner);
  }

  /* Said once is not "most used" — unless the lesson is about it.
   *
   * A deck term spoken once was still taught, and dropping it loses real
   * vocabulary while filler said twice survives. Lesson vocabulary therefore
   * needs one mention; everything else still needs two. */
  const cleaned = [...groups.values()]
    // Capitalised at every occurrence including mid-sentence = a proper noun.
    .filter((e) => !(e.cap === e.n && e.midCap > 0 && !ACRONYMS.has(e.display.toUpperCase())))
    .sort((a, b) => b.n - a.n || a.display.localeCompare(b.display));

  let ranked = cleaned.filter((e) => e.n >= 2 || e.inLexicon);
  if (ranked.length < CLOUD_SINGLETON_RELAX_BELOW) {
    // A thin pool: the floor is doing more deleting than the filler is. Every
    // other rail (stopwords, contractions, proper nouns, length, vowel) still
    // applies — this only forgives being said once.
    ranked = cleaned;
  }
  ranked = ranked.slice(0, CLOUD_CANDIDATE_MAX);
  if (ranked.length === 0) return [];

  const max = ranked[0].n;
  return ranked.map((e) => ({
    word: e.display,
    weight: Math.max(1, Math.min(10, Math.round((e.n / max) * 9) + 1)),
    inLexicon: e.inLexicon,
  }));
};

/**
 * Strip a contraction's clitic, leaving the base word.
 *
 * "you're" -> "you", "don't" -> "do", "we'll" -> "we", "Aarav's" -> "Aarav".
 * Only `'s` was handled before, so every other contraction reached the cloud
 * verbatim — `you're` and `don't` are not words anyone would think to put on a
 * stopword list, because they should never have survived tokenising.
 */
const stripContraction = (word: string): string =>
  word
    .replace(/^['’]+|['’]+$/g, '')
    .replace(/n['’]t$/i, '')
    .replace(/['’](re|ll|ve|d|m|s)$/i, '');

/**
 * Every form one word might be spoken in.
 *
 * Used to match what was SAID against what the lesson is ABOUT, so "saving",
 * "savings" and "saves" all find the deck's "Saving". Deliberately generous
 * and approximate: a wrong variant simply fails to match anything, whereas a
 * missing one splits a single concept across three entries at three sizes —
 * which is what put `buy`/`buying` and `save`/`saving` in the same cloud.
 */
const wordVariants = (word: string): string[] => {
  const w = word.trim().toLowerCase();
  if (w.length < 3) return [w];

  const out = new Set<string>([w, lexiconKey(w)]);
  const add = (v: string) => { if (v.length >= 3) out.add(v); };

  // "-ing" / "-ed": drop it, then also try the two spellings English uses —
  // a restored "e" (saving -> save) and an undoubled consonant (running -> run).
  for (const suffix of ['ing', 'ed']) {
    if (!w.endsWith(suffix) || w.length <= suffix.length + 2) continue;
    const base = w.slice(0, -suffix.length);
    add(base);
    add(base + 'e');
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) add(base.slice(0, -1));
  }
  if (w.endsWith('ly') && w.length > 4) add(w.slice(0, -2));
  if (w.endsWith('es') && w.length > 4) add(w.slice(0, -2));

  return [...out];
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
  lexicon: string[],
  /** Names in the room. Kept out of the word cloud, where a child's own name
   *  would otherwise be one of the largest words and tell a parent nothing. */
  exclude: string[] = []
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

  /* Counted from what was said, not from the concept list.
   *
   * The lexicon holds phrases — "Health Insurance", "Emergency Saving vs
   * Insurance" — and a cloud of phrases is a contents page in assorted sizes.
   * The panel is captioned "most used", so it now shows the words that were
   * most used. */
  /* Phrases are the exception, not the rule.
   *
   * Deck terms like "Health Insurance" used to be matched whole, which put
   * three insurance phrases in the cloud where the approved look wants
   * "Insurance" large once and "Health", "Vehicle", "Property" as their own
   * words. Only two kinds of phrase survive intact: a comparison ("Needs vs
   * Wants" — splitting it destroys the idea) and a curated multi-word term
   * ("Emergency Fund", "Compound Interest"). Everything else is counted word
   * by word. */
  const wordCloud: WordCloudEntry[] = buildWordCloud(turns, exclude, lexicon.filter(phraseKeptWhole));

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
