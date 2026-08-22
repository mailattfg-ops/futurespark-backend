/**
 * The shape of a post-class Student Session Report.
 *
 * ── Why this is structured data and not a formatted string ──
 * The report specification asks for tables ("SESSION AT A GLANCE", "STUDENT
 * LEARNING"), fixed status values, and — crucially — "an actual visual word
 * cloud". A language model returns text; it cannot draw. So the division of
 * labour is:
 *
 *   Groq  → analyses the recording against the session slides, returns THIS
 *   PDF   → lays out the tables and DRAWS the word cloud from `wordCloud[]`
 *
 * Asking the model for pre-formatted prose and then parsing it back was the
 * previous design, and it degraded exactly as you would expect: a heading the
 * model reworded silently emptied a section of a real parent's report. Data in,
 * layout applied — the format is then identical for every session by
 * construction, which the specification also requires.
 */

// Type-only, so there is no runtime cycle with session-evidence.ts.
import type { AnalysisEnvelope, DerivedMetrics, TalkShare } from './session-evidence';

/** The only three words allowed to describe a child's progress. */
export type LearningStatus = 'Emerging' | 'Developing' | 'Proficient';

export const LEARNING_STATUSES: LearningStatus[] = ['Emerging', 'Developing', 'Proficient'];

/** Written whenever a metric cannot be established from the recording. */
export const NOT_AVAILABLE = 'Not available';

export interface SessionReportTiming {
  /** "4:02 PM", or NOT_AVAILABLE. */
  startTime: string;
  endTime: string;
  /** "59 minutes", or NOT_AVAILABLE. */
  duration: string;
}

export interface TalkTimeSplit {
  /** "25m 40s", or NOT_AVAILABLE. */
  teacher: string;
  student: string;
  /** 0-100. Null when the split could not be established. */
  teacherPercent: number | null;
  studentPercent: number | null;
  /**
   * HOW the split was arrived at. Optional so nothing that reads an older row
   * breaks, but the renderer should print `label` beneath the bars.
   *
   * This exists because the panel was lying by omission. The percentages were
   * a WORD share multiplied by the session duration, printed under the heading
   * "TALK TIME" as though minutes had been measured. An adult explaining runs
   * at ~150 words a minute and a ten-year-old thinking aloud at roughly half
   * that, so a genuine 60/40 split of minutes rendered as 75/25 and made the
   * mentor look worse than they were. 'timestamps' is a measurement;
   * 'word-share' is an estimate and must be captioned as one.
   */
  basis?: 'timestamps' | 'word-share' | 'unmeasurable';
  /** Caption for the panel: "Talk time" | "Share of words spoken". */
  label?: string;
}

/**
 * Counts of what the child actually did.
 *
 * Null rather than 0 when a count could not be established: zero is a claim
 * about the child ("asked no questions") and must never be produced by a
 * failure to measure.
 */
export interface InteractionCounts {
  teacherQuestions: number | null;
  studentQuestions: number | null;
  /**
   * Teacher questions that asked the child to explain, compare, evaluate,
   * predict or apply — a subset of teacherQuestions, never larger than it.
   * Rendered as "9 (35%)" with the percentage computed against teacherQuestions.
   */
  higherOrderQuestions: number | null;
  meaningfulResponses: number | null;
  independentResponses: number | null;
  promptedResponses: number | null;
  selfCorrections: number | null;
}

/**
 * Meaningful answers, counted against the questions that were asked.
 *
 * The analysis counts meaningful RESPONSES, and a child can answer one question
 * across several turns — so the raw number can exceed the question count and
 * once rendered "18 / 9 · 200%", which is not a thing that can happen.
 *
 * The report shows it the way it is read: of the N questions the mentor asked,
 * how many drew a real answer. Capped at N for that reason, so the pair is
 * always sane. The uncapped figures stay in `interactions` for anyone who wants
 * the raw counts.
 */
export const meaningfulOutOfQuestions = (
  interactions: InteractionCounts
): { answered: number; asked: number } | null => {
  const { meaningfulResponses, teacherQuestions } = interactions;
  if (meaningfulResponses === null || teacherQuestions === null || teacherQuestions <= 0) return null;
  return { answered: Math.min(meaningfulResponses, teacherQuestions), asked: teacherQuestions };
};

