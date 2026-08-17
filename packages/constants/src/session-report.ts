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
  meaningfulResponses: number | null;
  independentResponses: number | null;
  promptedResponses: number | null;
  selfCorrections: number | null;
}

export interface LearningAssessment {
  conceptUnderstanding: LearningStatus | null;
  application: LearningStatus | null;
  financialReasoning: LearningStatus | null;
  independence: LearningStatus | null;
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

  /** 15-25 concepts, weighted. Drawn by the PDF, not by the model. */
  wordCloud: WordCloudEntry[];
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
    'teacher student class session question answer tell say said think know'
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
      byNormal.set(normal, { word: word.toUpperCase(), weight });
    }
  }

  return [...byNormal.values()].sort((a, b) => b.weight - a.weight).slice(0, 25);
};

/**
 * Coerce raw model output into a `SessionReport`.
 *
 * Never throws. Every field either holds usable content or a clearly-marked
 * absence, because the alternative — failing the whole report because one count
 * came back as "about 12" — means the parent gets nothing at all.
 */
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

    talkTime: {
      teacher: asString(talk.teacher, NOT_AVAILABLE),
      student: asString(talk.student, NOT_AVAILABLE),
      teacherPercent: asPercent(talk.teacherPercent),
      studentPercent: asPercent(talk.studentPercent),
    },

    interactions: {
      teacherQuestions: asCount(counts.teacherQuestions),
      studentQuestions: asCount(counts.studentQuestions),
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
      highlight: asString(assess.highlight),
    },

    topicsCovered: asStringList(r.topicsCovered, 12),
    topicsNotReached: asStringList(r.topicsNotReached, 12),

    questionQuality: asString(r.questionQuality),
    keyLearningMoment: asString(r.keyLearningMoment),
    parentSummary: asString(r.parentSummary),
    developmentArea: asString(r.developmentArea),
    nextSessionFocus: asString(r.nextSessionFocus),

    wordCloud: asWordCloud(r.wordCloud),
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
    line('Teacher talk', `${report.talkTime.teacher} (${pct(report.talkTime.teacherPercent)})`),
    line('Student talk', `${report.talkTime.student} (${pct(report.talkTime.studentPercent)})`),
    line('Teacher questions', report.interactions.teacherQuestions),
    line('Student questions', report.interactions.studentQuestions),
    line('Meaningful responses', report.interactions.meaningfulResponses),
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
  if (report.wordCloud.length > 0) {
    parts.push('KEY CONCEPTS DISCUSSED', '-'.repeat(50), report.wordCloud.map((w) => w.word).join(' · '), '');
  }

  return parts.join('\n');
};
