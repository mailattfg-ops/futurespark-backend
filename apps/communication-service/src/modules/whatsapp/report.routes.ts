import { Router, Request, Response } from 'express';
import { HTTP_STATUS } from '@futurespark/constants';
import { successResponse, errorResponse } from '@futurespark/response';
import { logger } from '@futurespark/logger';
import { getAudienceSettings, maskPhone, whatsappConfig, whatsappService } from './whatsapp.service';
import { sessionReportService } from './report.service';
import {
  buildInternalComponents,
  InternalNotifyContext,
  InternalNotifyKind,
  TEMPLATE_NAMES,
} from './internal-notify';

const router = Router();

/**
 * POST /whatsapp/session-report
 *
 * Service-to-service only — the gateway proxies `/api/notifications` and
 * `/api/whatsapp/webhook` and nothing else on this service, so this route has no
 * public path. That is what makes it safe to return the delivery outcome in the
 * body: unlike `POST /notifications`, whose `recipientId` comes from an untrusted
 * caller and whose result would leak whether a given user has a phone on file,
 * the only caller here is auth-service's report cron, which needs to know
 * whether to stamp the class as reported or retry it.
 */
router.post('/session-report', async (req: Request, res: Response) => {
  try {
    /* Not gated by the audience toggles. Those switches exist for messages
     * the system sends on its own; the session report reaches this route
     * because an admin pressed Send for a specific class. A toggle silently
     * refusing that click — which is what happened — is a trap, not a
     * safeguard. The only thing that stops a report is a real delivery
     * failure, and that is reported back with its reason. */
    const { to, recipientId, classId, variables, document, caption } = req.body ?? {};

    if (!to && !recipientId) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(errorResponse('Either "to" (phone number) or "recipientId" is required.'));
    }

    let phone: string | null = typeof to === 'string' && to.trim().length > 0 ? to.trim() : null;

    if (!phone && recipientId) {
      phone = await whatsappService.resolveUserPhoneNumber(recipientId);
      if (!phone) {
        // Not a server error: plenty of parents have no phone on file, and the
        // caller should record that rather than retry it forever.
        return res.status(HTTP_STATUS.OK).json(
          successResponse(
            {
              success: false,
              documentDelivered: false,
              failureKind: 'NO_PHONE_NUMBER',
              error: 'No phone number on record for this recipient.',
              retryable: false,
            },
            'No phone number on record for this recipient.'
          )
        );
      }
    }

    const result = await sessionReportService.sendSessionReport({
      to: phone as string,
      recipientId: typeof recipientId === 'string' ? recipientId : undefined,
      classId: typeof classId === 'string' ? classId : undefined,
      variables: variables && typeof variables === 'object' ? variables : {},
      document,
      caption: typeof caption === 'string' ? caption : undefined,
    });

    // Always 200. A refused send is a fact about the message, not a failure of
    // this endpoint, and the caller branches on `result.success`.
    return res
      .status(HTTP_STATUS.OK)
      .json(successResponse(result, result.success ? 'Session report sent.' : 'Session report was not delivered.'));
  } catch (err: any) {
    logger.error(`[Session Report] Unhandled error sending report to ${maskPhone(req.body?.to)}: ${err.message}`);
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json(errorResponse(err.message || 'Failed to send the session report'));
  }
});

/**
 * POST /whatsapp/session-reminder
 *
 * Sends a demo session reminder WhatsApp message using template "session_reminder"
 * or free-text fallback when someone registers on the demo booking form.
 */
/**
 * A stored slot time is IST-canonical; the parent reading the message may be
 * in Dubai. "01:00 PM (UAE)" was the stored IST clock wearing the wrong
 * label — 01:00 PM IST is 11:30 AM in the UAE. Converted ONLY here, at the
 * display edge: the stored value and the mentor's IST schedule are never
 * touched. IST has no DST, so the fixed -330 offset is safe server-side.
 */
const TZ_ALIASES: Record<string, string> = {
  uae: 'Asia/Dubai',
  gst: 'Asia/Dubai',
  dubai: 'Asia/Dubai',
  uk: 'Europe/London',
  bst: 'Europe/London',
  gmt: 'Europe/London',
  ist: 'Asia/Kolkata',
  india: 'Asia/Kolkata',
};

const slotInTimezone = (slotTime: string, tz: string | undefined, sessionDate: string | undefined): string => {
  try {
    if (!tz) return slotTime;
    const zone = TZ_ALIASES[tz.trim().toLowerCase()] ?? tz.trim();
    if (/kolkata/i.test(zone)) return slotTime;
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(slotTime).trim());
    if (!m) return slotTime;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (m[3]) {
      h = h % 12;
      if (m[3].toUpperCase() === 'PM') h += 12;
    }
    // The session's calendar date (IST), so zones with DST convert on the
    // right side of their boundary: dd/mm/yyyy when present, else today.
    const dm = /(\d{1,2})[/](\d{1,2})[/](\d{4})/.exec(String(sessionDate ?? ''));
    const istNow = new Date(Date.now() + 330 * 60 * 1000);
    const [d, mo, y] = dm
      ? [Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])]
      : [istNow.getUTCDate(), istNow.getUTCMonth(), istNow.getUTCFullYear()];
    const utcMs = Date.UTC(y, mo, d, 0, h * 60 + min - 330); // IST = UTC+5:30
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(utcMs));
  } catch {
    // An unknown timezone string must not break the send; an IST time with a
    // wrong label is recoverable, a failed message is not.
    return slotTime;
  }
};

