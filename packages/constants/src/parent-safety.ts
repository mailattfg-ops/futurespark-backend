/**
 * parent-safety.ts  —  NEW FILE
 * Package: @futurespark/constants (sits beside session-report.ts)
 *
 * The last line of defence before a report reaches a parent's phone.
 *
 * ── Why instructions are not enough ──────────────────────────────────────
 * PARENT_SAFETY_RULES lowers the rate of a bad sentence; it cannot make it
 * zero, and the cost of the one that gets through is not symmetrical with the
 * cost of catching it. A held report is a WhatsApp message delayed by an hour.
 * A released one is a permanent, forwardable, written record about a named
 * child — and if it says the mentor was unprepared, or repeats what the child
 * said about their father's job, no correction afterwards undoes it.
 *
 * ── Why this throws rather than repairs ──────────────────────────────────
 * Rewriting the offending sentence quietly would ship more reports. It would
 * also destroy the only signal that a session went wrong: the model wrote that
 * sentence because something in the recording prompted it. A report that needed
 * repair is a report a human should read.
 */

import type { SessionReport } from './session-report';

export interface GuardrailHit {
  rule: string;
  field: string;
  matched: string;
}

export class ParentReportBlocked extends Error {
  readonly hits: GuardrailHit[];
  readonly recordingId: string | null;

  constructor(hits: GuardrailHit[], recordingId: string | null = null) {
    super(
      `Parent report held for human review — ${hits.length} guardrail hit(s): ` +
        // The offending TEXT is deliberately absent. This message is logged
        // and written to reportLastError, so including it would copy a
        // child's household disclosure into a log file and a database column
        // — exactly what P2 exists to keep out of writing. The text stays on
        // `hits` in memory for the admin preview.
        hits.map((h) => `${h.rule} in "${h.field}"`).join('; ')
    );
    this.name = 'ParentReportBlocked';
    this.hits = hits;
    this.recordingId = recordingId;
  }
}

/**
 * The rules, keyed to PARENT_SAFETY_RULES in prompt-defaults.ts.
 *
 * Deliberately literal rather than clever. A pattern that is easy to read is a
 * pattern an operator can extend the first time something new slips through,
 * and every entry here should be traceable to a sentence that either reached a
 * parent or nearly did.
 *
 * ── The rule these were retuned against ─────────────────────────────────────
 *
 * This is a MONEY course. "poor", "fail", "lack", "debt", "cannot afford" and
 * "family savings" are the syllabus, not violations. Measured against sixteen
 * ordinary report sentences, the first draft hard-blocked "He explained why a
 * poor choice of loan can cost more over time", "a business can fail if costs
 * are higher than revenue" and "the family savings act as a cushion" — three
 * correct reports held for saying exactly what the lesson taught.
 *
 * A guardrail that fires on the subject matter does not get tightened later;
 * it gets switched off, and then it protects nothing. So each rule below now
 * has to see the CHILD in the sentence — a pronoun, a name, "the student" —
 * before a deficit word counts. Clinical terms are the exception: no financial
 * lesson needs the word "dyslexia", so those still block on sight.
 */

/** The child, however the narrative refers to them. */
const CHILD = String.raw`(?:she|he|they|her|his|their|the (?:student|child|learner)|[A-Z][a-z]+)`;

