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

export interface LeadEventInput {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  /** The browser pixel's event id, for deduplication. Generated when absent. */
  eventId?: string | null;
  /** Optional attribution quality — pass through when a route has them. */
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  eventSourceUrl?: string | null;
}

interface MetaUserData {
  em?: string[];
  ph?: string[];
  fn?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
}

interface CapiEvent {
  event_name: 'Lead';
  event_time: number;
  event_id: string;
  action_source: 'website';
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
export const sendLeadEvent = async (input: LeadEventInput): Promise<string | null> => {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!pixelId || !accessToken || accessToken === 'YOUR_META_ACCESS_TOKEN') return null;

  const eventId = input.eventId?.trim() || crypto.randomUUID();

  const userData: MetaUserData = {};
  if (input.email?.trim()) userData.em = [hashEmail(input.email)];
  if (input.phone?.trim()) userData.ph = [hashPhone(input.phone)];
  if (input.firstName?.trim()) userData.fn = [hashName(input.firstName)];
  if (input.clientIpAddress) userData.client_ip_address = input.clientIpAddress;
  if (input.clientUserAgent) userData.client_user_agent = input.clientUserAgent;

  const body: CapiRequestBody = {
    data: [
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
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
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meta CAPI ${res.status}: ${text.slice(0, 300)}`);
  }
  return eventId;
};
