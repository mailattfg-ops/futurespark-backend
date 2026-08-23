import { NOT_AVAILABLE, meaningfulOutOfQuestions, type SessionReport } from '@futurespark/constants';
import { toPdfSafeText } from './summary-parser';
import type { ActivityItem, CloudWord, ReportDocument, TopicChip } from './report-design';

/**
 * Assembles the document the report is drawn from.
 *
 * Two sources meet here and they are deliberately kept apart:
 *
 *   - The CURRICULUM decides what the session was: its title, its arc, the
 *     topic map, the outcomes it teaches and the activities it runs. Identical
 *     for every child on that session, and authored by a person.
 *   - The ANALYSIS decides what happened in this particular class: who talked,
 *     how many questions were asked and answered with reasoning, what stood
 *     out, and which words came up. Different for every child, and derived
 *     from the recording.
 *
 * Where the curriculum has not been filled in yet, the analysis stands in so
 * the page is never blank — but the curriculum always wins when it is there,
 * because a fixed section that changes wording every week reads to a parent as
 * inconsistency rather than as progress.
 */

/** Curriculum and scheduling facts the renderer needs but the analysis has no view of. */
export interface ReportCurriculum {
  sessionTotal?: number | null;
  /** Programme name — becomes "Banking Arc" in the line under the title. */
  arcName?: string | null;
  /** One line on what the arc covers. */
  arcDescription?: string | null;
  /** The hub of the topic map. Falls back to the arc name. */
  topicHub?: string | null;
  topics?: string[];
  learningOutcomes?: string[];
  inSession?: ActivityItem[];
  takeHome?: ActivityItem[];
  /** The student's talk share across recent sessions, oldest first. */
  shareHistory?: Array<{ percent: number; basis: string }>;
  nextSessionNumber?: number | null;
  nextSessionTitle?: string | null;
  nextSessionWhen?: string | null;
  rescheduleUrl?: string | null;
  /**
   * Whether the curriculum has a session after this one.
   *
   * `false` means this was the last one — a different message entirely from
   * `null`, which only means we could not tell.
   */
  nextSessionExists?: boolean | null;
}

const clean = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const text = toPdfSafeText(String(value)).trim();
  if (!text) return null;
  // The analysis writes this sentinel when it could not establish something.
  // Printing it to a parent would be worse than leaving the line out.
  if (text === NOT_AVAILABLE || text.toLowerCase().startsWith('not available')) return null;
  return text;
};

const cleanList = (values: Array<string | null | undefined> | undefined): string[] =>
  (values ?? []).map(clean).filter(Boolean) as string[];

/**
 * The three things worth telling a parent went well.
 *
 * Drawn from the analysis in descending order of how specific they are: the
 * moment something clicked, the mentor's own highlight, then the shape of the
 * child's answers. Anything the analysis could not establish drops out rather
 * than being padded.
 */
const buildHighlights = (report: SessionReport | null): string[] => {
  if (!report) return [];
  return cleanList([
    report.keyLearningMoment,
    report.assessment?.highlight,
    report.questionQuality,
  ]).slice(0, 3);
};

const buildWordCloud = (report: SessionReport | null): CloudWord[] => {
  if (!report?.wordCloud?.length) return [];
  return report.wordCloud
    .map((entry) => ({ word: clean(entry.word) ?? '', weight: Number(entry.weight) || 1 }))
    .filter((entry) => entry.word.length > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 24);
};

/**
 * The outcomes this session teaches, curriculum first.
 *
 * Exported because the PDF and the WhatsApp message must show the SAME three
 * lines. A parent reads the message on their phone and opens the attachment
 * underneath it; two different lists in the same breath reads as carelessness.
 */
export const resolveLearningOutcomes = (
  curriculum: ReportCurriculum,
  report: SessionReport | null
): string[] => {
  const authored = cleanList(curriculum.learningOutcomes);
  return (authored.length ? authored : cleanList(report?.learningGoals)).slice(0, 5);
};

export interface DocumentInputs {
  studentName: string;
  mentorName: string;
  sessionNumber: number | null;
  sessionTitle: string;
  dateLabel: string;
  timeLabel: string;
  durationLabel: string;
  brandName: string;
}

