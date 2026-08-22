import { randomBytes } from 'crypto';
import { logger } from '@futurespark/logger';
import db from '../../database/datasource';

/* ══════════════════════════════════════════════════════════════════════════
 * CONFIGURATION
 *
 * Every value is read LAZILY through a getter, never captured into a module
 * const at import time. This is deliberate: `server.ts` imports `./app` (which
 * transitively imports this file) BEFORE it calls `dotenv.config()`, so any
 * `process.env.X` evaluated at module load would be `undefined` under
 * `npm start` / `npm run dev`. Lazy reads make the load order irrelevant.
 * `app.ts` additionally loads dotenv in its module body before it calls
 * `assertWhatsAppStartupConfig()`, so the boot-time check sees real values.
 *
 * THERE ARE NO FALLBACK CREDENTIALS. A missing credential fails loudly.
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Graph API version used when WHATSAPP_API_VERSION is unset.
 * Review this at every cutover: Meta supports a version for roughly two years
 * after release, and calls to a sunset version are silently auto-upgraded,
 * which can change both request validation and the shape of the `error` object
 * that the failure classification below depends on.
 */
const DEFAULT_GRAPH_API_VERSION = 'v23.0';
const GRAPH_API_VERSION_PATTERN = /^v\d+\.\d+$/;

/** Values that must never be used to talk to production. */
const SANDBOX_PHONE_NUMBER_ID = '1250776148116475';
/** This literal was committed to a PUBLIC repository — it is burned. */
const LEAKED_WEBHOOK_VERIFY_TOKEN = 'futurespark-webhook-secret';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Meta's "re-engagement message" error: the 24h window is closed. */
export const WINDOW_CLOSED_ERROR_CODE = 131047;

/**
 * Safety margin subtracted from the 24h window, because the timestamp we
 * measure from is only as good as the inbound row that carries it. See
 * `isWithinCustomerServiceWindow` for the full argument.
 */
const DEFAULT_WINDOW_SAFETY_MARGIN_MS = 60 * 60 * 1000;
const MAX_WINDOW_SAFETY_MARGIN_MS = 12 * 60 * 60 * 1000;

/** Sanity bounds for a Meta-supplied inbound timestamp. */
const META_TIMESTAMP_FLOOR_MS = Date.UTC(2018, 0, 1);
const META_TIMESTAMP_MAX_SKEW_MS = 5 * 60 * 1000;

/** Read an env var, treating empty/whitespace-only as unset. */
const readEnv = (name: string): string | undefined => {
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readIntEnv = (name: string, fallback: number, min: number, max: number): number => {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    logger.warn(`[WhatsApp Config] ${name}="${raw}" is out of range (${min}-${max}); using ${fallback}.`);
    return fallback;
  }
  return parsed;
};

/** One warning per process, not one per send. */
let warnedAboutDefaultTemplateVars = false;

