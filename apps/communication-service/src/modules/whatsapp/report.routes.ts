import { Router, Request, Response } from 'express';
import { HTTP_STATUS } from '@futurespark/constants';
import { successResponse, errorResponse } from '@futurespark/response';
import { logger } from '@futurespark/logger';
import { getAudienceSettings, maskPhone, whatsappConfig, whatsappService } from './whatsapp.service';
import { sessionReportService } from './report.service';

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
    const audience = getAudienceSettings();
    if (!audience.regularParents) {
      logger.info('[Session Report] Skipped — Audience section control for Regular Parents is DISABLED.');
      return res.status(HTTP_STATUS.OK).json(
        successResponse(
          { success: false, skipped: true },
          'Session reports are disabled: Regular Parents audience toggle is OFF.'
        )
      );
    }
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

    const templateComponents = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: parentName },
          { type: 'text', text: studentName },
          { type: 'text', text: courseName },
          { type: 'text', text: sessionDate },
          { type: 'text', text: sessionTime },
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
        `⏰ *Time:* ${sessionTime} (${displayTimezone})\n\n` +
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

export { router as whatsappReportRoutes };