/** "9 of 10 questions", or null when either side was not measured. */
export const meaningfulOutOfQuestionsLabel = (interactions: InteractionCounts): string | null => {
  const pair = meaningfulOutOfQuestions(interactions);
  return pair ? `${pair.answered} of ${pair.asked} questions` : null;
};

export interface LearningAssessment {
  conceptUnderstanding: LearningStatus | null;
  application: LearningStatus | null;
  financialReasoning: LearningStatus | null;
  independence: LearningStatus | null;
  /**
   * The "Learning snapshot" — one parent-friendly sentence of evidence per
   * area, so the level above is never a bare adjective. Empty string when the
   * transcript gave nothing to say (the renderer then skips the card).
   */
  conceptUnderstandingNote: string;
  applicationNote: string;
  financialReasoningNote: string;
  independenceNote: string;
  /** One short evidence-based observation drawn from the recording. */
  highlight: string;
}

/**
 * One entry in the word cloud.
 *
 * `weight` is relative importance (1-10), NOT raw frequency — the specification
 * is explicit that the cloud should show learning vocabulary rather than the
 * most-spoken words. The renderer maps weight to type size.
 */
export interface WordCloudEntry {
  word: string;
  weight: number;
}

export interface SessionReport {
  student: string;
  teacher: string;
  sessionTopic: string;
  /** "3" — rendered as "Week 3 of 52". */
  weekNumber: number | null;
  weekTotal: number | null;
  date: string;

  timing: SessionReportTiming;
  talkTime: TalkTimeSplit;
  interactions: InteractionCounts;

  /** 2-4 goals, taken from the session slides, in parent-friendly language. */
  learningGoals: string[];

  assessment: LearningAssessment;

  /** Which planned topics were reached, and which were not. */
  topicsCovered: string[];
  topicsNotReached: string[];

  /** The strongest question the child asked, or what their questions showed. */
  questionQuality: string;
  /** One moment of learning, improvement or reasoning. 1-2 sentences. */
  keyLearningMoment: string;
  /** 2-3 sentences for the parent. */
  parentSummary: string;
  /** One constructive area to practise. */
  developmentArea: string;
  /** One specific focus for next time. */
  nextSessionFocus: string;
  /**
   * "Try this at home" — ONE warm, simple conversation prompt a parent can try,
   * grounded in what the session actually covered. Must never read as homework.
   */
  parentConnection: string;

  /** 15-25 concepts, weighted. Drawn by the PDF, not by the model. */
  wordCloud: WordCloudEntry[];

  /**
   * Provenance. Optional, never rendered for the parent, stored on the row.
   *
   * Without it, "the numbers changed between runs" is unfalsifiable — nobody
   * can separate a prompt edit from model drift from a genuine change in the
   * child. With it, two reports sharing a fingerprint MUST match, and if they
   * do not, the provider is non-deterministic and should be pinned or swapped.
   */
  meta?: SessionReportMeta;
}

export interface SessionReportMeta {
  /** PROMPT_SUITE_VERSION at the time of generation. */
  suiteVersion: string;
  /** analysisFingerprint() — the cache key and the audit key. */
  fingerprint: string;
  model: string;
  /** 'full' when the whole recording was read. */
  coverage: 'full' | 'gaps' | 'partial';
  /** How many analysis passes produced this report. 1 = single-shot. */
  passes: number;
  /**
   * Evidence items the model cited that failed validation — a nonexistent turn
   * or the wrong speaker. A high number means the model is padding, and it is
   * the single most useful health signal this pipeline emits.
   */
  discardedEvidence: number;
  /** Populated when the parent-safety scan raised non-blocking warnings. */
  safetyWarnings?: string[];
}

/* ── Validation ───────────────────────────────────────────────────────────
 * Model output is untrusted input. Everything below coerces it into the shape
 * above and drops anything that does not fit, so a malformed field degrades to
 * "Not available" in one cell rather than throwing while a parent waits.
 * ─────────────────────────────────────────────────────────────────────── */

const asString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
};

const asCount = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 10_000) return null;
  return Math.round(n);
};

const asPercent = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n);
};

const asStatus = (value: unknown): LearningStatus | null => {
  const raw = asString(value).toLowerCase();
  const match = LEARNING_STATUSES.find((s) => s.toLowerCase() === raw);
  return match ?? null;
};

