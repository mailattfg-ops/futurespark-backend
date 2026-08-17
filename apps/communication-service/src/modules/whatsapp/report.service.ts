import { logger } from '@futurespark/logger';
import {
  maskPhone,
  normalizePhone,
  whatsappConfig,
  whatsappService,
  WINDOW_CLOSED_ERROR_CODE,
  type WhatsAppSendResult,
} from './whatsapp.service';

/**
 * Delivery of the post-class report: one PDF and one message, to one parent.
 *
 * This is business-initiated and almost always lands OUTSIDE the 24-hour
 * customer service window — a parent has no reason to have messaged us in the
 * hours after their child's class — so the approved template is the normal path
 * here, not the fallback. That inverts the usual assumption in
 * `sendBusinessInitiatedMessage`, which is why this does not reuse it.
 */

export interface SessionReportRequest {
  /** E.164 preferred; national numbers are resolved against the configured country code. */
  to: string;
  /** Ordered template variables are looked up in here by name. */
  variables: Record<string, string | number | null | undefined>;
  document?: {
    /** Raw PDF bytes, base64-encoded for transport between services. */
    base64: string;
    fileName: string;
    mimeType?: string;
  };
  /** Free-form text used when the 24h window happens to be open. */
  caption?: string;
  recipientId?: string;
}

export interface SessionReportResult {
  success: boolean;
  messageId?: string;
  channel?: WhatsAppSendResult['channel'];
  /** True when the PDF itself reached the parent (not just the text). */
  documentDelivered: boolean;
  failureKind?: string;
  error?: string;
  retryable?: boolean;
}

/** Meta rejects a parameter containing newlines, tabs, or 4+ consecutive spaces. */
const asTemplateParameter = (value: unknown): string => {
  const flattened = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (flattened.length > 0 ? flattened : '-').slice(0, 1024);
};

/**
 * Build the template components.
 *
 * Body parameters are positional: Meta matches them to {{1}}, {{2}}, ... in the
 * order given, and a count mismatch is a hard rejection (132000) rather than a
 * partial send. The order comes from WHATSAPP_REPORT_TEMPLATE_VARIABLES so the
 * template can be edited in Meta's console without a deploy — the price is that
 * the two must be kept in step, so the resolved values are logged on every send.
 */
const buildComponents = (
  variables: SessionReportRequest['variables'],
  mediaId?: string,
  fileName?: string
): { components: any[]; resolved: Array<{ name: string; value: string }> } => {
  const components: any[] = [];

  if (whatsappConfig.reportTemplateHasDocumentHeader && mediaId) {
    components.push({
      type: 'header',
      parameters: [{ type: 'document', document: { id: mediaId, filename: fileName || 'Report.pdf' } }],
    });
  }

  const order = whatsappConfig.reportTemplateVariables;
  const resolved = order.map((name) => ({ name, value: asTemplateParameter(variables[name]) }));

  if (resolved.length > 0) {
    components.push({
      type: 'body',
      parameters: resolved.map(({ value }) => ({ type: 'text', text: value })),
    });
  }

  return { components, resolved };
};

