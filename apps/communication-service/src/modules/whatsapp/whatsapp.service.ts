import { logger } from '@futurespark/logger';
import db from '../../database/datasource';

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '1250776148116475';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

export const whatsappService = {
  /**
   * Resolve a recipient's phone number by calling the auth-service.
   * Checks parent account profiles first, then falls back to general user details.
   */
  async resolveUserPhoneNumber(recipientId: string): Promise<string | null> {
    try {
      // 1. Try to fetch as parent/customer account
      const parentUrl = `${AUTH_SERVICE_URL}/users/customers/${recipientId}`;
      logger.info(`[WhatsApp Service] Resolving phone for recipientId: ${recipientId} via ${parentUrl}`);
      const parentRes = await fetch(parentUrl);
      if (parentRes.ok) {
        const body = await parentRes.json() as any;
        const parent = body?.data;
        if (parent?.profiles && parent.profiles.length > 0) {
          // Find first profile with a phone number
          for (const profile of parent.profiles) {
            if (profile.phone) {
              logger.info(`[WhatsApp Service] Resolved phone number from parent profile: ${profile.phone}`);
              return this.sanitizePhoneNumber(profile.phone);
            }
          }
        }
      }

      // 2. Fallback to standard user check
      const userUrl = `${AUTH_SERVICE_URL}/users/${recipientId}`;
      logger.info(`[WhatsApp Service] Trying general user details for recipientId: ${recipientId} via ${userUrl}`);
      const userRes = await fetch(userUrl);
      if (userRes.ok) {
        const body = await userRes.json() as any;
        const user = body?.data;
        if (user?.phone) {
          logger.info(`[WhatsApp Service] Resolved phone number from user details: ${user.phone}`);
          return this.sanitizePhoneNumber(user.phone);
        }
      }

      logger.warn(`[WhatsApp Service] No phone number resolved for recipientId: ${recipientId}`);
      return null;
    } catch (error: any) {
      logger.error(`[WhatsApp Service] Error resolving user phone number: ${error.message}`);
      return null;
    }
  },

  /**
   * Helper to ensure phone number has international format (no +, spaces, etc.)
   */
  sanitizePhoneNumber(phone: string): string {
    // Remove all non-numeric characters except leading '+' if present
    const cleaned = phone.replace(/[^\d+]/g, '');
    // If it starts with '+', remove it for Meta API
    return cleaned.startsWith('+') ? cleaned.substring(1) : cleaned;
  },

  /**
   * Send a standard text message
   */
  async sendTextMessage(to: string, text: string, recipientId?: string): Promise<any> {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.sanitizePhoneNumber(to),
      type: 'text',
      text: {
        preview_url: false,
        body: text,
      },
    };

    return this.sendMetaRequest(payload, 'text', text, recipientId);
  },

  /**
   * Send interactive reply buttons (max 3 buttons)
   */
  async sendInteractiveButtons(
    to: string,
    text: string,
    buttons: Array<{ id: string; title: string }>,
    recipientId?: string
  ): Promise<any> {
    const formattedButtons = buttons.slice(0, 3).map((btn) => ({
      type: 'reply',
      reply: {
        id: btn.id,
        title: btn.title,
      },
    }));

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.sanitizePhoneNumber(to),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: text,
        },
        action: {
          buttons: formattedButtons,
        },
      },
    };

    const description = `Interactive: ${text} | Buttons: ${buttons.map((b) => b.title).join(', ')}`;
    return this.sendMetaRequest(payload, 'button', description, recipientId);
  },

  /**
   * Send a pre-approved template message
   */
  async sendTemplateMessage(
    to: string,
    templateName: string,
    languageCode: string = 'en_US',
    components: any[] = [],
    recipientId?: string
  ): Promise<any> {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.sanitizePhoneNumber(to),
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: languageCode,
        },
        components: components,
      },
    };

    const description = `Template: ${templateName} (lang: ${languageCode})`;
    return this.sendMetaRequest(payload, 'template', description, recipientId);
  },

  /**
   * Internal helper to make the API call to Meta and log to DB
   */
  async sendMetaRequest(payload: any, type: string, bodyContent: string, recipientId?: string): Promise<any> {
    const phoneId = WHATSAPP_PHONE_NUMBER_ID;
    const url = `https://graph.facebook.com/v19.0/${phoneId}/messages`;
    const to = payload.to;

    // Create initial pending message log in DB
    const dbLog = await db.whatsAppMessage.create({
      data: {
        from: 'SYSTEM',
        to: to,
        direction: 'OUTBOUND',
        type: type,
        body: bodyContent,
        status: 'pending',
        recipientId: recipientId || null,
      },
    });

    if (!WHATSAPP_ACCESS_TOKEN) {
      const errorMsg = 'WHATSAPP_ACCESS_TOKEN is not configured in environment variables.';
      logger.error(`[WhatsApp Service] ${errorMsg}`);
      await db.whatsAppMessage.update({
        where: { id: dbLog.id },
        data: { status: 'failed', error: errorMsg },
      });
      return { success: false, error: errorMsg };
    }

    try {
      logger.info(`[WhatsApp Service] Sending ${type} message to ${to}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const responseBody = await res.json() as any;

      if (!res.ok) {
        const errorDetails = JSON.stringify(responseBody?.error || responseBody);
        logger.error(`[WhatsApp Service] Meta API error details: ${errorDetails}`);
        await db.whatsAppMessage.update({
          where: { id: dbLog.id },
          data: {
            status: 'failed',
            error: `Meta Error (${res.status}): ${responseBody?.error?.message || 'Unknown error'}`,
          },
        });
        return { success: false, error: responseBody?.error };
      }

      const metaMessageId = responseBody?.messages?.[0]?.id;
      logger.info(`[WhatsApp Service] Message sent successfully. Meta ID: ${metaMessageId}`);

      await db.whatsAppMessage.update({
        where: { id: dbLog.id },
        data: {
          status: 'sent',
          messageId: metaMessageId,
        },
      });

      return { success: true, messageId: metaMessageId, data: responseBody };
    } catch (err: any) {
      logger.error(`[WhatsApp Service] Network or system error: ${err.message}`);
      await db.whatsAppMessage.update({
        where: { id: dbLog.id },
        data: {
          status: 'failed',
          error: err.message,
        },
      });
      return { success: false, error: err.message };
    }
  },
};