const asStringList = (value: unknown, max: number): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asString(entry))
    .filter((entry) => entry.length > 0)
    .slice(0, max);
};

/** Words that must never reach the cloud, however the model weights them. */
const CLOUD_STOPWORDS = new Set(
  (
    'the a an and or but if then so because as of to in on at by for from with about ' +
    'i me my mine you your yours we us our he she they them their this that these those it ' +
    'is am are was were be been have has had do does did can could will would should may might ' +
    'okay ok yeah yes no right good great actually basically maybe really very just like well hmm um uh ' +
    'teacher student class session question answer tell say said think know what how'
  ).split(' ')
);

/** "savings" -> "saving", "decisions" -> "decision". Keeps forms from doubling up. */
const normalizeCloudWord = (word: string): string => {
  const w = word.trim().toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ses') || w.endsWith('xes') || w.endsWith('ches') || w.endsWith('shes')) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
};

const asWordCloud = (value: unknown): WordCloudEntry[] => {
  if (!Array.isArray(value)) return [];

  // Deduplicated on the NORMALISED form so "saving"/"savings" cannot both
  // appear — the specification forbids duplicate word forms, and two sizes of
  // the same word is the most obvious way a generated cloud looks broken.
  const byNormal = new Map<string, WordCloudEntry>();

  for (const raw of value) {
    const word = asString((raw as any)?.word ?? raw);
    if (!word) continue;

    const normal = normalizeCloudWord(word);
    if (normal.length < 3 || CLOUD_STOPWORDS.has(normal)) continue;

    const weightRaw = typeof raw === 'object' && raw !== null ? (raw as any).weight : undefined;
    const weight = Math.min(10, Math.max(1, Math.round(Number(weightRaw) || 5)));

    const existing = byNormal.get(normal);
    if (!existing || weight > existing.weight) {
      // Keep the model's own casing. It was uppercased here once, which
      // destroyed the acronym/word distinction — "EMI" and "unit cost" both
      // became shouting, and the renderer could no longer tell that
      // title-casing one of them ("Emi") is wrong.
      byNormal.set(normal, { word, weight });
    }
  }

  return [...byNormal.values()].sort((a, b) => b.weight - a.weight).slice(0, 25);
};

/**
 * Coerce raw model output into a `SessionReport`.
 *
 * LEGACY as of prompt suite v2. The analysis model no longer returns this
 * shape — it returns an evidence envelope, and `buildSessionReport` below
 * assembles the report from it. This is kept because `GROQ_LEGACY_SUMMARY=true`
 * still routes through the old contract, and because it is the correct reader
 * for report rows written before the migration.
 *
 * Never throws. Every field either holds usable content or a clearly-marked
 * absence, because the alternative — failing the whole report because one count
 * came back as "about 12" — means the parent gets nothing at all.
 */
/**
 * The heading the talk-time rows print under.
 *
 * Derived from the basis rather than stored, so a row written before `label`
 * existed still gets a correct heading, and the two can never disagree.
 * "Talk time" is a measurement; "Share of words spoken" is an estimate and has
 * to say so — an adult speaks at roughly twice a child's rate, so words and
 * minutes are not interchangeable.
 */
export const talkLabelForBasis = (basis: TalkTimeSplit["basis"]): string =>
  basis === "word-share" ? "Share of words spoken" : "Talk time";

