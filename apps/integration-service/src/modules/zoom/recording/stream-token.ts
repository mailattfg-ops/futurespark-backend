import crypto from 'crypto';

/**
 * Short-lived signed tokens for the public recording stream route.
 */

const TOKEN_VERSION = 'v1';

const signingKey = (): Buffer =>
  crypto
    .createHmac('sha256', process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-in-production')
    .update(`finquo-media-stream-${TOKEN_VERSION}`)
    .digest();

export const STREAM_TOKEN_TTL_SECONDS = 2 * 60 * 60;

const sign = (recordingId: string, exp: number): string =>
  crypto.createHmac('sha256', signingKey()).update(`${recordingId}:${exp}`).digest('hex');

export interface StreamToken {
  token: string;
  expiresAt: number;
}

export const createStreamToken = (
  recordingId: string,
  ttlSeconds: number = STREAM_TOKEN_TTL_SECONDS
): StreamToken => {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { token: `${exp}.${sign(recordingId, exp)}`, expiresAt: exp };
};

export const verifyStreamToken = (recordingId: string, token: unknown): boolean => {
  if (typeof token !== 'string' || !token.includes('.')) return false;

  const [expRaw, providedSig] = token.split('.', 2);
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  if (!providedSig) return false;

  const expectedSig = sign(recordingId, exp);
  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};