export const whatsappConfig = {
  get accessToken(): string | undefined {
    return readEnv('WHATSAPP_ACCESS_TOKEN');
  },
  get phoneNumberId(): string | undefined {
    return readEnv('WHATSAPP_PHONE_NUMBER_ID');
  },
  get appSecret(): string | undefined {
    return readEnv('WHATSAPP_APP_SECRET');
  },
  get webhookVerifyToken(): string | undefined {
    return readEnv('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
  },
  get apiVersion(): string {
    const configured = readEnv('WHATSAPP_API_VERSION');
    if (!configured) return DEFAULT_GRAPH_API_VERSION;
    if (!GRAPH_API_VERSION_PATTERN.test(configured)) {
      logger.error(
        `[WhatsApp Config] WHATSAPP_API_VERSION="${configured}" is not a valid Graph version ` +
          `(expected e.g. "v23.0"); falling back to ${DEFAULT_GRAPH_API_VERSION}.`
      );
      return DEFAULT_GRAPH_API_VERSION;
    }
    return configured;
  },
  get requestTimeoutMs(): number {
    return readIntEnv('WHATSAPP_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 60_000);
  },
  /**
   * How much of the 24h window to give up in exchange for not mistakenly
   * treating a closed window as open. Set to 0 to use the full 24h.
   */
  get windowSafetyMarginMs(): number {
    return readIntEnv(
      'WHATSAPP_WINDOW_SAFETY_MARGIN_MS',
      DEFAULT_WINDOW_SAFETY_MARGIN_MS,
      0,
      MAX_WINDOW_SAFETY_MARGIN_MS
    );
  },
  get authServiceUrl(): string {
    return readEnv('AUTH_SERVICE_URL') || 'http://localhost:3001';
  },
  /** Digits only, no '+'. Optional — when unset, no country code is ever inferred. */
  get defaultCountryCode(): string | undefined {
    const raw = readEnv('WHATSAPP_DEFAULT_COUNTRY_CODE');
    if (!raw) return undefined;
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 1 && digits.length <= 4 ? digits : undefined;
  },

  // ── Business-initiated template (needed outside the 24h window) ──
  get notificationTemplateName(): string | undefined {
    return readEnv('WHATSAPP_NOTIFICATION_TEMPLATE_NAME');
  },
  get notificationTemplateLanguage(): string | undefined {
    return readEnv('WHATSAPP_NOTIFICATION_TEMPLATE_LANGUAGE');
  },
  /** How many body variables the approved template declares: 1 or 2. */
  get notificationTemplateParamCount(): 1 | 2 {
    return readIntEnv('WHATSAPP_NOTIFICATION_TEMPLATE_PARAM_COUNT', 2, 1, 2) as 1 | 2;
  },

  // ── Post-class report template (carries the summary PDF) ──
  /**
   * The template a parent receives after a class. Separate from the generic
   * notification template because it is the only one with a DOCUMENT header,
   * and because its variables are report-specific — reusing the generic
   * two-variable template here would send Meta the wrong parameter count.
   */
  get reportTemplateName(): string | undefined {
    return readEnv('WHATSAPP_REPORT_TEMPLATE_NAME');
  },
  get reportTemplateLanguage(): string {
    return readEnv('WHATSAPP_REPORT_TEMPLATE_LANGUAGE') || 'en';
  },
  /**
   * Whether the approved template declares a DOCUMENT header. When it does the
   * PDF rides along with the message; when it does not, the PDF is sent as a
   * separate document message and this template carries only text.
   */
  get reportTemplateHasDocumentHeader(): boolean {
    return readEnv('WHATSAPP_REPORT_TEMPLATE_HEADER') !== 'none';
  },
  /**
   * Ordered names of the template's {{1}}, {{2}}, ... body variables.
   *
   * Meta matches body parameters BY POSITION, and a mismatch in count is a hard
   * 132000 rather than a partial send — so the order has to be stated somewhere,
   * and it belongs in configuration rather than in code: the template can be
   * edited in Meta's console at any time without a deploy. Names are resolved
   * against the variable map the caller supplies.
   */
  get reportTemplateVariables(): string[] {
    const raw = readEnv('WHATSAPP_REPORT_TEMPLATE_VARIABLES');
    if (!raw) {
      /* The default is four names, and a template expecting any other count
       * rejects the whole message with "localizable_params (4) does not match".
       * That error names the count but not the reason, and four is also what
       * the previous configuration held — so the two causes look identical
       * from the outside. Say plainly which one this is. */
      if (!warnedAboutDefaultTemplateVars) {
        warnedAboutDefaultTemplateVars = true;
        logger.warn(
          '[WhatsApp] WHATSAPP_REPORT_TEMPLATE_VARIABLES is not set in this process, so the report ' +
            'template is falling back to its four built-in variables. If the approved template expects a ' +
            'different number, every send fails at Meta. Check that the root .env is reachable from this ' +
            'service and that the process was restarted after the file changed.'
        );
      }
      return ['studentName', 'sessionTitle', 'classDate', 'mentorName'];
    }
    return raw
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  },
  /** Uploading a few hundred KB needs more headroom than a JSON POST. */
  get mediaUploadTimeoutMs(): number {
    return readIntEnv('WHATSAPP_MEDIA_TIMEOUT_MS', 60_000, 5_000, 300_000);
  },

  // ── Auto-reply content (no placeholders may ever reach a real family) ──
  get autoReplyEnabled(): boolean {
    return readEnv('WHATSAPP_AUTOREPLY_ENABLED') !== 'false';
  },
  get brandName(): string {
    return readEnv('WHATSAPP_BRAND_NAME') || 'FutureSpark';
  },
  get businessHours(): string | undefined {
    return readEnv('WHATSAPP_BUSINESS_HOURS');
  },
  get contactPhone(): string | undefined {
    return readEnv('WHATSAPP_CONTACT_PHONE');
  },
  get contactEmail(): string | undefined {
    return readEnv('WHATSAPP_CONTACT_EMAIL');
  },
  get contactWebsite(): string | undefined {
    return readEnv('WHATSAPP_CONTACT_WEBSITE');
  },
  get locationAddress(): string | undefined {
    return readEnv('WHATSAPP_LOCATION_ADDRESS');
  },
  get locationMapsUrl(): string | undefined {
    return readEnv('WHATSAPP_LOCATION_MAPS_URL');
  },
};

/* ══════════════════════════════════════════════════════════════════════════
 * STARTUP VALIDATION — fail loudly, never fall back to a test credential
 * ═══════════════════════════════════════════════════════════════════════ */

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/** Hard requirements. Without any of these the integration cannot run safely. */
export const REQUIRED_WHATSAPP_ENV = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
] as const;

/** Returns a list of fatal configuration problems (empty when healthy). */
export const getWhatsAppConfigErrors = (): string[] => {
  const errors: string[] = [];

  if (!whatsappConfig.accessToken) {
    errors.push(
      'WHATSAPP_ACCESS_TOKEN is not set. Meta Business Manager -> System Users -> generate a ' +
        'non-expiring System User token with whatsapp_business_messaging + whatsapp_business_management.'
    );
  }
  if (!whatsappConfig.phoneNumberId) {
    errors.push(
      'WHATSAPP_PHONE_NUMBER_ID is not set. App Dashboard -> WhatsApp -> API Setup -> the phone ' +
        'number ID of your registered production number. There is no fallback: sending from the ' +
        'wrong number is worse than not sending.'
    );
  } else if (whatsappConfig.phoneNumberId === SANDBOX_PHONE_NUMBER_ID && isProduction()) {
    errors.push(
      `WHATSAPP_PHONE_NUMBER_ID is still the sandbox test number id (${SANDBOX_PHONE_NUMBER_ID}). ` +
        'Set the production phone number ID before booting with NODE_ENV=production.'
    );
  }
  if (!whatsappConfig.appSecret) {
    errors.push(
      'WHATSAPP_APP_SECRET is not set. Without it X-Hub-Signature-256 cannot be verified and the ' +
        'webhook is an unauthenticated outbound-messaging primitive. ' +
        'App Dashboard -> Settings -> Basic -> App Secret.'
    );
  }
  if (!whatsappConfig.webhookVerifyToken) {
    errors.push(
      'WHATSAPP_WEBHOOK_VERIFY_TOKEN is not set. Choose a random secret and paste the same value ' +
        'into App Dashboard -> WhatsApp -> Configuration -> Verify token.'
    );
  } else if (whatsappConfig.webhookVerifyToken === LEAKED_WEBHOOK_VERIFY_TOKEN) {
    errors.push(
      'WHATSAPP_WEBHOOK_VERIFY_TOKEN is the value that was hardcoded in the PUBLIC repository. ' +
        'Rotate it in Meta and in the environment.'
    );
  }

  return errors;
};

/** Non-fatal problems worth shouting about at boot. */
const getWhatsAppConfigWarnings = (): string[] => {
  const warnings: string[] = [];

  if (!whatsappConfig.notificationTemplateName || !whatsappConfig.notificationTemplateLanguage) {
    warnings.push(
      'WHATSAPP_NOTIFICATION_TEMPLATE_NAME / WHATSAPP_NOTIFICATION_TEMPLATE_LANGUAGE are not both ' +
        'set. Any notification to a recipient outside the 24-hour customer service window will be ' +
        'REFUSED (not silently rejected by Meta with 131047). Approve a UTILITY template in the ' +
        'production WABA and configure it.'
    );
  }
  if (!whatsappConfig.defaultCountryCode) {
    warnings.push(
      'WHATSAPP_DEFAULT_COUNTRY_CODE is not set. Stored phone numbers without a country code will ' +
        'be rejected rather than guessed.'
    );
  }
  if (whatsappConfig.phoneNumberId === SANDBOX_PHONE_NUMBER_ID) {
    warnings.push(
      `WHATSAPP_PHONE_NUMBER_ID is the sandbox test number id (${SANDBOX_PHONE_NUMBER_ID}).`
    );
  }
  return warnings;
};

/**
 * Boot-time gate. Call once from `app.ts` AFTER dotenv has run.
 * In production a missing credential throws and the process refuses to start.
 * Elsewhere it logs a loud banner and leaves the integration disabled — it
 * never falls back to a sandbox value.
 */
export const assertWhatsAppStartupConfig = (): void => {
  const errors = getWhatsAppConfigErrors();
  const warnings = getWhatsAppConfigWarnings();

  for (const warning of warnings) {
    logger.warn(`[WhatsApp Config] ${warning}`);
  }

  if (errors.length === 0) {
    logger.info(
      `[WhatsApp Config] OK — Graph ${whatsappConfig.apiVersion}, phone number id ` +
        `...${String(whatsappConfig.phoneNumberId).slice(-6)}, signature verification enabled.`
    );
    return;
  }

  const banner =
    'WHATSAPP_CONFIG_INVALID — the WhatsApp integration is not safely configured:\n' +
    errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n');

  if (isProduction()) {
    // Refuse to boot rather than run against production WhatsApp half-configured.
    throw new Error(banner);
  }

  logger.error(
    `[WhatsApp Config] ${banner}\n` +
      '  => Outbound WhatsApp is DISABLED and the webhook will reject all POSTs until fixed. ' +
      'With NODE_ENV=production this process would refuse to start.'
  );
};

/** True when outbound sending is safe to attempt at all. */
export const isWhatsAppConfigured = (): boolean =>
  !!whatsappConfig.accessToken && !!whatsappConfig.phoneNumberId;

/* ══════════════════════════════════════════════════════════════════════════
 * PII-SAFE LOGGING
 * ═══════════════════════════════════════════════════════════════════════ */

/** Never log a full phone number: these belong to real families. */
export const maskPhone = (phone?: string | null): string => {
  if (!phone) return '<none>';
  const digits = String(phone).replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `****${digits.slice(-4)}`;
};

/* ══════════════════════════════════════════════════════════════════════════
 * FAILURE CLASSIFICATION
 * ═══════════════════════════════════════════════════════════════════════ */

export type WhatsAppFailureKind =
  | 'NOT_CONFIGURED'
  | 'INVALID_RECIPIENT'
  | 'TOKEN_INVALID'
  | 'WINDOW_CLOSED'
  | 'TEMPLATE_NOT_CONFIGURED'
  | 'TEMPLATE_MISCONFIGURED'
  | 'UNDELIVERABLE'
  | 'NOT_IN_ALLOWLIST'
  | 'NUMBER_NOT_REGISTERED'
  | 'RATE_LIMITED'
  | 'ACCOUNT_RESTRICTED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_META_ERROR';

export interface WhatsAppSendResult {
  success: boolean;
  /** Meta's message id, present only on success. */
  messageId?: string;
  /** Which channel actually went out. */
  channel?: 'text' | 'interactive' | 'template' | 'document';
  failureKind?: WhatsAppFailureKind;
  /** Human-readable, actionable. Safe to log and to return to an internal caller. */
  error?: string;
  errorCode?: number;
  errorSubcode?: number;
  fbtraceId?: string;
  /** True when a retry with backoff could plausibly succeed. */
  retryable?: boolean;
}

/** Meta OAuth errors: 190 plus its expiry/invalidation subcodes. */
const TOKEN_ERROR_SUBCODES = new Set([458, 459, 460, 463, 464, 467, 492]);
const TEMPLATE_ERROR_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069]);
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);