export const parseSessionReport = (raw: any, fallbacks: Partial<SessionReport> = {}): SessionReport => {
  const r = raw && typeof raw === 'object' ? raw : {};
  const timing = (r.timing ?? {}) as any;
  const talk = (r.talkTime ?? {}) as any;
  const counts = (r.interactions ?? {}) as any;
  const assess = (r.assessment ?? {}) as any;

  return {
    student: asString(r.student, fallbacks.student ?? NOT_AVAILABLE),
    teacher: asString(r.teacher, fallbacks.teacher ?? NOT_AVAILABLE),
    sessionTopic: asString(r.sessionTopic, fallbacks.sessionTopic ?? NOT_AVAILABLE),
    weekNumber: asCount(r.weekNumber) ?? fallbacks.weekNumber ?? null,
    weekTotal: asCount(r.weekTotal) ?? fallbacks.weekTotal ?? null,
    date: asString(r.date, fallbacks.date ?? NOT_AVAILABLE),

    timing: {
      startTime: asString(timing.startTime, fallbacks.timing?.startTime ?? NOT_AVAILABLE),
      endTime: asString(timing.endTime, fallbacks.timing?.endTime ?? NOT_AVAILABLE),
      duration: asString(timing.duration, fallbacks.timing?.duration ?? NOT_AVAILABLE),
    },

    talkTime: (() => {
      const basis: TalkTimeSplit["basis"] =
        talk.basis === 'timestamps' || talk.basis === 'word-share' ? talk.basis : 'unmeasurable';
      return {
      teacher: asString(talk.teacher, NOT_AVAILABLE),
      student: asString(talk.student, NOT_AVAILABLE),
      teacherPercent: asPercent(talk.teacherPercent),
      studentPercent: asPercent(talk.studentPercent),
      basis,
      // Never NOT_AVAILABLE: this is the heading for the talk-time rows, and
      // defaulting it to "Not available" printed "Teacher not available: 25m
      // 40s (60%)" for every row stored before `label` existed. Absent means
      // "derive it from the basis", not "unknown".
      label: asString(talk.label, "") || talkLabelForBasis(basis),
      };
    })(),

    interactions: {
      teacherQuestions: asCount(counts.teacherQuestions),
      studentQuestions: asCount(counts.studentQuestions),
      // Clamped to teacherQuestions: it is a subset by definition, and a model
      // that returns 12-of-9 would otherwise print an impossible percentage.
      higherOrderQuestions: (() => {
        const higher = asCount(counts.higherOrderQuestions);
        const total = asCount(counts.teacherQuestions);
        if (higher === null) return null;
        return total !== null && higher > total ? total : higher;
      })(),
      meaningfulResponses: asCount(counts.meaningfulResponses),
      independentResponses: asCount(counts.independentResponses),
      promptedResponses: asCount(counts.promptedResponses),
      selfCorrections: asCount(counts.selfCorrections),
    },

    learningGoals: asStringList(r.learningGoals, 4),

    assessment: {
      conceptUnderstanding: asStatus(assess.conceptUnderstanding),
      application: asStatus(assess.application),
      financialReasoning: asStatus(assess.financialReasoning),
      independence: asStatus(assess.independence),
      conceptUnderstandingNote: asString(assess.conceptUnderstandingNote),
      applicationNote: asString(assess.applicationNote),
      financialReasoningNote: asString(assess.financialReasoningNote),
      independenceNote: asString(assess.independenceNote),
      highlight: asString(assess.highlight),
    },

    topicsCovered: asStringList(r.topicsCovered, 12),
    topicsNotReached: asStringList(r.topicsNotReached, 12),

    questionQuality: asString(r.questionQuality),
    keyLearningMoment: asString(r.keyLearningMoment),
    parentSummary: asString(r.parentSummary),
    developmentArea: asString(r.developmentArea),
    nextSessionFocus: asString(r.nextSessionFocus),
    parentConnection: asString(r.parentConnection),

    wordCloud: asWordCloud(r.wordCloud),

    /* Provenance survives the round-trip.
     *
     * Without this the field was write-only: stored on the row, discarded the
     * moment anything read it back, so "these two runs should be identical"
     * could never actually be checked. Absent on rows written before v2, and
     * on anything that genuinely has none — hence undefined rather than a
     * fabricated default. */
    meta: (() => {
      const m = (r as any)?.meta;
      if (!m || typeof m !== 'object') return undefined;
      const coverage = m.coverage === 'gaps' || m.coverage === 'partial' ? m.coverage : 'full';
      return {
        suiteVersion: asString(m.suiteVersion),
        fingerprint: asString(m.fingerprint),
        model: asString(m.model),
        coverage,
        passes: Number.isFinite(Number(m.passes)) ? Number(m.passes) : 1,
        discardedEvidence: Number.isFinite(Number(m.discardedEvidence)) ? Number(m.discardedEvidence) : 0,
        ...(Array.isArray(m.safetyWarnings) && m.safetyWarnings.length > 0
          ? { safetyWarnings: m.safetyWarnings.map((w: unknown) => asString(w)).filter(Boolean) }
          : {}),
      };
    })(),
  };
};