export const sessionReportService = {
  /**
   * Send one parent their child's session report.
   *
   * Order of operations matters. The PDF is uploaded to Meta FIRST, because a
   * template with a document header needs the media id at send time; if the
   * upload fails the text still goes out, and the caller is told the document
   * did not — a parent receiving "the report is attached" with nothing attached
   * is worse than receiving a message that stands on its own.
   */
  async sendSessionReport(request: SessionReportRequest): Promise<SessionReportResult> {
    const normalized = normalizePhone(request.to);
    if (!normalized.ok || !normalized.value) {
      const error = `Refusing to send the session report: ${normalized.reason}`;
      logger.error(`[Session Report] WHATSAPP_SEND_REFUSED INVALID_RECIPIENT — ${error}`);
      return { success: false, documentDelivered: false, failureKind: 'INVALID_RECIPIENT', error, retryable: false };
    }
    const to = normalized.value;

    const templateName = whatsappConfig.reportTemplateName;
    if (!templateName) {
      const error =
        'WHATSAPP_REPORT_TEMPLATE_NAME is not set. The post-class report is business-initiated and ' +
        'nearly always falls outside the 24-hour customer service window, so an APPROVED template is ' +
        'required — a free-form message would be rejected by Meta with 131047. Set it to the approved ' +
        'template name (e.g. session_progress_report) and WHATSAPP_REPORT_TEMPLATE_LANGUAGE to its ' +
        'exact language code ("en" and "en_US" are different templates to Meta).';
      logger.error(`[Session Report] WHATSAPP_SEND_REFUSED TEMPLATE_NOT_CONFIGURED — ${error}`);
      return { success: false, documentDelivered: false, failureKind: 'TEMPLATE_NOT_CONFIGURED', error, retryable: false };
    }

    // 1. Upload the PDF, if there is one.
    let mediaId: string | undefined;
    let uploadError: string | undefined;

    if (request.document?.base64) {
      const bytes = Buffer.from(request.document.base64, 'base64');
      const upload = await whatsappService.uploadMedia(
        bytes,
        request.document.fileName,
        request.document.mimeType || 'application/pdf'
      );
      if (upload.success && upload.mediaId) {
        mediaId = upload.mediaId;
      } else {
        uploadError = upload.error;
        logger.error(
          `[Session Report] PDF upload failed for ${maskPhone(to)} (${upload.failureKind}): ${upload.error}. ` +
            'The message will still be sent, without the attachment.'
        );
      }
    }

    // 2. Inside the window, a free-form document message is richer and unbilled.
    //    Rare for this notification, but free when it happens.
    const windowOpen = await whatsappService.isWithinCustomerServiceWindow(to);

    if (windowOpen && mediaId) {
      const documentResult = await whatsappService.sendDocumentMessage(
        to,
        { mediaId, fileName: request.document!.fileName, caption: request.caption },
        request.recipientId
      );

      if (documentResult.success) {
        logger.info(`[Session Report] Delivered as a free-form document to ${maskPhone(to)} (24h window open).`);
        return {
          success: true,
          messageId: documentResult.messageId,
          channel: documentResult.channel,
          documentDelivered: true,
        };
      }

      const reallyClosed =
        documentResult.failureKind === 'WINDOW_CLOSED' || documentResult.errorCode === WINDOW_CLOSED_ERROR_CODE;

      if (!reallyClosed) {
        // A bad token or an unreachable number is not fixed by re-sending as a
        // template, and re-sending would risk delivering the report twice.
        return {
          success: false,
          documentDelivered: false,
          failureKind: documentResult.failureKind,
          error: documentResult.error,
          retryable: documentResult.retryable,
        };
      }

      logger.warn(
        `[Session Report] Window check said OPEN for ${maskPhone(to)} but Meta rejected the document ` +
          'with 131047. Falling through to the approved template.'
      );
    }

    // 3. The normal path: the approved template, carrying the PDF in its header.
    const { components, resolved } = buildComponents(request.variables, mediaId, request.document?.fileName);

    logger.info(
      `[Session Report] Sending template "${templateName}" (${whatsappConfig.reportTemplateLanguage}) to ` +
        `${maskPhone(to)} with ${resolved.length} body variable(s) [` +
        resolved.map((r, i) => `{{${i + 1}}}=${r.name}`).join(', ') +
        `]${mediaId ? ' and a document header' : ' and NO attachment'}.`
    );

    const result = await whatsappService.sendTemplateMessage(
      to,
      templateName,
      whatsappConfig.reportTemplateLanguage,
      components,
      request.recipientId
    );

    if (!result.success) {
      if (result.failureKind === 'TEMPLATE_MISCONFIGURED') {
        logger.error(
          `[Session Report] Meta rejected template "${templateName}". The usual causes, in order of ` +
            `likelihood: (1) WHATSAPP_REPORT_TEMPLATE_VARIABLES declares ${resolved.length} variables but the ` +
            'approved template has a different number; (2) WHATSAPP_REPORT_TEMPLATE_LANGUAGE does not match ' +
            'the approved translation exactly; (3) WHATSAPP_REPORT_TEMPLATE_HEADER says the template has a ' +
            'document header and it does not, or the reverse.'
        );
      }
      return {
        success: false,
        documentDelivered: false,
        failureKind: result.failureKind,
        error: result.error,
        retryable: result.retryable,
      };
    }

    return {
      success: true,
      messageId: result.messageId,
      channel: result.channel,
      documentDelivered: Boolean(mediaId),
      // Surfaced even on success so the caller can log that the text landed but
      // the attachment did not.
      error: mediaId ? undefined : uploadError,
    };
  },
};
