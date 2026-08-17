import fs from 'fs';
import path from 'path';
import { logger } from '@futurespark/logger';
import { S3Storage } from '@futurespark/storage';
import db from '../../database/datasource';
import { renderSessionReportPdf, type ReportContext } from './report-pdf';
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
    const prepared = await prepareReport(classId, { ignoreSentLatch: options.force === true, customPhone: options.customPhone });
    if (!prepared.ok) {
      return { classId, sent: false, skippedReason: prepared.reason };
    }
    return deliverPreparedReport(classId, prepared);
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

  const student = classSession.student;
  if (!student) {
    return { ok: false, reason: 'Class has no student attached' };
  }

  const parent = student.parentAccount;
  const parentProfile = parent?.profiles?.find((p) => p.phone) ?? parent?.profiles?.[0];
  const phone = options.customPhone || parentProfile?.phone || null;

  if (!parent) {
    return { ok: false, reason: 'Student has no parent account' };
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

  const { date, dateLong, time } = formatInTimezone(classSession.startTime, student.timezone);
  const brandName = process.env.WHATSAPP_BRAND_NAME || 'Finquo Junior';

  const ctx: ReportContext = {
    studentName: fullName(student.firstName, student.lastName) || 'Your child',
    parentName: fullName(parentProfile?.firstName, parentProfile?.lastName) || null,
    mentorName: fullName(classSession.mentor?.firstName, classSession.mentor?.lastName) || 'Your mentor',
    programName: program?.title || 'Finquo Junior Programme',
    sessionTitle: session?.title || 'Class session',
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
  };

  let rendered;
  try {
    rendered = await renderSessionReportPdf(ctx, classSession.classSummary);
  } catch (err: any) {
    logger.error(`[Report] PDF rendering failed for class ${classId}: ${err.message}`);
    await recordFailure(classId, 'PDF_RENDER_FAILED', err.message);
    return { ok: false, reason: `Could not render the report PDF: ${err.message}` };
  }

  // Template variables. Every name here is addressable from
  // WHATSAPP_REPORT_TEMPLATE_VARIABLES, so the approved template's {{1}},
  // {{2}}, ... can be re-pointed in configuration without a code change.
  const variables: Record<string, string> = {
    studentName: student.firstName || ctx.studentName,
    studentFullName: ctx.studentName,
    parentName: parentProfile?.firstName || 'there',
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
  };

  const caption =
    `${ctx.studentName}'s report for "${ctx.sessionTitle}" (${ctx.classDate}) is attached.`.slice(0, 900);

  return { ok: true, rendered, ctx, parentId: parent.id, phone, variables, caption };
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
      const kind = String(result.failureKind ?? 'UNKNOWN');
      logger.error(
        `[Report] Class ${classId} report was NOT delivered to parent ${parentId} (${kind}): ${result.error}`
      );
      await recordFailure(classId, kind, result.error, TERMINAL_FAILURES.has(kind));
      return { classId, sent: false, failureKind: kind, error: result.error };
    }

    await db.scheduledClass.update({
      where: { id: classId },
      data: {
        reportSentAt: new Date(),
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