/**
 * A plain-text rendering of the report.
 *
 * The PDF is the real deliverable, but `ScheduledClass.classSummary` is a text
 * column that the admin recording modal and the student portal both display, and
 * every row written before this change holds prose. This keeps those readers
 * working without them needing to know about the structure.
 */
export const sessionReportToText = (report: SessionReport): string => {
  const line = (label: string, value: string | number | null) =>
    `- ${label}: ${value === null || value === '' ? NOT_AVAILABLE : value}`;

  const pct = (v: number | null) => (v === null ? NOT_AVAILABLE : `${v}%`);
  const talkValue = (time: string, percent: number | null): string => {
    const hasTime = time && time !== NOT_AVAILABLE;
    if (hasTime && percent !== null) return `${time} (${percent}%)`;
    if (hasTime) return time;
    return pct(percent);
  };

  const parts: string[] = [
    'STUDENT SESSION REPORT',
    '='.repeat(50),
    '',
    line('Student', report.student),
    line('Teacher', report.teacher),
    line('Session', report.sessionTopic),
    line('Week', report.weekNumber ? `${report.weekNumber}${report.weekTotal ? ` of ${report.weekTotal}` : ''}` : null),
    line('Date', report.date),
    '',
    'SESSION AT A GLANCE',
    '-'.repeat(50),
    line('Start', report.timing.startTime),
    line('End', report.timing.endTime),
    line('Duration', report.timing.duration),
    /* On a word-share basis the PERCENTAGE is known but the minutes are not,
     * and gluing the two together printed "Not available (82%)" — which reads
     * as a broken report rather than as an estimate. Show whichever half is
     * actually known. */
    line(`Teacher ${(report.talkTime.label ?? 'talk').toLowerCase()}`, talkValue(report.talkTime.teacher, report.talkTime.teacherPercent)),
    line(`Student ${(report.talkTime.label ?? 'talk').toLowerCase()}`, talkValue(report.talkTime.student, report.talkTime.studentPercent)),
    line('Teacher questions', report.interactions.teacherQuestions),
    line('Student questions', report.interactions.studentQuestions),
    line('Higher-order questions', report.interactions.higherOrderQuestions),
    line('Meaningful responses', meaningfulOutOfQuestionsLabel(report.interactions)),
    line('Independent responses', report.interactions.independentResponses),
    line('Prompted responses', report.interactions.promptedResponses),
    '',
  ];

  if (report.learningGoals.length > 0) {
    parts.push("TODAY'S LEARNING GOALS", '-'.repeat(50), ...report.learningGoals.map((g) => `- ${g}`), '');
  }

  parts.push(
    'STUDENT LEARNING',
    '-'.repeat(50),
    line('Concept understanding', report.assessment.conceptUnderstanding),
    line('Application', report.assessment.application),
    line('Financial reasoning', report.assessment.financialReasoning),
    line('Independence', report.assessment.independence),
    ''
  );

  const notes: Array<[string, string]> = [
    ['What was understood', report.assessment.conceptUnderstandingNote],
    ['Applied to real life', report.assessment.applicationNote],
    ['Money reasoning', report.assessment.financialReasoningNote],
    ['Working independently', report.assessment.independenceNote],
  ].filter(([, note]) => note.length > 0) as Array<[string, string]>;
  if (notes.length > 0) {
    parts.push('LEARNING SNAPSHOT', '-'.repeat(50), ...notes.map(([label, note]) => `- ${label}: ${note}`), '');
  }

  if (report.assessment.highlight) parts.push('Learning highlight:', report.assessment.highlight, '');
  if (report.topicsCovered.length > 0) {
    parts.push('TOPICS COVERED', '-'.repeat(50), ...report.topicsCovered.map((t) => `- ${t}`), '');
  }
  if (report.topicsNotReached.length > 0) {
    parts.push('NOT REACHED THIS SESSION', '-'.repeat(50), ...report.topicsNotReached.map((t) => `- ${t}`), '');
  }
  if (report.keyLearningMoment) parts.push('KEY LEARNING MOMENT', '-'.repeat(50), report.keyLearningMoment, '');
  if (report.parentSummary) parts.push('SESSION INSIGHT', '-'.repeat(50), report.parentSummary, '');
  if (report.developmentArea) parts.push('NEXT DEVELOPMENT AREA', '-'.repeat(50), report.developmentArea, '');
  if (report.nextSessionFocus) parts.push('NEXT SESSION FOCUS', '-'.repeat(50), report.nextSessionFocus, '');
  if (report.parentConnection) parts.push('TRY THIS AT HOME', '-'.repeat(50), report.parentConnection, '');
  if (report.wordCloud.length > 0) {
    // Renamed with the content: these are the words most used in the session,
    // counted from the transcript, not a list of concepts off the deck.
    parts.push('WORDS FROM THE SESSION', '-'.repeat(50), report.wordCloud.map((w) => w.word).join(' · '), '');
  }

  return parts.join('\n');
};


