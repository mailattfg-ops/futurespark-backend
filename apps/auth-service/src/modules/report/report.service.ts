import fs from 'fs';
import path from 'path';
import { logger } from '@futurespark/logger';
import { parseSessionReport, type SessionReport } from '@futurespark/constants';
import { S3Storage } from '@futurespark/storage';
import db from '../../database/datasource';
import { renderSessionReportPdf, type ReportContext } from './report-pdf';
import { gatherCurriculum } from './report-curriculum';
import { resolveLearningOutcomes } from './report-document';
import { truncate } from './summary-parser';

/**
 * The parent-facing session report: summary in, PDF out, WhatsApp sent.
 *
 * Everything here is driven off `ScheduledClass.classSummary`, which the
 * recording pipeline writes once Groq has transcribed and summarised the class.
 * No summary means no report — a message telling a parent their child's report
 * is ready, attached to a document that says nothing, is worse than silence.
 */

const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://localhost:3003';
const REPORTS_DIR = path.resolve(__dirname, '../../../../downloads/reports');

/** Beyond this many failed sends a class is parked for a human to look at. */
export const MAX_REPORT_ATTEMPTS = Number(process.env.REPORT_MAX_ATTEMPTS ?? 5);

/** Failures that will never succeed on a retry, however many times it runs. */
const TERMINAL_FAILURES = new Set([
  'NO_PHONE_NUMBER',
  'INVALID_RECIPIENT',
  'TEMPLATE_NOT_CONFIGURED',
  'TEMPLATE_MISCONFIGURED',
  'NOT_IN_ALLOWLIST',
  'NUMBER_NOT_REGISTERED',
  'UNDELIVERABLE',
]);

export interface SendReportOutcome {
  classId: string;
  sent: boolean;
  /** True when the PDF itself reached the parent, not just the message text. */
  documentDelivered?: boolean;
  skippedReason?: string;
  failureKind?: string;
  error?: string;
}

/** Everything one report needs, in one query. */
const CLASS_FOR_REPORT = {
  student: {
    include: {
      parentAccount: {
        include: { profiles: { orderBy: { createdAt: 'asc' as const } } },
      },
    },
  },
  mentor: { select: { id: true, firstName: true, lastName: true } },
};

const fullName = (first?: string | null, last?: string | null): string =>
  [first, last].filter(Boolean).join(' ').trim();

/**
 * Pull the structured Student Session Report out of `interactionMetrics`.
 *
 * It rides in that existing Json column rather than in a new one: the column
 * already held the word-count metrics, learning-service now writes the report
 * alongside them under `.report`, and nothing that read the old shape breaks.
 * Re-validated on the way out because it is JSON from the database — the row
 * may predate the format, or have been written by an older service.
 */
const extractStoredReport = (metrics: unknown): SessionReport | null => {
  if (!metrics || typeof metrics !== 'object') return null;
  const raw = (metrics as any).report;
  if (!raw || typeof raw !== 'object') return null;

  const report = parseSessionReport(raw);
  // A report with no goals, no assessment and no cloud is an empty husk — most
  // likely a half-written row. Fall back to the prose layout rather than
  // rendering a page of "Not available".
  const hasContent =
    report.learningGoals.length > 0 ||
    report.wordCloud.length > 0 ||
    report.parentSummary.length > 0 ||
    Boolean(report.assessment.conceptUnderstanding);

  return hasContent ? report : null;
};

/** 1 -> "1st", 13 -> "13th", 22 -> "22nd". */
const ordinal = (day: number): string => {
  // 11th/12th/13th are the exception the naive `% 10` rule gets wrong.
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
};

/**
 * Format the class time in the CHILD's timezone, not the server's.
 *
 * The server runs in UTC on AWS. A 19:30 IST class printed off a raw Date reads
 * as 14:00 on the report a parent in Chennai opens, which makes the whole
 * document look wrong even when every other word in it is right.
 *
 * Two date formats, deliberately:
 *   `long`  — "13th August 2026", matching the sample in the APPROVED WhatsApp
 *             template. The message a parent reads should look exactly like the
 *             one that was approved.
 *   `short` — "Thu, 13 Aug 2026", for the PDF's fact strip, where the weekday is
 *             useful and the column is narrow.
 */
