import crypto from 'crypto';

/**
 * Short-lived signed tokens for the public recording stream route.
 *
 * The stream endpoint cannot require an Authorization header: browsers do not
 * send one for `<video src>`, and neither `fetch` nor a service worker can add
 * it to a media element's range requests. So the route stays unauthenticated at
 * the gateway and authenticates on a signed token in the query string instead.
 *
 * Minting the token *is* the authenticated step — `GET /recordings/:id/media-token`
 * sits behind the gateway's JWT check, so only a signed-in user can obtain one,
 * and the token it hands back only ever unlocks that one recording, only for a
 * couple of hours. A leaked URL therefore exposes a single class for a short
 * window rather than the entire archive forever.
 */

const TOKEN_VERSION = 'v1';

/**
 * Derived rather than used directly, so a signature that somehow leaks can never
 * be replayed against anything that verifies real access tokens. Falls back to
 * the dev default only when JWT_ACCESS_SECRET is unset, which mirrors how the
 * rest of the platform behaves in local development.
 */
const signingKey = (): Buffer =>
  crypto
    .createHmac('sha256', process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-in-production')
    .update(`finquo-media-stream-${TOKEN_VERSION}`)
    .digest();

/** Long enough to watch a 90-minute class end to end without the link dying mid-seek. */
export const STREAM_TOKEN_TTL_SECONDS = 2 * 60 * 60;

const sign = (recordingId: string, exp: number): string =>
  crypto.createHmac('sha256', signingKey()).update(`${recordingId}:${exp}`).digest('hex');

export interface StreamToken {
  token: string;
  /** Epoch seconds, so a client can refresh before it lapses. */
  expiresAt: number;
}

export const createStreamToken = (
  recordingId: string,
  ttlSeconds: number = STREAM_TOKEN_TTL_SECONDS
): StreamToken => {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { token: `${exp}.${sign(recordingId, exp)}`, expiresAt: exp };
};

/**
 * True only for a well-formed, unexpired token issued for this exact recording.
 *
 * The recording id is part of the signed payload, so a token minted for one
 * class cannot be replayed against another.
 */
export const verifyStreamToken = (recordingId: string, token: unknown): boolean => {
  if (typeof token !== 'string' || !token.includes('.')) return false;

  const [expRaw, providedSig] = token.split('.', 2);
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  if (!providedSig) return false;

  const expectedSig = sign(recordingId, exp);
  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  // timingSafeEqual throws on a length mismatch, so guard before comparing.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};