const classifyMetaError = (
  httpStatus: number,
  code: number | undefined,
  subcode: number | undefined
): { kind: WhatsAppFailureKind; retryable: boolean } => {
  if (code === 190 || (subcode !== undefined && TOKEN_ERROR_SUBCODES.has(subcode)) || httpStatus === 401) {
    return { kind: 'TOKEN_INVALID', retryable: false };
  }
  // Not retryable AS A TEXT SEND — but `sendBusinessInitiatedMessage` retries
  // it once as a template, which is the only thing Meta will accept here.
  if (code === WINDOW_CLOSED_ERROR_CODE) return { kind: 'WINDOW_CLOSED', retryable: false };
  if (code === 131026) return { kind: 'UNDELIVERABLE', retryable: false };
  if (code === 131030) return { kind: 'NOT_IN_ALLOWLIST', retryable: false };
  if (code === 133010) return { kind: 'NUMBER_NOT_REGISTERED', retryable: false };
  if (code === 131031 || code === 368) return { kind: 'ACCOUNT_RESTRICTED', retryable: false };
  if (code !== undefined && TEMPLATE_ERROR_CODES.has(code)) {
    return { kind: 'TEMPLATE_MISCONFIGURED', retryable: false };
  }
  if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || httpStatus === 429 || httpStatus >= 500) {
    return { kind: 'RATE_LIMITED', retryable: true };
  }
  return { kind: 'UNKNOWN_META_ERROR', retryable: false };
};

/**
 * Remediation text per failure kind, so a lapsed token reads as a lapsed token
 * in the log instead of as a generic send failure.
 */
const remediationFor = (kind: WhatsAppFailureKind): string => {
  switch (kind) {
    case 'TOKEN_INVALID':
      return 'WHATSAPP_ACCESS_TOKEN is expired, revoked or invalid. Regenerate a non-expiring ' +
        'System User token in Meta Business Manager and redeploy. ALL WhatsApp delivery is down until then.';
    case 'WINDOW_CLOSED':
      return 'The 24-hour customer service window is closed for this recipient; only an approved ' +
        'template may be sent. Check WHATSAPP_NOTIFICATION_TEMPLATE_NAME/LANGUAGE.';
    case 'TEMPLATE_MISCONFIGURED':
      return 'The template name, language code or parameter count does not match an APPROVED ' +
        'template in the production WABA. "en" and "en_US" are different templates to Meta.';
    case 'UNDELIVERABLE':
      return 'Meta could not deliver to this number — it is probably not a WhatsApp account or is ' +
        'missing a country code.';
    case 'NOT_IN_ALLOWLIST':
      return 'Recipient is not in the sandbox allowlist — this means the SANDBOX number is still ' +
        'configured. Set the production WHATSAPP_PHONE_NUMBER_ID.';
    case 'NUMBER_NOT_REGISTERED':
      return 'The configured phone number ID has not been registered with the Cloud API ' +
        '(POST /{phone-number-id}/register with a two-step PIN).';
    case 'RATE_LIMITED':
      return 'Throttled or over the messaging tier ceiling. Retry with exponential backoff.';
    case 'ACCOUNT_RESTRICTED':
      return 'The WhatsApp Business account or number is restricted. Page the on-call and check ' +
        'quality rating in Business Manager.';
    default:
      return '';
  }
};