const formatInTimezone = (
  at: Date,
  timezone: string
): { date: string; dateLong: string; time: string } => {
  const requested = timezone && timezone.trim().length > 0 ? timezone : 'Asia/Kolkata';

  const build = (tz: string, suffix = '') => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).formatToParts(at);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const day = Number.parseInt(part('day'), 10);

    return {
      date: new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(at),
      dateLong: Number.isFinite(day)
        ? `${ordinal(day)} ${part('month')} ${part('year')}`
        : new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(at),
      time:
        new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(at) +
        suffix,
    };
  };

  try {
    return build(requested);
  } catch {
    // An invalid IANA name throws rather than falling back, and it must not take
    // the whole report down with it.
    logger.warn(`[Report] Unknown timezone "${timezone}" — formatting the report in UTC instead.`);
    return build('UTC', ' UTC');
  }
};

const durationLabel = (start: Date, end: Date): string | null => {
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 8 * 60) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
};

/** Keep the rendered PDF, so the admin can re-download exactly what was sent. */
const persistPdf = async (classId: string, fileName: string, buffer: Buffer): Promise<string | null> => {
  const key = `reports/${classId}/${fileName}`;

  if (S3Storage.isS3Enabled()) {
    try {
      await S3Storage.uploadBuffer(buffer, key, 'application/pdf');
      return key;
    } catch (err: any) {
      logger.warn(`[Report] Could not upload the report PDF to S3: ${err.message}. Falling back to local disk.`);
    }
  }

  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const localPath = path.join(REPORTS_DIR, `${classId}_${fileName}`);
    fs.writeFileSync(localPath, buffer);
    return localPath;
  } catch (err: any) {
    // Not fatal. Persisting is a convenience; the PDF is regenerable from
    // classSummary at any time, so the send goes ahead regardless.
    logger.warn(`[Report] Could not save the report PDF locally: ${err.message}. Sending it anyway.`);
    return null;
  }
};

export const reportService = {
  /**
   * Build and send one class's report to the parent.
   *
   * `force` bypasses the "already sent" latch for the admin re-send button. It
   * does NOT bypass the missing-summary check: there is nothing to re-send when
   * no summary was ever produced.
   */
  async sendClassReport(classId: string, options: { force?: boolean; customPhone?: string } = {}): Promise<SendReportOutcome> {
    /* ── Demo classes never message the family ────────────────────────────
     *
     * A demo family has not enrolled: nobody consented to WhatsApp messages,
     * and the pilot flow contacts them through the advisor, not through an
     * automated template. The guard sits HERE, on the one method every send
     * path shares — the cron and the dashboard button both land in it, and
     * `force` deliberately does not bypass it. Preview is unaffected:
     * renderClassReport sends nothing, and reading a demo's report before a
     * follow-up call is exactly what an advisor wants. */
    const classType = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: { classType: true, studentId: true, leadId: true },
    });
    if (classType && (classType.classType === 'DEMO' || (!classType.studentId && !!classType.leadId))) {
      logger.info(`[Report] Class ${classId} is a demo — WhatsApp to the family is disabled for demos.`);
      return {
        classId,
        sent: false,
        skippedReason:
          'This is a demo class — WhatsApp messages are never sent to demo families. ' +
          'Use Preview to view the report and share it through the advisor instead.',
      };
    }

    const prepared = await prepareReport(classId, { ignoreSentLatch: options.force === true, customPhone: options.customPhone });
    if (!prepared.ok) {
      return { classId, sent: false, skippedReason: prepared.reason };
    }
    return deliverPreparedReport(classId, prepared);
  },

  /**
   * The AI-derived facts an admin verifies before a report goes to a family:
   * topics, word cloud, voice balance, summary, quiz. Facts only, no PDF.
   */
  async classReportChecklist(classId: string) {
    const cls = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        classSummary: true,
        interactionMetrics: true,
        sessionId: true,
        reflectionScore: true,
        reflectionMaxScore: true,
        reflectionReviewedAt: true,
        student: { select: { firstName: true, lastName: true } },
      },
    });
    if (!cls) return null;
    const stored = extractStoredReport(cls.interactionMetrics);
    const session = cls.sessionId
      ? await db.session.findUnique({ where: { id: cls.sessionId }, select: { title: true } })
      : null;
    return {
      studentName: `${cls.student?.firstName ?? ''} ${cls.student?.lastName ?? ''}`.trim(),
      sessionTitle: session?.title ?? stored?.sessionTopic ?? null,
      hasAiAnalysis: !!stored,
      hasSummaryText: !!cls.classSummary?.trim(),
      topicsCovered: stored?.topicsCovered ?? [],
      topicsNotReached: stored?.topicsNotReached ?? [],
      wordCloud: (stored?.wordCloud ?? []).slice(0, 15).map((w) => w.word),
      talkTime: stored?.talkTime
        ? { student: stored.talkTime.studentPercent, teacher: stored.talkTime.teacherPercent }
        : null,
      parentSummary: stored?.parentSummary ?? null,
      learningGoals: stored?.learningGoals ?? [],
      quiz: cls.reflectionReviewedAt
        ? { score: cls.reflectionScore, max: cls.reflectionMaxScore }
        : null,
    };
  },

  /**
   * Render the PDF and hand it back without sending anything.
   *
   * Exists so the report can be inspected before it is put in front of a family.
   * Every other route to seeing this document involves WhatsApping it to a real
   * parent, which is a poor way to discover that a name is wrong or the summary
   * came out empty.
   */
  async renderClassReport(
    classId: string
  ): Promise<{ ok: true; buffer: Buffer; fileName: string; variables: Record<string, string> } | { ok: false; reason: string }> {
    // The sent latch is irrelevant here — nothing is delivered, so re-rendering
    // an already-sent report is exactly what an admin checking one wants.
    const prepared = await prepareReport(classId, { ignoreSentLatch: true });
    if (!prepared.ok) return { ok: false, reason: prepared.reason };

    return {
      ok: true,
      buffer: prepared.rendered.buffer,
      fileName: prepared.rendered.fileName,
      variables: prepared.variables,
    };
  },
};