router.post('/session-reminder', async (req: Request, res: Response) => {
  const audience = getAudienceSettings();
  const courseLower = (req.body?.courseName || '').toLowerCase();
  const isPilot = courseLower.includes('pilot') || courseLower.includes('mentorship');
  const isDemo = courseLower.includes('demo') || courseLower.includes('financial');

  const isAllowed = (isPilot && audience.pilotProgramLeads) ||
                    (isDemo && audience.leadsManagement) ||
                    (!isPilot && !isDemo && (audience.pilotProgramLeads || audience.leadsManagement || audience.regularParents));

  if (!isAllowed) {
    logger.info('[Session Reminder] Skipped — Audience section controls for Pilot/Demo leads are DISABLED.');
    return res.status(HTTP_STATUS.OK).json(
      successResponse(
        { success: false, skipped: true },
        'Session reminders are disabled: Audience section controls are toggled OFF.'
      )
    );
  }

  if (whatsappConfig.outboundMode !== 'all') {
    // Fired automatically by the lead/demo booking flow, which makes it the
    // easiest send to forget exists. Refused loudly rather than skipped
    // quietly, so the caller's log says why no message arrived.
    logger.info('[Session Reminder] Skipped — outbound WhatsApp is limited to the manual session report.');
    return res.status(HTTP_STATUS.OK).json(
      successResponse(
        { success: false, skipped: true },
        'Session reminders are disabled: outbound WhatsApp is limited to the manual session report ' +
          '(set WHATSAPP_OUTBOUND_MODE=all to re-enable).'
      )
    );
  }

  try {
    const {
      to,
      parentName = 'Parent',
      studentName = 'Student',
      courseName = 'Financial Literacy',
      sessionDate = new Date().toLocaleDateString('en-GB'),
      sessionTime = '04:00 PM',
      timezone = 'IST',
      joinUrl = process.env.LANDING_PAGE_URL || 'https://junior.finquo.ai/',
    } = req.body ?? {};

    if (!to || typeof to !== 'string' || !to.trim()) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(errorResponse('Phone number "to" is required.'));
    }

    const formatTimezone = (tz?: string): string => {
      if (!tz) return 'India';
      const raw = tz.trim();
      if (/asia\/kolkata|ist|india/i.test(raw)) return 'India';
      if (/asia\/dubai|gst|uae/i.test(raw)) return 'UAE';
      if (/europe\/london|gmt|bst|uk/i.test(raw)) return 'UK';
      if (/america\/new_york|est|us east/i.test(raw)) return 'US East';
      if (/america\/los_angeles|pst|us west/i.test(raw)) return 'US West';
      if (/asia\/singapore|sgt|singapore/i.test(raw)) return 'Singapore';
      if (/asia\/riyadh|ast|saudi/i.test(raw)) return 'Saudi Arabia';
      if (/australia\/sydney|aest|australia/i.test(raw)) return 'Australia';
      return raw;
    };

    const displayTimezone = formatTimezone(timezone);
    const displayTime = slotInTimezone(sessionTime, timezone, sessionDate);

    const templateComponents = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: parentName },
          { type: 'text', text: studentName },
          { type: 'text', text: courseName },
          { type: 'text', text: sessionDate },
          { type: 'text', text: displayTime },
          { type: 'text', text: displayTimezone },
          { type: 'text', text: joinUrl },
        ],
      },
    ];

    // 1. Attempt template send with template "session_reminder"
    let result = await whatsappService.sendTemplateMessage(
      to,
      'session_reminder',
      'en',
      templateComponents
    );

    // 2. Fallback text send if template is not configured or fails
    if (!result.success) {
      const textMessage =
        `Hi ${parentName} 👋\n\n` +
        `⏰ Reminder: ${studentName}’s *${courseName}* session is scheduled:\n\n` +
        `📅 *Date:* ${sessionDate}\n` +
        `⏰ *Time:* ${displayTime} (${displayTimezone})\n\n` +
        `💻 Please join using a laptop/desktop with a stable internet connection.\n\n` +
        `🔗 *Join & Reschedule Here:* ${joinUrl}\n` +
        `_(You can also request to reschedule your session on this page if needed.)_\n\n` +
        `Please join the session with your child to experience their learning and improvement live.\n\n` +
        `Thank you,\n` +
        `*FINQUO junior*`;

      result = await whatsappService.sendTextMessage(to, textMessage);
    }

    return res
      .status(HTTP_STATUS.OK)
      .json(successResponse(result, result.success ? 'Session reminder sent.' : 'Session reminder delivery attempted.'));
  } catch (err: any) {
    logger.error(`[Session Reminder] Error sending reminder: ${err.message}`);
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json(errorResponse(err.message || 'Failed to send session reminder'));
  }
});