/* ══════════════════════════════════════════════════════════════════════════
 * PHONE NUMBER HANDLING
 * ═══════════════════════════════════════════════════════════════════════ */

export interface NormalizedPhone {
  ok: boolean;
  /** E.164 digits with no leading '+', ready for the Graph API. */
  value?: string;
  reason?: string;
}

/**
 * Legacy helper, kept because the payload builders below still use it.
 * Prefer `normalizePhone` — this one does not validate.
 */
const stripToDigits = (phone: string): string => {
  let cleaned = String(phone).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  cleaned = cleaned.replace(/\D/g, '');
  // International dialling prefix, e.g. "0044..." -> "44..."
  if (cleaned.startsWith('00')) cleaned = cleaned.slice(2);
  return cleaned;
};

/**
 * Strict-ish E.164 normalisation.
 *
 * A number with no country code is REJECTED unless WHATSAPP_DEFAULT_COUNTRY_CODE
 * is explicitly configured — guessing a country code can deliver a real family's
 * notification to a stranger in another country.
 */
export const normalizePhone = (phone: string | null | undefined): NormalizedPhone => {
  if (!phone) return { ok: false, reason: 'No phone number supplied' };

  let digits = stripToDigits(phone);
  if (digits.length === 0) return { ok: false, reason: 'Phone number contains no digits' };

  const cc = whatsappConfig.defaultCountryCode;
  if (cc && digits.length <= 10 && !digits.startsWith(cc)) {
    // Looks like a national-format number and we have an explicit policy for it.
    logger.warn(
      `[WhatsApp Service] Phone ${maskPhone(digits)} looks national; prefixing configured ` +
        `country code +${cc}. Store numbers in E.164 to avoid this inference.`
    );
    digits = `${cc}${digits}`;
  }

  if (digits.length < 8 || digits.length > 15) {
    return {
      ok: false,
      reason:
        `Phone number ${maskPhone(digits)} is not valid E.164 (${digits.length} digits). ` +
        'Store recipient numbers with a country code, or set WHATSAPP_DEFAULT_COUNTRY_CODE.',
    };
  }

  return { ok: true, value: digits };
};

/**
 * Every stored representation the same subscriber might appear under, so the
 * 24-hour-window lookup does not miss because inbound rows hold Meta's `wa_id`
 * (full international digits) while an outbound target came from a profile
 * stored in national format.
 */
const phoneMatchCandidates = (digits: string): string[] => {
  const candidates = new Set<string>([digits, `+${digits}`]);
  const cc = whatsappConfig.defaultCountryCode;
  if (cc) {
    if (digits.startsWith(cc)) candidates.add(digits.slice(cc.length));
    else candidates.add(`${cc}${digits}`);
  }
  return [...candidates].filter((c) => c.length > 0);
};

/* ══════════════════════════════════════════════════════════════════════════
 * INBOUND TIMESTAMPS
 *
 * Meta puts a `timestamp` on every inbound message: the moment the USER sent
 * it, as UNIX SECONDS in a string ("1754899200"). That is the only value the
 * 24-hour window may legitimately be measured from.
 *
 * `WhatsAppMessage.createdAt` defaults to now() — i.e. the moment OUR webhook
 * handler ran. Meta retries undelivered webhooks for up to ~7 days, so a
 * backlog replay writes rows whose createdAt is hours or days later than the
 * message they describe, and the window then reads OPEN when it is CLOSED.
 * That is a fail-OPEN bug: the send is attempted, Meta rejects it with 131047,
 * and (before this change) the notification was dropped.
 *
 * There is NO dedicated timestamp column on WhatsAppMessage and adding one is
 * out of scope, but `createdAt` is itself the right home: Prisma lets an
 * explicit value override `@default(now())` on create, so the writer can simply
 * pass Meta's time and every existing reader — including the window query
 * below — becomes correct with no schema change and no query change.
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Convert Meta's inbound `message.timestamp` into a Date suitable for
 * `WhatsAppMessage.createdAt`.
 *
 * Returns null when the value is missing or implausible, in which case the
 * caller should omit the field and let `@default(now())` apply. A future-dated
 * timestamp is rejected rather than trusted: it would hold the customer service
 * window open past its real expiry, which is the exact failure mode this
 * function exists to prevent.
 */
export const metaTimestampToDate = (raw: unknown): Date | null => {
  if (raw === null || raw === undefined) return null;

  const seconds =
    typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const ms = seconds * 1000;
  if (ms < META_TIMESTAMP_FLOOR_MS) return null;
  if (ms > Date.now() + META_TIMESTAMP_MAX_SKEW_MS) {
    logger.warn(
      `[WhatsApp Service] Ignoring future-dated inbound timestamp ${String(raw)}; ` +
        'falling back to insert time so the 24h window cannot be held open artificially.'
    );
    return null;
  }

  return new Date(ms);
};

/**
 * The `createdAt` value an inbound WhatsAppMessage row should be written with.
 * Spread into the Prisma `create` data:
 *
 *   await db.whatsAppMessage.create({
 *     data: { messageId, from, ..., ...inboundCreatedAt(message.timestamp) },
 *   });
 *
 * Yields `{}` when Meta's timestamp is unusable, so `@default(now())` stands.
 */
export const inboundCreatedAt = (raw: unknown): { createdAt?: Date } => {
  const at = metaTimestampToDate(raw);
  return at ? { createdAt: at } : {};
};

/* ══════════════════════════════════════════════════════════════════════════
 * HTTP
 * ═══════════════════════════════════════════════════════════════════════ */

/** fetch with a hard timeout — an unbounded call can stall a DB transaction upstream. */
const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A filename safe to put in a Content-Disposition header and in front of a
 * parent. Quotes and CR/LF would break the multipart framing outright; the rest
 * is trimmed because WhatsApp truncates long names in the chat bubble anyway.
 */