type PreparedReport = {
  ok: true;
  rendered: Awaited<ReturnType<typeof renderSessionReportPdf>>;
  ctx: ReportContext;
  parentId: string;
  phone: string | null;
  variables: Record<string, string>;
  caption: string;
};

/**
 * Everything both the send path and the preview path need: load the class,
 * check it is reportable, and render the PDF.
 *
 * Shared deliberately. When this was inlined in the send path, the preview
 * endpoint would have had to duplicate the eligibility rules and the context
 * building, and the two would have drifted — an admin previewing one document
 * while parents received a different one.
 */
const prepareReport = async (
  classId: string,
  options: { ignoreSentLatch: boolean; customPhone?: string }
): Promise<PreparedReport | { ok: false; reason: string }> => {
  const classSession = await db.scheduledClass.findUnique({
    where: { id: classId },
    include: CLASS_FOR_REPORT,
  });

  logger.info(`[PrepareReport] classId=${classId} found=${!!classSession} status=${classSession?.status} classSummaryLength=${classSession?.classSummary?.length || 0}`);

  if (!classSession) {
    return { ok: false, reason: 'Class not found' };
  }
  if (classSession.status !== 'COMPLETED') {
    return { ok: false, reason: 'Class is not marked complete' };
  }
  if (classSession.reportSentAt && !options.ignoreSentLatch) {
    return { ok: false, reason: `Already sent at ${classSession.reportSentAt.toISOString()}` };
  }
  if (!classSession.classSummary || classSession.classSummary.trim().length === 0) {
    return {
      ok: false,
      reason: 'No AI summary yet — the class recording has not been found and processed',
    };
  }

  /* ── Who sat the class, and who gets the report ──────────────────────────
   * Two shapes, and they do not overlap.
   *
   * REGULAR: an enrolled Student, whose ParentAccount profile carries the phone.
   * DEMO:    no student and no parent at all — a Lead, who is the prospective
   *          parent AND the contact. A demo class stores `leadId` and leaves
   *          `studentId` null, so the student branch below would reject it with
   *          "Class has no student attached" and no trial family would ever
   *          receive the report their demo was supposed to sell them on.
   * ─────────────────────────────────────────────────────────────────────── */
  const isDemo = classSession.classType === 'DEMO' || (!classSession.studentId && !!classSession.leadId);

  let attendeeName: string;
  let recipientName: string | null;
  let recipientId: string;
  let phone: string | null;
  let timezone: string;

  if (isDemo) {
    if (!classSession.leadId) {
      return { ok: false, reason: 'Demo class has no lead attached' };
    }

    const lead = await db.lead.findUnique({
      where: { id: classSession.leadId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        preferredTimezone: true,
      },
    });
    if (!lead) {
      return { ok: false, reason: 'The lead this demo was booked for no longer exists' };
    }

    // The report is about the CHILD and addressed to the PARENT — the same two
    // roles as an enrolled family. A lead names both when the CRM captured them;
    // when it did not, the single name stands in for the attendee, because a
    // report headed "Your child" reads worse than one headed with the only name
    // the family actually gave us.
    attendeeName =
      fullName((lead as any).studentFirstName, (lead as any).studentLastName) ||
      fullName(lead.firstName, lead.lastName) ||
      'Your child';
    recipientName = lead.firstName || null;
    recipientId = lead.id;
    phone = options.customPhone || lead.phone || null;
    timezone = lead.preferredTimezone || 'Asia/Kolkata';

    if (!phone) {
      return { ok: false, reason: 'This lead has no phone number on record, so there is nowhere to send the report' };
    }
  } else {
    const student = classSession.student;
    if (!student) {
      return { ok: false, reason: 'Class has no student attached' };
    }

    const parent = student.parentAccount;
    if (!parent) {
      return { ok: false, reason: 'Student has no parent account' };
    }

    const parentProfile = parent.profiles?.find((p) => p.phone) ?? parent.profiles?.[0];

    attendeeName = fullName(student.firstName, student.lastName) || 'Your child';
    recipientName = fullName(parentProfile?.firstName, parentProfile?.lastName) || null;
    recipientId = parent.id;
    phone = options.customPhone || parentProfile?.phone || null;
    timezone = student.timezone;
  }

  // Programme and session titles live in the learning schema and are not
  // relations on ScheduledClass — it stores bare ids — so they are fetched
  // separately and degrade to a readable placeholder if either is missing.
  const [program, session] = await Promise.all([
    classSession.programId
      ? db.program.findUnique({ where: { id: classSession.programId }, select: { title: true } })
      : Promise.resolve(null),
    classSession.sessionId
      ? db.session.findUnique({ where: { id: classSession.sessionId }, select: { title: true, order: true } })
      : Promise.resolve(null),
  ]);

  const { date, dateLong, time } = formatInTimezone(classSession.startTime, timezone);
  const brandName = process.env.WHATSAPP_BRAND_NAME || 'Finquo Junior';

  /* The curriculum half of the report: the arc, the topic map, the outcomes,
   * the activities and what comes next. Gathered separately from the analysis
   * and never allowed to fail the send — see report-curriculum.ts. */
  const curriculum = await gatherCurriculum({
    classId: classSession.id,
    studentId: classSession.studentId ?? null,
    programId: classSession.programId ?? null,
    sessionId: classSession.sessionId ?? null,
    startTime: classSession.startTime,
    formatWhen: (at: Date) => {
      const parts = formatInTimezone(at, timezone);
      return `${new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'Asia/Kolkata', weekday: 'long' })
        .format(at)
        .toUpperCase()}, ${parts.dateLong.toUpperCase()} · ${parts.time}`;
    },
  });

  const ctx: ReportContext = {
    studentName: attendeeName,
    parentName: recipientName,
    mentorName: fullName(classSession.mentor?.firstName, classSession.mentor?.lastName) || 'Your mentor',
    programName: program?.title || 'Finquo Junior Programme',
    // A demo has no curriculum session — `sessionId` is null — so `session` is
    // always null here and the generic "Class session" would be the title on
    // every demo report a prospective family sees.
    sessionTitle: session?.title || (isDemo ? 'Demo class' : 'Class session'),
    sessionNumber: session?.order ?? null,
    classDate: date,
    classTime: time,
    durationLabel: durationLabel(classSession.startTime, classSession.endTime),
    brandName,
    quizScore: classSession.reflectionReviewedAt ? classSession.reflectionScore : null,
    quizMaxScore: classSession.reflectionReviewedAt ? classSession.reflectionMaxScore : null,
    mentorNote: classSession.reflectionMentorNote,
    contactLine: process.env.WHATSAPP_CONTACT_WEBSITE
      ? `${brandName} — ${process.env.WHATSAPP_CONTACT_WEBSITE}`
      : null,
    curriculum,
  };

  // The structured analysis, when the class was processed after the Student
  // Session Report format landed. Older classes have only prose, and the
  // renderer falls back to parsing that.
  const storedReport = extractStoredReport(classSession.interactionMetrics);

  let rendered;
  try {
    rendered = await renderSessionReportPdf(ctx, classSession.classSummary, storedReport);
  } catch (err: any) {
    logger.error(`[Report] PDF rendering failed for class ${classId}: ${err.message}`);
    await recordFailure(classId, 'PDF_RENDER_FAILED', err.message);
    return { ok: false, reason: `Could not render the report PDF: ${err.message}` };
  }

  // Template variables. Every name here is addressable from
  // WHATSAPP_REPORT_TEMPLATE_VARIABLES, so the approved template's {{1}},
  // {{2}}, ... can be re-pointed in configuration without a code change.
  /* Three learning points for the message body.
   *
   * Padded rather than left short: the template has three fixed bullets, and a
   * missing parameter fails the send. A session with only two authored
   * outcomes says so plainly instead of sending an empty bullet. */
  const firstName = ctx.studentName.split(' ')[0] || ctx.studentName;
  const outcomes = resolveLearningOutcomes(curriculum, storedReport);
  const learningPoints: string[] = [0, 1, 2].map(
    (i) => outcomes[i]?.trim() || 'See the attached report for the full session detail'
  );

  const variables: Record<string, string> = {
    studentName: ctx.studentName.split(' ')[0] || ctx.studentName,
    studentFullName: ctx.studentName,
    parentName: (recipientName ?? '').split(' ')[0] || 'there',
    programName: ctx.programName,
    sessionTitle: ctx.sessionTitle,
    sessionNumber: ctx.sessionNumber ? String(ctx.sessionNumber) : '-',
    // "13th August 2026" — the format the approved template was written
    // against. `classDateShort` is the PDF's compact form, exposed in case a
    // future template wants it.
    classDate: dateLong,
    classDateShort: ctx.classDate,
    classTime: ctx.classTime,
    mentorName: ctx.mentorName,
    engagement: rendered.parsed.engagement || 'Recorded',
    headline: truncate(rendered.parsed.headline, 240),
    quizScore:
      ctx.quizScore !== null && ctx.quizScore !== undefined
        ? `${ctx.quizScore}${ctx.quizMaxScore ? `/${ctx.quizMaxScore}` : ''}`
        : 'Awaiting review',
    brandName,

    /* ── The approved parent template ────────────────────────────────────
     *
     * Meta rejects a template send outright when any body parameter is empty,
     * and rejects the whole message rather than the one variable — so a
     * session whose curriculum has not been authored yet would silently stop
     * reaching parents. Every value below therefore falls back to something
     * true and printable rather than to ''.
     *
     * The three learning points are the same three the PDF prints, resolved
     * through the same function, because the parent reads them side by side. */
    sessionNumberPadded: ctx.sessionNumber ? String(ctx.sessionNumber).padStart(2, '0') : '-',
    learningPoint1: learningPoints[0],
    learningPoint2: learningPoints[1],
    learningPoint3: learningPoints[2],
    /* 280, not 600. Meta measures the template's own text plus every value
     * against a single 1024-character limit, which leaves roughly 700 for all
     * fourteen — a 600-character outcome eats most of that on its own and gets
     * cut at the last moment anyway. The full text is in the PDF regardless. */
    sessionOutcome: truncate(
      storedReport?.parentSummary?.trim() || rendered.parsed.headline || `${firstName} completed this session.`,
      280
    ),
    nextSessionTitle: curriculum.nextSessionTitle?.trim() || storedReport?.nextSessionFocus?.trim() || 'To be confirmed',
    nextSessionWhen: curriculum.nextSessionWhen?.trim() || 'Date to be confirmed',
    rescheduleUrl:
      curriculum.rescheduleUrl?.trim() ||
      process.env.REPORT_RESCHEDULE_URL?.trim() ||
      process.env.WHATSAPP_CONTACT_WEBSITE?.trim() ||
      'Reply to this message to reschedule',
  };

  const caption =
    `${ctx.studentName}'s report for "${ctx.sessionTitle}" (${ctx.classDate}) is attached.`.slice(0, 900);

  return { ok: true, rendered, ctx, parentId: recipientId, phone, variables, caption };
};

