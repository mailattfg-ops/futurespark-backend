import { logger } from '@futurespark/logger';
import {
  effectiveSessionActivities,
  effectiveSessionTopics,
  parseSessionReport,
  type SessionTopic,
} from '@futurespark/constants';
import db from '../../database/datasource';
import type { ReportCurriculum } from './report-document';

/**
 * Everything the report shows that the recording cannot tell us.
 *
 * The arc, the topic map, the outcomes and the activities are authored once per
 * session and are the same for every child who sits it. What comes next and how
 * the child's share of the talking has moved are read from the schedule and
 * from previous classes.
 *
 * Nothing here is allowed to fail the report: a missing programme, an
 * un-authored session or a database hiccup returns whatever was gathered so
 * far, and the renderer falls back to what the analysis observed. A parent
 * waiting on a report should never be told there isn't one because a topic map
 * was blank.
 */

/** How many previous sessions the talk-share sparkline reaches back over. */
const HISTORY_WINDOW = 6;

/** The mind map flattened into the chips the design draws along the spine. */
const topicLabels = (topics: SessionTopic[]): { hub: string | null; labels: string[] } => {
  if (topics.length === 0) return { hub: null, labels: [] };

  // A single root with children is the shape the design was drawn for: the root
  // becomes the hub and its children the threads. A flat list has no natural
  // hub, so the programme name stands in and every node becomes a thread.
  if (topics.length === 1 && topics[0].children?.length) {
    return { hub: topics[0].title, labels: topics[0].children.map((c) => c.title) };
  }
  return { hub: null, labels: topics.map((t) => t.title) };
};

const studentShareOf = (metrics: unknown): number | null => {
  if (!metrics || typeof metrics !== 'object') return null;
  const raw = (metrics as any).report;
  if (!raw || typeof raw !== 'object') return null;
  try {
    const report = parseSessionReport(raw);
    const talk = report.talkTime;
    if (!talk || talk.basis === 'unmeasurable') return null;
    return typeof talk.studentPercent === 'number' ? talk.studentPercent : null;
  } catch {
    return null;
  }
};

export interface CurriculumLookup {
  classId: string;
  studentId: string | null;
  programId: string | null;
  sessionId: string | null;
  startTime: Date;
  /** Formats a moment the way the family reads it. */
  formatWhen: (at: Date) => string;
}

export const gatherCurriculum = async (input: CurriculumLookup): Promise<ReportCurriculum> => {
  const out: ReportCurriculum = {};

  try {
    const [program, session, sessionCount] = await Promise.all([
      input.programId
        ? db.program.findUnique({
            where: { id: input.programId },
            select: { title: true, description: true },
          })
        : Promise.resolve(null),
      input.sessionId
        ? db.session.findUnique({
            where: { id: input.sessionId },
            select: {
              title: true,
              order: true,
              topics: true,
              learningOutcomes: true,
              activities: true,
              programId: true,
            },
          })
        : Promise.resolve(null),
      input.programId
        ? db.session.count({ where: { programId: input.programId } })
        : Promise.resolve(0),
    ]);

    out.arcName = program?.title ?? null;
    out.arcDescription = program?.description ?? null;
    out.sessionTotal = sessionCount > 0 ? sessionCount : null;

    if (session) {
      const { hub, labels } = topicLabels(effectiveSessionTopics(session.topics));
      out.topicHub = hub ?? program?.title ?? null;
      out.topics = labels;
      out.learningOutcomes = session.learningOutcomes ?? [];

      const activities = effectiveSessionActivities(session.activities);
      // In-session work is marked done because the class ran; take-home work is
      // by definition still ahead of the child when the report is sent.
      out.inSession = activities.inSession.map((a) => ({ label: a.label, done: true }));
      out.takeHome = activities.takeHome.map((a) => ({ label: a.label, done: false }));

      /* What comes next: the following session in the curriculum, and the date
       * it is actually booked for if one is on the calendar. */
      if (session.programId && typeof session.order === 'number') {
        const next = await db.session.findFirst({
          where: { programId: session.programId, order: { gt: session.order } },
          orderBy: { order: 'asc' },
          select: { title: true, order: true },
        });
        if (next) {
          out.nextSessionNumber = next.order;
          out.nextSessionTitle = next.title;
        }
      }
    }

    if (input.studentId) {
      const nextClass = await db.scheduledClass.findFirst({
        where: {
          studentId: input.studentId,
          startTime: { gt: input.startTime },
          status: { notIn: ['CANCELLED'] },
        },
        orderBy: { startTime: 'asc' },
        select: { startTime: true },
      });
      if (nextClass) out.nextSessionWhen = input.formatWhen(nextClass.startTime);

      /* The talk-share trend.
       *
       * Read from previous classes' own stored analyses rather than recomputed,
       * so the sparkline and each week's report always agree. Sessions whose
       * split could not be measured are skipped rather than plotted as zero —
       * a dip to nothing would read as a child who stopped speaking. */
      const previous = await db.scheduledClass.findMany({
        where: {
          studentId: input.studentId,
          startTime: { lte: input.startTime },
          status: 'COMPLETED',
        },
        orderBy: { startTime: 'desc' },
        take: HISTORY_WINDOW,
        select: { id: true, interactionMetrics: true },
      });

      const history = previous
        .reverse()
        .map((c) => studentShareOf(c.interactionMetrics))
        .filter((v): v is number => v !== null);

      if (history.length >= 2) out.shareHistory = history;
    }

    const base = process.env.REPORT_RESCHEDULE_URL;
    if (base) {
      out.rescheduleUrl = `${base.replace(/\/+$/, '')}/${input.classId.slice(0, 8).toUpperCase()}`;
    }
  } catch (err: any) {
    // Partial curriculum is fine; no report is not.
    logger.warn(
      `[ReportCurriculum] Could not gather all curriculum content for class ${input.classId}: ${err.message}. ` +
        'The report falls back to what the analysis observed.'
    );
  }

  return out;
};