/* ── v2 assembly ───────────────────────────────────────────────────────────
 * The model returns evidence and prose; everything countable is computed in
 * session-evidence.ts; the system already knows the names, dates and times.
 * This is where those three sources meet.
 *
 * Type-only imports, so there is no runtime cycle with session-evidence.ts.
 * ─────────────────────────────────────────────────────────────────────── */


export interface ReportAssemblyContext {
  student: string;
  teacher: string;
  sessionTopic: string;
  weekNumber: number | null;
  weekTotal: number | null;
  date: string;
  timing: SessionReportTiming;
  /** mm ss strings for the talk-time bars, when a duration was known. */
  talkTimeTeacher?: string;
  talkTimeStudent?: string;
  meta: SessionReportMeta;
}

/**
 * Assemble the final report.
 *
 * The division of labour, made explicit:
 *   - `ctx`      — facts the system holds. Names, dates, clock times.
 *   - `derived`  — every count, band and cloud weight, computed from evidence.
 *   - `envelope` — narrative only. The model's actual job.
 *
 * A narrative field the model left empty stays empty. That is deliberate: the
 * renderer skips an empty card, and a skipped card is invisible to a parent
 * while a hollow sentence ("The student engaged with the material") is not.
 */
export const buildSessionReport = (
  envelope: AnalysisEnvelope,
  derived: DerivedMetrics,
  talk: TalkShare,
  ctx: ReportAssemblyContext
): SessionReport => {
  const n = envelope.narrative;

  return {
    student: ctx.student || NOT_AVAILABLE,
    teacher: ctx.teacher || NOT_AVAILABLE,
    sessionTopic: ctx.sessionTopic || NOT_AVAILABLE,
    weekNumber: ctx.weekNumber,
    weekTotal: ctx.weekTotal,
    date: ctx.date || NOT_AVAILABLE,

    timing: ctx.timing,

    talkTime: {
      teacher: ctx.talkTimeTeacher ?? NOT_AVAILABLE,
      student: ctx.talkTimeStudent ?? NOT_AVAILABLE,
      teacherPercent: talk.teacherPercent,
      studentPercent: talk.studentPercent,
      basis: talk.basis,
      label: talk.label,
    },

    interactions: derived.interactions,

    learningGoals: n.learningGoals.slice(0, 4),

    assessment: {
      conceptUnderstanding: derived.statuses.conceptUnderstanding,
      application: derived.statuses.application,
      financialReasoning: derived.statuses.financialReasoning,
      independence: derived.statuses.independence,
      // A note is only shown when the area was actually rated. Printing warm
      // evidence beside a blank level reads as an omission; printing a level
      // with no evidence reads as an assertion. Both together, or neither.
      conceptUnderstandingNote: derived.statuses.conceptUnderstanding ? n.conceptUnderstandingNote : '',
      applicationNote: derived.statuses.application ? n.applicationNote : '',
      financialReasoningNote: derived.statuses.financialReasoning ? n.financialReasoningNote : '',
      independenceNote: derived.statuses.independence ? n.independenceNote : '',
      highlight: n.highlight,
    },

    topicsCovered: n.topicsCovered.slice(0, 12),
    topicsNotReached: n.topicsNotReached.slice(0, 12),

    questionQuality: n.questionQuality,
    keyLearningMoment: n.keyLearningMoment,
    parentSummary: n.parentSummary,
    developmentArea: n.developmentArea,
    nextSessionFocus: n.nextSessionFocus,
    parentConnection: n.parentConnection,

    wordCloud: derived.wordCloud,

    meta: ctx.meta,
  };
};