/** Upload, send, and record the outcome. Split from `prepareReport` so the
 *  preview endpoint can render without any of this running. */
const deliverPreparedReport = async (
  classId: string,
  prepared: PreparedReport
): Promise<SendReportOutcome> => {
  const { rendered, parentId, phone, variables, caption } = prepared;
  if (!phone || phone.trim().length === 0) {
    const message = 'No phone number found for parent account';
    logger.error(`[Report] Send failed for class ${classId} — ${message}`);
    await recordFailure(classId, 'NO_PHONE_NUMBER', message, true);
    return { classId, sent: false, failureKind: 'NO_PHONE_NUMBER', error: message };
  }
  const storedPath = await persistPdf(classId, rendered.fileName, rendered.buffer);

  try {
    const res = await fetch(`${COMMUNICATION_SERVICE_URL}/whatsapp/session-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: phone || undefined,
        recipientId: parentId,
        // Stored on every WhatsAppMessage row this send produces, so the send
        // history of a class is queryable ("which numbers got this report?").
        classId,
        variables,
        caption,
        document: {
          base64: rendered.buffer.toString('base64'),
          fileName: rendered.fileName,
          mimeType: 'application/pdf',
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      const message = `communication-service returned ${res.status}: ${errText.slice(0, 300)}`;
      logger.error(`[Report] Send failed for class ${classId} — ${message}`);
      await recordFailure(classId, 'COMMUNICATION_SERVICE_ERROR', message);
      return { classId, sent: false, failureKind: 'COMMUNICATION_SERVICE_ERROR', error: message };
    }

    const body = (await res.json()) as any;
    const result = body?.data ?? {};

    if (!result.success) {
      // A policy refusal (audience toggle off, outbound mode) arrives as
      // `skipped: true` with the reason in the envelope's message, not in
      // `error` — it used to surface as "UNKNOWN" with nothing to act on.
      const kind = String(result.failureKind ?? (result.skipped ? 'SKIPPED' : 'UNKNOWN'));
      const reason: string | undefined = result.error ?? body?.message ?? undefined;
      logger.error(
        `[Report] Class ${classId} report was NOT delivered to parent ${parentId} (${kind}): ${reason}`
      );
      await recordFailure(classId, kind, reason, TERMINAL_FAILURES.has(kind));
      return { classId, sent: false, failureKind: kind, error: reason };
    }

    await db.scheduledClass.update({
      where: { id: classId },
      data: {
        reportSentAt: new Date(),
        // The number the send actually went to — an admin can type any number
        // into the manual dispatch card, so "the parent's number on file" is
        // not a safe assumption about where this report ended up.
        reportSentTo: phone,
        reportPdfPath: storedPath,
        reportAttempts: { increment: 1 },
        reportLastError: result.documentDelivered
          ? null
          : `Message delivered but the PDF was not attached: ${result.error ?? 'media upload failed'}`,
      },
    });

    logger.info(
      `[Report] Class ${classId} report delivered to parent ${parentId} via ${result.channel} ` +
        `(messageId ${result.messageId ?? '-'}, attachment ${result.documentDelivered ? 'included' : 'MISSING'}).`
    );

    return { classId, sent: true, documentDelivered: Boolean(result.documentDelivered) };
  } catch (err: any) {
    logger.error(`[Report] communication-service unreachable for class ${classId}: ${err.message}`);
    await recordFailure(classId, 'NETWORK_ERROR', err.message);
    return { classId, sent: false, failureKind: 'NETWORK_ERROR', error: err.message };
  }
};

/**
 * Record a failed attempt.
 *
 * A terminal failure parks the class at the attempt ceiling rather than letting
 * it burn four more identical attempts: a parent with no phone number on file
 * will not grow one by the fifth try, and every retry costs a PDF render.
 */
const recordFailure = async (
  classId: string,
  kind: string,
  detail?: string,
  terminal = false
): Promise<void> => {
  try {
    await db.scheduledClass.update({
      where: { id: classId },
      data: {
        reportAttempts: terminal ? MAX_REPORT_ATTEMPTS : { increment: 1 },
        reportLastError: `[${kind}] ${detail ?? 'no detail'}`.slice(0, 1000),
      },
    });
  } catch (err: any) {
    logger.error(`[Report] Could not record the failed attempt for class ${classId}: ${err.message}`);
  }
};