export const buildReportDocument = (
  base: DocumentInputs,
  report: SessionReport | null,
  curriculum: ReportCurriculum = {}
): ReportDocument => {
  const talk = report?.talkTime;
  const measured = Boolean(talk && talk.basis !== 'unmeasurable' && talk.studentPercent !== null);

  /* EVERY measured session is plotted — a child's second report must show two
   * points, their third three. Dropping readings measured a different way left
   * a two-session child with a chart captioned "first session", which is worse
   * than an imperfect axis: it tells a parent something plainly untrue.
   *
   * The real harm of mixing was never the line, it was the DELTA. Timestamps
   * measure minutes, word-share counts words, and an adult speaks about twice
   * as fast as a child — so a genuine 60/40 of minutes reads as roughly 75/25
   * in words. Differencing across that change printed a large invented drop
   * next to the child's name. So: plot everything, compare only like with
   * like. */
  const readings = (curriculum.shareHistory ?? []).filter((h) => h && Number.isFinite(h.percent));
  const gathered = readings.map((h) => h.percent);

  /* True when the series was not all measured the same way. The chart says so
   * rather than implying every point is directly comparable. */
  const bases = new Set(readings.map((h) => h.basis));
  const mixedBasis = bases.size > 1;
  /* This session's own reading is the last point on the chart.
   *
   * It normally arrives with the history, since that query includes the class
   * being reported on. The fallback covers a first session whose analysis was
   * written after the history was read — without it the very report that
   * measured a share would be the one plotting nothing. */
  const history =
    gathered.length === 0 && measured && talk!.studentPercent !== null
      ? [talk!.studentPercent]
      : gathered;
  /* The delta is only honest against a real previous reading measured the SAME
   * way. Across a change of basis the difference is an artefact of the method,
   * not a change in the child, so no number is shown at all. */
  const lastTwoComparable =
    readings.length >= 2 &&
    readings[readings.length - 1].basis === readings[readings.length - 2].basis;

  const shareDelta =
    history.length >= 2 && (readings.length < 2 || lastTwoComparable)
      ? Math.round(history[history.length - 1] - history[history.length - 2])
      : null;

  /* Meaningful answers, out of the questions asked.
   *
   * Shown the way it is read: of the N questions the mentor asked, how many
   * drew a real answer. The analysis counts meaningful RESPONSES, which can
   * exceed N because one question often draws several answers — so the pair is
   * capped, and the same helper feeds the text summary so the two documents
   * cannot disagree. */
  const answered = report ? meaningfulOutOfQuestions(report.interactions) : null;

  const arcName = clean(curriculum.arcName);
  const arcDescription = clean(curriculum.arcDescription);
  const arcLine =
    arcName && arcDescription ? `${arcName} · ${arcDescription}` : arcName ?? arcDescription;

  // Curriculum first, analysis second — see the note at the top of this file.
  const curriculumTopics = cleanList(curriculum.topics);
  const observedTopics = cleanList(report?.topicsCovered);
  const topics: TopicChip[] = (curriculumTopics.length ? curriculumTopics : observedTopics)
    .slice(0, 8)
    .map((label) => ({ label }));

  const learningOutcomes = resolveLearningOutcomes(curriculum, report);

  const sanitiseActivities = (items: ActivityItem[] | undefined): ActivityItem[] =>
    (items ?? [])
      .map((item) => ({ label: clean(item.label) ?? '', done: Boolean(item.done) }))
      .filter((item) => item.label.length > 0)
      .slice(0, 3);

  return {
    studentName: clean(base.studentName) ?? 'Your child',
    mentorName: clean(base.mentorName) ?? 'Your mentor',
    sessionNumber: base.sessionNumber,
    sessionTotal: curriculum.sessionTotal ?? null,
    sessionTitle: clean(base.sessionTitle) ?? 'Class session',
    arcLine,
    dateLabel: clean(base.dateLabel) ?? '',
    timeLabel: clean(base.timeLabel) ?? '',
    durationLabel: clean(base.durationLabel) ?? '',

    studentPercent: measured ? talk!.studentPercent : null,
    mentorPercent: measured ? talk!.teacherPercent : null,
    studentTime: measured ? clean(talk!.student) ?? '' : '',
    mentorTime: measured ? clean(talk!.teacher) ?? '' : '',
    shareDelta,
    shareHistory: history,
    /* Not every point on the chart was measured the same way. */
    shareHistoryMixedBasis: mixedBasis,
    talkMeasured: measured,
    questionsAsked: report?.interactions?.teacherQuestions ?? null,
    meaningfulAnswers: answered ? answered.answered : null,
    answersOutOf: answered ? answered.asked : null,
    highlights: buildHighlights(report),
    wordCloud: buildWordCloud(report),

    topicHub: clean(curriculum.topicHub) ?? arcName,
    topics,
    learningOutcomes,
    inSession: sanitiseActivities(curriculum.inSession),
    takeHome: sanitiseActivities(curriculum.takeHome),

    nextSessionNumber: curriculum.nextSessionNumber ?? null,
    /* The curriculum's title only — never the analysis's "next session focus".
     *
     * That field is a sentence ("Practicing with policy terms like premiums,
     * deductibles, and claims through interactive plan comparison"), and set as
     * a title it ran straight off the edge of the footer band and under the
     * reschedule box. A heading needs a name. */
    nextSessionTitle: clean(curriculum.nextSessionTitle),
    nextSessionWhen: clean(curriculum.nextSessionWhen),
    isFinalSession: curriculum.nextSessionExists === false,
    programmeName: arcName,
    rescheduleUrl: clean(curriculum.rescheduleUrl),

    brandName: clean(base.brandName) ?? 'Finquo Junior',
    footerNote: 'AUTO-GENERATED FROM SESSION RECORDING · REVIEWED BY MENTOR BEFORE SENDING',
  };
};
