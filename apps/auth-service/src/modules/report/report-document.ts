import { NOT_AVAILABLE, type SessionReport } from '@futurespark/constants';
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
  shareHistory?: number[];
  nextSessionNumber?: number | null;
  nextSessionTitle?: string | null;
  nextSessionWhen?: string | null;
  rescheduleUrl?: string | null;
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

  const gathered = (curriculum.shareHistory ?? []).filter((n) => Number.isFinite(n));
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
  // The delta is only honest against a real previous reading.
  const shareDelta =
    history.length >= 2
      ? Math.round(history[history.length - 1] - history[history.length - 2])
      : null;

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
    talkMeasured: measured,
    questionsAsked: report?.interactions?.teacherQuestions ?? null,
    meaningfulAnswers: report?.interactions?.meaningfulResponses ?? null,
    highlights: buildHighlights(report),
    wordCloud: buildWordCloud(report),

    topicHub: clean(curriculum.topicHub) ?? arcName,
    topics,
    learningOutcomes,
    inSession: sanitiseActivities(curriculum.inSession),
    takeHome: sanitiseActivities(curriculum.takeHome),

    nextSessionNumber: curriculum.nextSessionNumber ?? null,
    nextSessionTitle: clean(curriculum.nextSessionTitle) ?? clean(report?.nextSessionFocus),
    nextSessionWhen: clean(curriculum.nextSessionWhen),
    rescheduleUrl: clean(curriculum.rescheduleUrl),

    brandName: clean(base.brandName) ?? 'Finquo Junior',
    footerNote: 'AUTO-GENERATED FROM SESSION RECORDING · REVIEWED BY MENTOR BEFORE SENDING',
  };
};
