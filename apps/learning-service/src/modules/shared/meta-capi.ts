import crypto from 'crypto';

/**
 * Meta Conversions API — the server-side twin of the browser pixel's
 * `track("Lead")`.
 *
 * The browser event is blind to ad-blockers and iOS privacy walls; this one
 * is not, because it leaves from here with the identifiers SHA-256-hashed.
 * The two are deduplicated by `event_id`: the form sends the id its pixel
 * used, and Meta collapses the pair into one Lead.
 *
 * This platform's lead save point is the Express learning-service (the
 * Next.js admin only proxies to the gateway), so the integration lives here
 * — same guarantees the spec asks of a Next route: fired only after the
 * database commit, never able to fail the enquiry, configured entirely from
 * the root `.env`, nothing exposed to any client.
 */

const GRAPH_VERSION = 'v23.0';

/**
 * What a public form's proxy can pass along so Meta can match the server
 * event to the browser that fired the pixel. All optional; the website's
 * Next route reads them from the visitor's request (the backend only ever
 * sees the proxy's IP and User-Agent, so it cannot read them itself).
 */
export interface LeadAttribution {
  /** The browser pixel's event id, so Meta deduplicates it against CAPI. */
  eventId?: string;
  clientIpAddress?: string;
  clientUserAgent?: string;
  /** The pixel's `_fbp` cookie — its browser id. */
  fbp?: string;
  /** The pixel's `_fbc` cookie — the click id of the ad that brought them. */
  fbc?: string;
  eventSourceUrl?: string;
}

const optionalString = (value: unknown, maxLength: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : undefined;

/** Pull the attribution fields off a request body: strings only, trimmed, length-capped. */
export const readLeadAttribution = (data: any): LeadAttribution => ({
  eventId: optionalString(data?.eventId, 100),
  clientIpAddress: optionalString(data?.clientIpAddress, 45),
  clientUserAgent: optionalString(data?.clientUserAgent, 512),
  fbp: optionalString(data?.fbp, 100),
  fbc: optionalString(data?.fbc, 300),
  eventSourceUrl: optionalString(data?.eventSourceUrl, 1024),
});

export interface LeadEventInput extends LeadAttribution {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  /** Our own id for the person — the lead row's id. Hashed before it leaves. */
  externalId?: string | null;
}

interface MetaUserData {
  em?: string[];
  ph?: string[];
  fn?: string[];
  external_id?: string;
  fbp?: string;
  fbc?: string;
  client_ip_address?: string;
  client_user_agent?: string;
}

/**
 * `website` is a person acting in a browser. `system_generated` is us telling
 * Meta something we concluded on our own — a lead our team later qualified.
 * Meta rejects any other value, including the plausible-looking 'crm'.
 */
type ActionSource = 'website' | 'system_generated';

interface CapiEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: ActionSource;
  event_source_url?: string;
  user_data: MetaUserData;
}

interface CapiRequestBody {
  data: CapiEvent[];
  test_event_code?: string;
}

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/* Meta's normalisation rules, applied BEFORE hashing — a hash of an
 * un-normalised value matches nothing on their side. */
const hashEmail = (email: string): string => sha256(email.trim().toLowerCase());
const hashPhone = (phone: string): string => sha256(phone.replace(/[^0-9]/g, ''));
const hashName = (name: string): string => sha256(name.trim().toLowerCase());

/**
 * Send one "Lead" event. Returns the event_id used, or null when CAPI is not
 * configured (absent env keys are a state, not an error — the platform ran
 * without this for months). Throws on a real Meta refusal so the CALLER's
 * try/catch can log it; callers must never let that throw reach the client.
 */
export const sendLeadEvent = async (
  input: LeadEventInput,
  options: { eventName?: string; actionSource?: ActionSource } = {}
): Promise<string | null> => {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!pixelId || !accessToken || accessToken === 'YOUR_META_ACCESS_TOKEN') return null;

  const eventName = options.eventName ?? 'Lead';
  const actionSource = options.actionSource ?? 'website';
  const eventId = input.eventId?.trim() || crypto.randomUUID();

  const userData: MetaUserData = {};
  if (input.email?.trim()) userData.em = [hashEmail(input.email)];
  if (input.phone?.trim()) userData.ph = [hashPhone(input.phone)];
  if (input.firstName?.trim()) userData.fn = [hashName(input.firstName)];
  if (input.externalId) userData.external_id = sha256(input.externalId);
  // fbp/fbc/IP/UA are matching keys, not identities: Meta wants them raw.
  if (input.fbp) userData.fbp = input.fbp;
  if (input.fbc) userData.fbc = input.fbc;
  if (input.clientIpAddress) userData.client_ip_address = input.clientIpAddress;
  if (input.clientUserAgent) userData.client_user_agent = input.clientUserAgent;

  const body: CapiRequestBody = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: actionSource,
        ...(input.eventSourceUrl ? { event_source_url: input.eventSourceUrl } : {}),
        user_data: userData,
      },
    ],
  };
  // Events Manager's test tool: set META_TEST_EVENT_CODE while verifying,
  // remove it for production traffic.
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Without this, a stalled connection sits on undici's ~5-minute default.
      // Ad attribution is never worth holding a request open that long.
      signal: AbortSignal.timeout(5000),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meta CAPI ${res.status}: ${text.slice(0, 300)}`);
  }
  return eventId;
};

/**
 * The signal that a lead turned out to be worth having.
 *
 * Sent when our team verifies a payment and the family enrols — days after the
 * form submission Meta already knows about. Without it Meta optimises for
 * people who fill forms; with it, for people who enrol.
 *
 * A CUSTOM event name, deliberately. Sending a second "Lead" would either be
 * discarded as a duplicate (same event_id) or double-count the conversion the
 * campaigns already optimise on (new event_id). `QualifiedLead` is a separate
 * signal, and the ad account points a custom conversion at it.
 *
 * Matching leans on what survives the days in between: hashed email, hashed
 * phone, our own lead id, and the click/browser ids captured at submission.
 * Never throws — an enrolment must not fail because Meta is unreachable.
 */
export const sendQualifiedLeadEvent = async (input: LeadEventInput): Promise<string | null> => {
  try {
    return await sendLeadEvent(
      // A fresh id: this is a different event from the submission, not a retry.
      { ...input, eventId: undefined },
      { eventName: QUALIFIED_LEAD_EVENT, actionSource: 'system_generated' }
    );
  } catch (err: any) {
    console.error('[Meta CAPI] QualifiedLead failed:', err?.message ?? err);
    return null;
  }
};

/** The custom conversion to create in Events Manager and optimise against. */
export const QUALIFIED_LEAD_EVENT = 'QualifiedLead';