const sanitizeFileName = (name: string): string => {
  const cleaned = String(name ?? '')
    .replace(/[\r\n"\\]/g, '')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'report.pdf';
};

type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; data: Buffer };

/** Assemble a multipart/form-data body as exact bytes. See `uploadMedia`. */
const buildMultipartBody = (boundary: string, parts: MultipartPart[]): Buffer => {
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));

    if ('data' in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
          'utf8'
        )
      );
      chunks.push(part.data);
      chunks.push(Buffer.from('\r\n', 'utf8'));
    } else {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`, 'utf8')
      );
    }
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
};

export const whatsappService = {
  /**
   * Resolve a recipient's phone number by calling the auth-service.
   * Checks parent account profiles first, then falls back to general user details.
   */
  async resolveUserPhoneNumber(recipientId: string): Promise<string | null> {
    const timeout = whatsappConfig.requestTimeoutMs;
    try {
      // 1. Try to fetch as parent/customer account
      const parentUrl = `${whatsappConfig.authServiceUrl}/users/customers/${recipientId}`;
      logger.info(`[WhatsApp Service] Resolving phone for recipientId: ${recipientId}`);
      const parentRes = await fetchWithTimeout(parentUrl, { method: 'GET' }, timeout);
      if (parentRes.ok) {
        const body = (await parentRes.json()) as any;
        const parent = body?.data;
        if (parent?.profiles && parent.profiles.length > 0) {
          for (const profile of parent.profiles) {
            if (profile.phone) {
              logger.info(
                `[WhatsApp Service] Resolved phone from parent profile: ${maskPhone(profile.phone)}`
              );
              return profile.phone;
            }
          }
        }
      }

      // 2. Fallback to standard user check
      const userUrl = `${whatsappConfig.authServiceUrl}/users/${recipientId}`;
      const userRes = await fetchWithTimeout(userUrl, { method: 'GET' }, timeout);
      if (userRes.ok) {
        const body = (await userRes.json()) as any;
        const user = body?.data;
        if (user?.phone) {
          logger.info(`[WhatsApp Service] Resolved phone from user details: ${maskPhone(user.phone)}`);
          return user.phone;
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
   * Kept for backwards compatibility; `normalizePhone` is the validating version.
   */
  sanitizePhoneNumber(phone: string): string {
    return stripToDigits(phone);
  },

  /* ── 24-hour customer service window ─────────────────────────────────
   * Free-form messages (text / interactive / media) are only deliverable
   * while the window is open; it opens when the USER messages the business
   * and expires 24h after their most recent message. Outside it Meta rejects
   * with 131047 and only an approved template may be sent.
   *
   * Computed from the existing WhatsAppMessage rows — no migration needed.
   * Deliberate choices:
   *   - `createdAt`, never `updatedAt`: status webhooks mutate rows and
   *     @updatedAt would move with them, faking an open window.
   *   - No INBOUND row => CLOSED. Inbound history only exists from when the
   *     webhook went live, so "unknown" must fail safe, not fail open.
   *   - A safety margin is subtracted from the 24h. `createdAt` is only equal
   *     to the user's real send time if the webhook writer stamped it with
   *     Meta's `message.timestamp` (see `inboundCreatedAt`); for any row
   *     written before that wiring exists, createdAt is webhook-receipt time,
   *     which is >= the true time. Every millisecond of that skew is
   *     fail-OPEN, so the margin buys back the ordinary case (a retried or
   *     backlogged delivery arriving minutes-to-an-hour late) at the cost of
   *     the last hour of a window people rarely use. It does NOT cover a
   *     multi-day Meta backlog — the 131047 template fallback in
   *     `sendBusinessInitiatedMessage` is the backstop for that.
   * ── PROPOSED MIGRATION (not applied — no DDL from here) ──
   *   @@index([direction, from, createdAt]) on WhatsAppMessage.
   *   Without it this is a sequential scan on every business-initiated send.
   */
  async isWithinCustomerServiceWindow(phoneDigits: string): Promise<boolean> {
    try {
      const margin = Math.min(whatsappConfig.windowSafetyMarginMs, CUSTOMER_SERVICE_WINDOW_MS);
      const since = new Date(Date.now() - (CUSTOMER_SERVICE_WINDOW_MS - margin));

      const inbound = await db.whatsAppMessage.findFirst({
        where: {
          direction: 'INBOUND',
          from: { in: phoneMatchCandidates(phoneDigits) },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });

      if (!inbound) return false;

      const ageMinutes = Math.round((Date.now() - inbound.createdAt.getTime()) / 60_000);
      logger.info(
        `[WhatsApp Service] Window OPEN for ${maskPhone(phoneDigits)} — newest inbound row is ` +
          `${ageMinutes}m old (margin ${Math.round(margin / 60_000)}m). Note this is the row's ` +
          'createdAt, which equals the sender\'s real time only for rows stamped from Meta\'s timestamp.'
      );
      return true;
    } catch (error: any) {
      logger.error(
        `[WhatsApp Service] Window lookup failed for ${maskPhone(phoneDigits)}: ${error.message}. ` +
          'Treating the window as CLOSED (fail safe).'
      );
      return false;
    }
  },

  /**
   * THE business-initiated entry point. Anything not written in direct reply to
   * an inbound message must go through here, never straight to sendTextMessage.
   *
   * Inside the window  -> free-form text (not billed, richest formatting).
   * Outside the window -> the configured APPROVED template.
   * No template configured -> a hard, actionable failure. We do NOT attempt a
   * text send that Meta is guaranteed to reject with 131047.
   *
   * The window check is a local approximation (see
   * `isWithinCustomerServiceWindow`), so it can say OPEN when Meta disagrees.
   * When that happens Meta answers the text send with 131047 and we downgrade
   * to the template ONCE rather than dropping the notification.
   */
  async sendBusinessInitiatedMessage(params: {
    to: string;
    title: string;
    message: string;
    recipientId?: string;
    /**
     * Set false to forbid the 131047 -> template downgrade (the template is a
     * billed message). Defaults to true.
     */
    allowTemplateFallback?: boolean;
  }): Promise<WhatsAppSendResult> {
    const { title, message, recipientId } = params;
    const allowTemplateFallback = params.allowTemplateFallback !== false;

    const normalized = normalizePhone(params.to);
    if (!normalized.ok || !normalized.value) {
      const error = `Refusing to send: ${normalized.reason}`;
      logger.error(`[WhatsApp Service] WHATSAPP_SEND_REFUSED INVALID_RECIPIENT — ${error}`);
      return { success: false, failureKind: 'INVALID_RECIPIENT', error, retryable: false };
    }
    const to = normalized.value;

    const windowOpen = await this.isWithinCustomerServiceWindow(to);

    if (windowOpen) {
      logger.info(
        `[WhatsApp Service] 24h window OPEN for ${maskPhone(to)} — sending free-form text.`
      );
      const textResult = await this.sendTextMessage(to, `🔔 *${title}*\n\n${message}`, recipientId);

      if (textResult.success) return textResult;

      const windowActuallyClosed =
        textResult.failureKind === 'WINDOW_CLOSED' ||
        textResult.errorCode === WINDOW_CLOSED_ERROR_CODE;

      // Any other failure (bad token, unreachable number, network) is not
      // fixed by re-sending as a template, and re-sending would risk a
      // duplicate. Return it untouched.
      if (!windowActuallyClosed) return textResult;

      if (!allowTemplateFallback) {
        logger.error(
          `[WhatsApp Service] WHATSAPP_WINDOW_MISJUDGED for ${maskPhone(to)} — Meta rejected the ` +
            'free-form text with 131047 and the template fallback is disabled for this call. ' +
            'Notification was NOT delivered.'
        );
        return textResult;
      }

      logger.warn(
        `[WhatsApp Service] WHATSAPP_WINDOW_MISJUDGED for ${maskPhone(to)} — our window check said ` +
          'OPEN but Meta rejected the text with 131047 (the window is really CLOSED). Downgrading ' +
          'to the approved template once. Recurring occurrences mean inbound rows are being ' +
          'stamped with webhook-receipt time rather than Meta\'s message.timestamp; consider ' +
          'raising WHATSAPP_WINDOW_SAFETY_MARGIN_MS.'
      );

      // Not a recursive call: this goes straight to the template branch and can
      // never re-enter the text path, so the downgrade happens at most once.
      return this.sendNotificationTemplate(to, title, message, recipientId, true);
    }

    return this.sendNotificationTemplate(to, title, message, recipientId, false);
  },

  /**
   * The template half of `sendBusinessInitiatedMessage`, shared by the
   * "window known closed" path and the 131047 downgrade path.
   *
   * `to` must already be normalized. This never calls back into
   * `sendBusinessInitiatedMessage`, which is what bounds the downgrade.
   */
  async sendNotificationTemplate(
    to: string,
    title: string,
    message: string,
    recipientId?: string,
    afterWindowClosedRejection = false
  ): Promise<WhatsAppSendResult> {
    const templateName = whatsappConfig.notificationTemplateName;
    const templateLanguage = whatsappConfig.notificationTemplateLanguage;

    if (!templateName || !templateLanguage) {
      const cause = afterWindowClosedRejection
        ? `Meta rejected the free-form text to ${maskPhone(to)} with 131047, so the 24h customer ` +
          'service window is CLOSED despite our check saying otherwise, and there is no approved ' +
          'template to fall back to. '
        : `24h customer service window is CLOSED for ${maskPhone(to)}, so a free-form text would be ` +
          'rejected by Meta (131047). ';
      const error =
        cause +
        'No approved template is configured: set WHATSAPP_NOTIFICATION_TEMPLATE_NAME and ' +
        'WHATSAPP_NOTIFICATION_TEMPLATE_LANGUAGE to a template that is APPROVED in the production ' +
        'WABA (the language code must match the approved translation exactly — "en" and "en_US" ' +
        'are different templates). Notification was NOT delivered.';
      logger.error(`[WhatsApp Service] WHATSAPP_SEND_REFUSED TEMPLATE_NOT_CONFIGURED — ${error}`);
      return { success: false, failureKind: 'TEMPLATE_NOT_CONFIGURED', error, retryable: false };
    }

    logger.info(
      `[WhatsApp Service] Sending template "${templateName}" (${templateLanguage}) to ${maskPhone(to)}` +
        `${afterWindowClosedRejection ? ' as a 131047 fallback' : ' — 24h window CLOSED'}.`
    );
    return this.sendTemplateMessage(
      to,
      templateName,
      templateLanguage,
      buildNotificationTemplateComponents(title, message),
      recipientId
    );
  },

  /**
   * Send a standard text message.
   * Only valid inside an open 24-hour window — either as a direct reply to an
   * inbound message, or via sendBusinessInitiatedMessage which checks first.
   */
  async sendTextMessage(to: string, text: string, recipientId?: string): Promise<WhatsAppSendResult> {
    const normalized = normalizePhone(to);
    if (!normalized.ok || !normalized.value) {
      logger.error(`[WhatsApp Service] WHATSAPP_SEND_REFUSED INVALID_RECIPIENT — ${normalized.reason}`);
      return { success: false, failureKind: 'INVALID_RECIPIENT', error: normalized.reason, retryable: false };
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalized.value,
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
  ): Promise<WhatsAppSendResult> {
    const normalized = normalizePhone(to);
    if (!normalized.ok || !normalized.value) {
      logger.error(`[WhatsApp Service] WHATSAPP_SEND_REFUSED INVALID_RECIPIENT — ${normalized.reason}`);
      return { success: false, failureKind: 'INVALID_RECIPIENT', error: normalized.reason, retryable: false };
    }
    if (buttons.length === 0) {
      return {
        success: false,
        failureKind: 'UNKNOWN_META_ERROR',
        error: 'Refusing to send an interactive message with no buttons.',
        retryable: false,
      };
    }

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
      to: normalized.value,
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
   * Upload a file to Meta and get back a media id.
   *
   * The id is the right way to attach a PDF: the alternative is a `link`, which
   * requires the file to be publicly readable over HTTPS for as long as Meta
   * takes to fetch it — and a child's class report is not something to put on an
   * open URL, even briefly. Ids are usable for 30 days, which comfortably
   * outlives one send.
   *
   * The multipart body is assembled by hand rather than via FormData/Blob so the
   * exact bytes, boundary and Content-Type are known: Meta rejects a body whose
   * `file` part has no filename, and a silently different serialisation is
   * painful to debug through the Graph API's generic error.
   */
  async uploadMedia(
    file: Buffer,
    fileName: string,
    mimeType = 'application/pdf'
  ): Promise<{ success: boolean; mediaId?: string; error?: string; failureKind?: WhatsAppFailureKind }> {
    if (!isWhatsAppConfigured()) {
      const missing = REQUIRED_WHATSAPP_ENV.filter((name) => !readEnv(name));
      const error = `WhatsApp is not configured; refusing to upload media. Missing: ${missing.join(', ') || 'see startup log'}.`;
      logger.error(`[WhatsApp Service] WHATSAPP_NOT_CONFIGURED — ${error}`);
      return { success: false, failureKind: 'NOT_CONFIGURED', error };
    }
    if (!file || file.length === 0) {
      return { success: false, failureKind: 'UNKNOWN_META_ERROR', error: 'Refusing to upload an empty file.' };
    }

    const safeName = sanitizeFileName(fileName);
    const boundary = `----futurespark${randomBytes(16).toString('hex')}`;
    const body = buildMultipartBody(boundary, [
      { name: 'messaging_product', value: 'whatsapp' },
      { name: 'type', value: mimeType },
      { name: 'file', filename: safeName, contentType: mimeType, data: file },
    ]);

    const url = `https://graph.facebook.com/${whatsappConfig.apiVersion}/${whatsappConfig.phoneNumberId}/media`;

    try {
      logger.info(
        `[WhatsApp Service] Uploading media "${safeName}" (${(file.length / 1024).toFixed(0)} KB, ${mimeType}) to Meta.`
      );
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${whatsappConfig.accessToken}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          // A Buffer is a perfectly valid fetch body at runtime. The cast is
          // purely a toolchain artefact: TypeScript 5.9 types Uint8Array
          // generically (`Uint8Array<ArrayBufferLike>`) while @types/node 20
          // still expects `Uint8Array<ArrayBuffer>`, so no byte-carrying type —
          // Buffer, Uint8Array or Blob — satisfies BodyInit under this pairing.
          // Confined to this one boundary; it asserts nothing about the bytes.
          body: body as unknown as BodyInit,
        },
        whatsappConfig.mediaUploadTimeoutMs
      );

      const responseBody = (await res.json().catch(() => ({}))) as any;

      if (!res.ok || !responseBody?.id) {
        const metaError = responseBody?.error ?? {};
        const { kind } = classifyMetaError(res.status, metaError.code, metaError.error_subcode);
        const detail = metaError?.error_data?.details || metaError?.message || `HTTP ${res.status}`;
        logger.error(
          `[WhatsApp Service] WHATSAPP_MEDIA_UPLOAD_FAILED [${kind}] http=${res.status} ` +
            `code=${metaError.code ?? '-'} fbtrace=${metaError.fbtrace_id ?? '-'} :: ${detail}`
        );
        return { success: false, failureKind: kind, error: detail };
      }

      logger.info(`[WhatsApp Service] Media uploaded. Media ID: ${responseBody.id}`);
      return { success: true, mediaId: String(responseBody.id) };
    } catch (err: any) {
      const aborted = err?.name === 'AbortError';
      const detail = aborted
        ? `Media upload timed out after ${whatsappConfig.mediaUploadTimeoutMs}ms`
        : err?.message || String(err);
      logger.error(`[WhatsApp Service] WHATSAPP_MEDIA_UPLOAD_FAILED [NETWORK_ERROR] :: ${detail}`);
      return { success: false, failureKind: 'NETWORK_ERROR', error: detail };
    }
  },

  /**
   * Send a document (our summary PDF) as a free-form message.
   * Only deliverable inside the 24-hour window — outside it, the document has to
   * ride on a template header instead. See `sendSessionReport`.
   */
  async sendDocumentMessage(
    to: string,
    document: { mediaId?: string; link?: string; fileName: string; caption?: string },
    recipientId?: string,
    classId?: string
  ): Promise<WhatsAppSendResult> {
    const normalized = normalizePhone(to);
    if (!normalized.ok || !normalized.value) {
      logger.error(`[WhatsApp Service] WHATSAPP_SEND_REFUSED INVALID_RECIPIENT — ${normalized.reason}`);
      return { success: false, failureKind: 'INVALID_RECIPIENT', error: normalized.reason, retryable: false };
    }
    if (!document.mediaId && !document.link) {
      return {
        success: false,
        failureKind: 'UNKNOWN_META_ERROR',
        error: 'Refusing to send a document with neither a media id nor a link.',
        retryable: false,
      };
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalized.value,
      type: 'document',
      document: {
        ...(document.mediaId ? { id: document.mediaId } : { link: document.link }),
        filename: sanitizeFileName(document.fileName),
        ...(document.caption ? { caption: document.caption.slice(0, 1024) } : {}),
      },
    };

    return this.sendMetaRequest(payload, 'document', `Document: ${document.fileName}`, recipientId, classId);
  },

  /**
   * Send a pre-approved template message.
   * `languageCode` has NO default: it must match the approved translation
   * exactly, and a wrong guess fails at send time with 132001.
   */
  async sendTemplateMessage(
    to: string,
    templateName: string,
    languageCode: string,
    components: any[] = [],
    recipientId?: string,
    classId?: string
  ): Promise<WhatsAppSendResult> {
    const normalized = normalizePhone(to);
    if (!normalized.ok || !normalized.value) {
      logger.error(`[WhatsApp Service] WHATSAPP_SEND_REFUSED INVALID_RECIPIENT — ${normalized.reason}`);
      return { success: false, failureKind: 'INVALID_RECIPIENT', error: normalized.reason, retryable: false };
    }
    if (!templateName || !languageCode) {
      const error = 'Refusing to send a template with no name or no language code.';
      logger.error(`[WhatsApp Service] WHATSAPP_SEND_REFUSED TEMPLATE_NOT_CONFIGURED — ${error}`);
      return { success: false, failureKind: 'TEMPLATE_NOT_CONFIGURED', error, retryable: false };
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalized.value,
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
    return this.sendMetaRequest(payload, 'template', description, recipientId, classId);
  },

  /**
   * Internal helper to make the API call to Meta and log to DB.
   * Always resolves — never throws — but the result now carries a typed
   * failure kind so callers can tell an expired token from a bad number.
   */
  async sendMetaRequest(
    payload: any,
    type: string,
    bodyContent: string,
    recipientId?: string,
    classId?: string
  ): Promise<WhatsAppSendResult> {
    const to = payload.to;

    // Config is checked BEFORE the pending row is written, so a misconfigured
    // deploy does not accumulate one 'failed' row per attempt.
    if (!isWhatsAppConfigured()) {
      const missing = REQUIRED_WHATSAPP_ENV.filter((name) => !readEnv(name));
      const error =
        'WhatsApp is not configured; refusing to send. Missing/invalid: ' +
        `${missing.join(', ') || 'see startup log'}. No fallback credentials exist by design.`;
      logger.error(`[WhatsApp Service] WHATSAPP_NOT_CONFIGURED — ${error}`);
      return { success: false, failureKind: 'NOT_CONFIGURED', error, retryable: false };
    }

    const url = `https://graph.facebook.com/${whatsappConfig.apiVersion}/${whatsappConfig.phoneNumberId}/messages`;

    // DB logging is best-effort — if the WhatsAppMessage table hasn't been
    // migrated on production yet, we still send the message and just warn.
    let dbLog: { id: string } | null = null;
    try {
      dbLog = await db.whatsAppMessage.create({
        data: {
          from: 'SYSTEM',
          to: to,
          direction: 'OUTBOUND',
          type: type,
          body: bodyContent,
          status: 'pending',
          recipientId: recipientId || null,
          classId: classId || null,
        },
      });
    } catch (dbErr: any) {
      logger.warn(
        `[WhatsApp Service] Could not create WhatsAppMessage log row (table may not be migrated yet): ${dbErr?.message ?? dbErr}. Message will still be sent.`
      );
    }

    try {
      logger.info(`[WhatsApp Service] Sending ${type} message to ${maskPhone(to)}`);
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${whatsappConfig.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
        whatsappConfig.requestTimeoutMs
      );

      const responseBody = (await res.json().catch(() => ({}))) as any;

      if (!res.ok) {
        const metaError = responseBody?.error ?? {};
        const errorCode: number | undefined =
          typeof metaError.code === 'number' ? metaError.code : undefined;
        const errorSubcode: number | undefined =
          typeof metaError.error_subcode === 'number' ? metaError.error_subcode : undefined;
        const fbtraceId: string | undefined =
          typeof metaError.fbtrace_id === 'string' ? metaError.fbtrace_id : undefined;
        const detail: string =
          metaError?.error_data?.details || metaError?.message || 'Unknown Meta error';

        const { kind, retryable } = classifyMetaError(res.status, errorCode, errorSubcode);
        const remediation = remediationFor(kind);

        // Stored in the free-text `error` column with a machine-greppable prefix,
        // because adding an errorCode column would require a migration.
        // ── PROPOSED MIGRATION (not applied): add
        //    errorCode Int?  errorSubcode Int?  failureKind String?
        //    to WhatsAppMessage so 131047 / 190 rates are countable in SQL.
        const storedError =
          `[${kind}] http=${res.status} code=${errorCode ?? '-'} subcode=${errorSubcode ?? '-'} ` +
          `fbtrace=${fbtraceId ?? '-'} :: ${detail}`;

        if (kind === 'TOKEN_INVALID' || kind === 'ACCOUNT_RESTRICTED') {
          // Distinct, greppable, alert-worthy — a lapsed token must not read as
          // "one message failed"; it means every notification is now failing.
          logger.error(
            `[WhatsApp Service] CRITICAL WHATSAPP_${kind} — ${detail} ` +
              `(code=${errorCode ?? '-'} subcode=${errorSubcode ?? '-'} fbtrace=${fbtraceId ?? '-'}). ${remediation}`
          );
        } else {
          logger.error(`[WhatsApp Service] WHATSAPP_SEND_FAILED ${storedError}${remediation ? ` :: ${remediation}` : ''}`);
        }

        if (dbLog) {
          await db.whatsAppMessage.update({
            where: { id: dbLog.id },
            data: { status: 'failed', error: storedError.slice(0, 1000) },
          }).catch(() => {});
        }

        return {
          success: false,
          failureKind: kind,
          error: `${detail}${remediation ? ` — ${remediation}` : ''}`,
          errorCode,
          errorSubcode,
          fbtraceId,
          retryable,
        };
      }

      const metaMessageId = responseBody?.messages?.[0]?.id;
      logger.info(`[WhatsApp Service] Message sent successfully. Meta ID: ${metaMessageId}`);

      if (dbLog) {
        await db.whatsAppMessage.update({
          where: { id: dbLog.id },
          data: {
            status: 'sent',
            messageId: metaMessageId,
          },
        }).catch(() => {});
      }

      return {
        success: true,
        messageId: metaMessageId,
        channel:
          type === 'template'
            ? 'template'
            : type === 'button'
              ? 'interactive'
              : type === 'document'
                ? 'document'
                : 'text',
      };
    } catch (err: any) {
      const aborted = err?.name === 'AbortError';
      const detail = aborted
        ? `Request to Meta timed out after ${whatsappConfig.requestTimeoutMs}ms`
        : err?.message || String(err);
      logger.error(`[WhatsApp Service] WHATSAPP_SEND_FAILED [NETWORK_ERROR] :: ${detail}`);
      if (dbLog) {
        await db.whatsAppMessage.update({
          where: { id: dbLog.id },
          data: { status: 'failed', error: `[NETWORK_ERROR] ${detail}`.slice(0, 1000) },
        }).catch(() => {});
      }
      return { success: false, failureKind: 'NETWORK_ERROR', error: detail, retryable: true };
    }
  },
};

/* ══════════════════════════════════════════════════════════════════════════
 * TEMPLATE COMPONENTS
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Meta rejects template parameters containing newlines, tabs or runs of 4+
 * spaces, so the notification body has to be flattened before it can be used
 * as a variable.
 */
const sanitizeTemplateParameter = (text: string): string => {
  const flattened = String(text ?? '').replace(/\s+/g, ' ').trim();
  return (flattened.length > 0 ? flattened : '-').slice(0, 1024);
};

/**
 * Body variables for the configured notification template.
 * The count must match the APPROVED template exactly or Meta returns 132000.
 */
export const buildNotificationTemplateComponents = (title: string, message: string): any[] => {
  const parameters =
    whatsappConfig.notificationTemplateParamCount === 1
      ? [sanitizeTemplateParameter(`${title}: ${message}`)]
      : [sanitizeTemplateParameter(title), sanitizeTemplateParameter(message)];

  return [
    {
      type: 'body',
      parameters: parameters.map((text) => ({ type: 'text', text })),
    },
  ];
};