const GUARDRAILS: Array<{ rule: string; pattern: RegExp }> = [
  /* P1 — our operational problems becoming the parent's problem.
   * The live pipeline prefixed parentSummary with "[Based on part of the
   * recording only — the full class could not be analysed on the current AI
   * plan.]". That is our billing tier, printed on a customer's document. */
  {
    rule: 'P1 internal-failure disclosure',
    pattern:
      /\b(could not be (analy[sz]ed|processed|transcribed|completed)|AI plan|current plan|transcript(ion)? (failed|error|gap)|technical (issue|difficulty|difficulties|problem)|connection (dropped|lost)|audio (cut|dropped|quality (was|is) poor)|recording (failed|missing|incomplete)|partial report|based on part of|omitted for length|middle of the session omitted)\b/i,
  },
  {
    /* Scoped to the PEOPLE running the class. "session" was in the subject
     * alternation, so any sentence containing that word within sixty
     * characters of a fault verb matched — including ones praising the child. */
    rule: 'P1 mentor fault',
    pattern:
      /\b(mentor|teacher|facilitator|instructor)\b[^.]{0,60}\b(was late|joined late|unprepared|not prepared|made a mistake|was (incorrect|wrong)|apolog\w+|forgot to|had to rush|rushed through|cut the (class|session) short|ended early)\b/i,
  },

  /* P2 — the child's household disclosures.
   * In a money class children volunteer what they hear at home: a salary, a
   * missed EMI, an argument, a job loss. Repeating it back to the parent in
   * writing, attributed to the child, ends the relationship.
   *
   * Both apostrophe characters are accepted: a model writes the curly one,
   * and matching only the ASCII apostrophe meant this rule quietly missed
   * the very sentences it was written for.
   *
   * Requires a POSSESSIVE. "the family savings act as a cushion" is the
   * lesson; "her family's savings" is a disclosure about this household. */
  {
    rule: 'P2 household disclosure',
    pattern: new RegExp(
      String.raw`\b(?:(?:her|his|their)\s+(?:family|father|mother|dad|mum|mom|parents)|(?:family|father|mother|dad|mum|mom|parents)['\u2019\u02BC]s)\s+\w*\s*(?:income|salary|pay|debt|loan|EMI|savings|job|business|shop)\b` +
        String.raw`|\blost (?:his|her|their) job\b` +
        String.raw`|\b(?:she|he|they|her family|his family) (?:cannot|can['\u2019\u02BC]t|couldn['\u2019\u02BC]t|could not) afford\b` +
        String.raw`|\bfinancial (?:trouble|difficulty|difficulties|stress|problems?) at home\b` +
        String.raw`|\bmoney problems at home\b` +
        String.raw`|\b(?:her|his|their) parents (?:argue|fight|argued|fought)\b`,
      'i'
    ),
  },

  /* P3 — behaviour or mood framed as a problem.
   * If engagement was low, the parent-facing text says LESS, not something
   * negative. The observation belongs in internalFlags and the QA report. */
  {
    rule: 'P3 negative behaviour',
    pattern:
      /\b(distracted|restless|inattentive|uninterested|disengaged|disinterested|unresponsive|lost interest|off[- ]task|did not (want|try|engage|participate)|didn'?t (want|try|engage|participate)|refused|cried|crying|was upset|was frustrated|was bored|seemed (bored|sleepy|tired|upset))\b/i,
  },

  /* P4 — comparison. We measure one child against this session's own
   * objectives. Never a cohort, never a developmental norm. */
  {
    rule: 'P4 comparison',
    pattern:
      /\b(compared (to|with) (other|most|her|his|their) (student|children|child|peer|kid)|than (other|most) (students|children|kids|peers)|(below|above) (the )?average|average for (her|his|their) age|for (her|his|their) age|age[- ]appropriate level|most children (his|her|their) age|typical(ly)? for a \d+[- ]year)\b/i,
  },

  /* P5a — clinical language. Never curriculum vocabulary, so it blocks on
   * sight and needs no child in the sentence. */
  {
    rule: 'P5 clinical language',
    pattern:
      /\b(ADHD|dyslexi\w+|dyscalculi\w+|autis\w+|learning (difficulty|difficulties|disability|disorder)|attention (deficit|disorder)|special needs|diagnos\w+)\b/i,
  },

  /* P5b — deficit framing OF THE CHILD.
   * "a poor choice of loan" and "a business can fail" are the syllabus; "she
   * struggled" and "he was unable to" are judgements about a child. The
   * difference is whether the child is the subject, so the child has to be
   * within a short reach of the word. */
  {
    rule: 'P5 deficit language',
    pattern: new RegExp(
      String.raw`\b${CHILD}\b[^.]{0,50}\b(?:struggl\w+|had (?:trouble|difficulty)|was unable to|is unable to|could not (?:grasp|understand|manage)|cannot (?:yet )?(?:grasp|understand)|falling behind|is behind|needs? (?:a lot of )?improvement|below expectation|did poorly|performed poorly|was weak|weakness)\b` +
        String.raw`|\b(?:struggl\w+|had trouble|falling behind|needs? a lot of improvement|below expectation)\b[^.]{0,50}\b${CHILD}\b`,
      'i'
    ),
  },

  /* P9 — unfilled templates.
   * "the mentor" was here and is the most natural phrase in a session report,
   * and "Not available" was too: both fired on correct text. NOT_AVAILABLE is
   * a legitimate rendered value meaning "we could not measure this", and the
   * renderer already styles it as such. What is left is only ever a template
   * that failed to fill. */
  {
    rule: 'P9 placeholder leak',
    pattern:
      /(\{\{\s*\w+\s*\}\}|\byour mentor\b|\[student\]|\[name\]|\[mentor\]|\bTBD\b|\bundefined\b|\bnull\b|\bStudent's name\b|\bXXX+\b)/i,
  },

  /* P7 — named third parties. Not blocked outright: a creator's name is often
   * the specific detail that makes a report feel observed rather than
   * generated. Flagged as a warning so a human decides. */
  {
    rule: 'P7 named third party (warn)',
    pattern: /\b(her|his|their) (friend|classmate|cousin|neighbour|neighbor) [A-Z][a-z]+/,
  },
];

/** Rules that hold the report versus rules that only warn. */
const WARN_ONLY = new Set(['P7 named third party (warn)']);

export interface SafetyResult {
  blocked: boolean;
  hits: GuardrailHit[];
  warnings: GuardrailHit[];
}

const scan = (fields: Record<string, string | undefined | null>): GuardrailHit[] => {
  const found: GuardrailHit[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    for (const { rule, pattern } of GUARDRAILS) {
      const hit = pattern.exec(value);
      if (hit) found.push({ rule, field, matched: hit[0].slice(0, 60) });
    }
  }
  return found;
};

/**
 * Every string on the report that a parent will read.
 *
 * `topicsNotReached` is included deliberately: it is parent-visible and it is
 * the field most likely to carry an explanation of WHY something was not
 * reached, which is our business and not theirs.
 */
export const parentFacingFields = (report: SessionReport): Record<string, string> => ({
  // NOT student/teacher/sessionTopic. The PDF renders those from the database
  // via ReportContext, never from the report, and parseSessionReport defaults
  // them to NOT_AVAILABLE — so scanning them meant a report with an unnamed
  // field blocked itself on a placeholder rule, over text no parent sees.
  parentSummary: report.parentSummary,
  keyLearningMoment: report.keyLearningMoment,
  questionQuality: report.questionQuality,
  developmentArea: report.developmentArea,
  nextSessionFocus: report.nextSessionFocus,
  parentConnection: report.parentConnection,
  highlight: report.assessment.highlight,
  conceptUnderstandingNote: report.assessment.conceptUnderstandingNote,
  applicationNote: report.assessment.applicationNote,
  financialReasoningNote: report.assessment.financialReasoningNote,
  independenceNote: report.assessment.independenceNote,
  learningGoals: report.learningGoals.join(' \u2022 '),
  topicsCovered: report.topicsCovered.join(' \u2022 '),
  topicsNotReached: report.topicsNotReached.join(' \u2022 '),
});

/** Non-throwing scan, for the admin preview and the QA report. */
export const checkParentSafety = (report: SessionReport): SafetyResult => {
  const all = scan(parentFacingFields(report));
  return {
    hits: all.filter((h) => !WARN_ONLY.has(h.rule)),
    warnings: all.filter((h) => WARN_ONLY.has(h.rule)),
    blocked: all.some((h) => !WARN_ONLY.has(h.rule)),
  };
};

/**
 * The gate. Call immediately before rendering the PDF.
 *
 * Note the exemption: `NOT_AVAILABLE` in the timing and talk-time PANELS is
 * correct and expected — it is how the report says honestly that something
 * could not be measured. What P9 blocks is "Not available" appearing inside a
 * SENTENCE, which is a template that failed to fill. Only narrative fields are
 * scanned, so the panels are safe by construction.
 */
export const assertParentSafe = (report: SessionReport, recordingId: string | null = null): SafetyResult => {
  const result = checkParentSafety(report);
  if (result.blocked) throw new ParentReportBlocked(result.hits, recordingId);
  return result;
};