/** Send one internal template to every resolved number. Never throws. */
const dispatchInternal = async (
  kind: InternalNotifyKind,
  context: InternalNotifyContext,
  recipients: string[]
): Promise<{ sent: number; failed: number }> => {
  const components = buildInternalComponents(kind, context);
  let sent = 0;
  const failures: string[] = [];
  for (const to of recipients) {
    const result = await whatsappService.sendTemplateMessage(to, TEMPLATE_NAMES[kind], 'en', components);
    if (result.success) sent++;
    else failures.push(`${maskPhone(to)}: ${result.error ?? result.failureKind}`);
  }
  if (failures.length) {
    logger.warn(`[Internal Notify] ${kind} — ${failures.length} send(s) failed: ${failures.join(' | ')}`);
  }
  logger.info(`[Internal Notify] ${kind} — sent to ${sent}/${recipients.length} internal number(s).`);
  return { sent, failed: failures.length };
};

/**
 * POST /whatsapp/internal-notify
 *
 * Ops pings to the TEAM (schedulers, the class's mentor) — never to families.
 * Service-to-service only, like session-report above: no gateway path reaches
 * it. Deliberately NOT gated on the parent-audience toggles — those switch
 * customer messaging; the team still needs to know a demo landed. It does
 * respect the global outbound mode, so "reports only" keeps every automatic
 * send quiet.
 */
router.post('/internal-notify', async (req: Request, res: Response) => {
  if (whatsappConfig.outboundMode !== 'all') {
    logger.info('[Internal Notify] Skipped — outbound WhatsApp is limited to the manual session report.');
    return res.status(HTTP_STATUS.OK).json(
      successResponse({ sent: 0, skipped: true }, 'Internal notifications disabled by outbound mode.')
    );
  }

  const kind = req.body?.kind as InternalNotifyKind;
  if (!TEMPLATE_NAMES[kind]) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse(`Unknown internal notification kind: ${kind}`));
  }
  const context: InternalNotifyContext = req.body?.context ?? {};
  const recipients: string[] = Array.isArray(req.body?.recipients)
    ? [...new Set((req.body.recipients as unknown[]).filter((r): r is string => typeof r === 'string' && !!r.trim()))]
    : [];
  if (recipients.length === 0) {
    logger.info(`[Internal Notify] ${kind} — no recipients with a phone number configured; nothing sent.`);
    return res.status(HTTP_STATUS.OK).json(successResponse({ sent: 0 }, 'No internal recipients configured.'));
  }

  const { sent, failed } = await dispatchInternal(kind, context, recipients);
  return res.status(HTTP_STATUS.OK).json(successResponse({ sent, failed }, 'Internal notify complete'));
});

/**
 * POST /whatsapp/internal-notify-staff
 *
 * Same ping, for callers that do not know who the staff are — learning-service
 * handles website demo bookings but cannot read auth-service's user table. It
 * asks auth-service for the numbers, then reuses the route above.
 */
router.post('/internal-notify-staff', async (req: Request, res: Response) => {
  const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:3001';
  try {
    const lookup = await fetch(`${AUTH_SERVICE_URL}/schedules/internal/staff-numbers`, {
      headers: process.env.INTERNAL_API_KEY ? { 'x-internal-key': process.env.INTERNAL_API_KEY } : {},
      signal: AbortSignal.timeout(5000),
    });
    const body: any = lookup.ok ? await lookup.json().catch(() => null) : null;
    const recipients: string[] = Array.isArray(body?.data) ? body.data : [];

    const kind = req.body?.kind as InternalNotifyKind;
    if (!TEMPLATE_NAMES[kind]) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse(`Unknown internal notification kind: ${kind}`));
    }
    if (whatsappConfig.outboundMode !== 'all') {
      logger.info('[Internal Notify] Skipped — outbound WhatsApp is limited to the manual session report.');
      return res.status(HTTP_STATUS.OK).json(successResponse({ sent: 0, skipped: true }, 'Disabled by outbound mode.'));
    }
    const result = await dispatchInternal(kind, req.body?.context ?? {}, recipients);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Internal notify complete'));
  } catch (err: any) {
    logger.warn(`[Internal Notify] Could not resolve staff numbers: ${err?.message ?? err}`);
    return res.status(HTTP_STATUS.OK).json(successResponse({ sent: 0 }, 'No internal recipients resolved.'));
  }
});

export { router as whatsappReportRoutes };

