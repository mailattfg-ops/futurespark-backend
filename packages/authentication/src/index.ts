import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getRedisClient } from '@futurespark/cache';
import type { JwtPayload, TokenPair } from '@futurespark/types';

// ── Configuration ──────────────────────────────────────────────

const getConfig = () => ({
  accessTokenSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-in-production',
  refreshTokenSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-in-production',
  accessTokenExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  refreshTokenExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  accessTokenTtlSeconds: parseInt(process.env.JWT_ACCESS_TTL_SECONDS || '900', 10), // 15 minutes
  internalHmacKey: process.env.INTERNAL_HMAC_KEY || 'dev-internal-hmac-key-change-in-production',
});

// ── JWT Token Management ───────────────────────────────────────

/**
 * Generate a unique JWT ID (jti) for token identification.
 */
const generateJti = (): string => crypto.randomUUID();

/**
 * Generate an access token containing the user's identity.
 */
export const generateAccessToken = (payload: Omit<JwtPayload, 'jti'>): { token: string; jti: string } => {
  const config = getConfig();
  const jti = generateJti();

  const token = jwt.sign(
    { ...payload, jti },
    config.accessTokenSecret,
    { expiresIn: config.accessTokenTtlSeconds }
  );

  return { token, jti };
};

/**
 * Generate a refresh token (opaque, long-lived).
 */
export const generateRefreshToken = (): string => {
  return crypto.randomBytes(64).toString('hex');
};

/**
 * Generate a full token pair (access + refresh).
 */
export const generateTokenPair = (payload: Omit<JwtPayload, 'jti'>): { tokens: TokenPair; jti: string } => {
  const config = getConfig();
  const { token: accessToken, jti } = generateAccessToken(payload);
  const refreshToken = generateRefreshToken();

  return {
    tokens: {
      accessToken,
      refreshToken,
      expiresIn: config.accessTokenTtlSeconds,
    },
    jti,
  };
};

/**
 * Verify and decode an access token.
 */
export const verifyAccessToken = (token: string): JwtPayload => {
  const config = getConfig();
  return jwt.verify(token, config.accessTokenSecret) as JwtPayload;
};

/**
 * Decode a token without verification (for inspection only).
 */
export const decodeToken = (token: string): JwtPayload | null => {
  const decoded = jwt.decode(token);
  return decoded as JwtPayload | null;
};

// ── JWT Blocklist (Redis-backed) ───────────────────────────────

/**
 * Block a token by its JTI. TTL should match the token's remaining lifespan.
 */
export const blockToken = async (jti: string, ttlSeconds: number): Promise<void> => {
  const redis = getRedisClient();
  await redis.set(`blacklist:${jti}`, 'blocked', 'EX', ttlSeconds);
};

export const isTokenBlocked = async (jti: string): Promise<boolean> => {
  try {
    const redis = getRedisClient();
    const result = await redis.exists(`blacklist:${jti}`);
    return result === 1;
  } catch (err: any) {
    console.error(`[Redis] Blocklist check failed, degrading gracefully (assuming not blocked): ${err.message}`);
    return false;
  }
};

// ── HMAC Internal Trust ────────────────────────────────────────

/**
 * Sign internal headers for gateway-to-service communication.
 * Returns headers to attach to the proxied request.
 */
export const signInternalHeaders = (userId: string, role: string): Record<string, string> => {
  const config = getConfig();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const data = `${userId}:${role}:${timestamp}`;
  const signature = crypto
    .createHmac('sha256', config.internalHmacKey)
    .update(data)
    .digest('hex');

  return {
    'x-user-id': userId,
    'x-user-role': role,
    'x-internal-timestamp': timestamp,
    'x-internal-signature': signature,
  };
};

/**
 * Verify HMAC-signed internal headers.
 * Returns the extracted identity if valid, throws if invalid.
 */
export const verifyInternalHeaders = (headers: Record<string, string | string[] | undefined>): { userId: string; role: string } => {
  const config = getConfig();
  const userId = headers['x-user-id'] as string;
  const role = headers['x-user-role'] as string;
  const timestamp = headers['x-internal-timestamp'] as string;
  const signature = headers['x-internal-signature'] as string;

  if (!userId || !role || !timestamp || !signature) {
    throw new Error('Missing internal authentication headers');
  }

  // Replay protection: reject headers older than 30 seconds
  const now = Math.floor(Date.now() / 1000);
  const headerTime = parseInt(timestamp, 10);
  if (isNaN(headerTime) || Math.abs(now - headerTime) > 30) {
    throw new Error('Internal authentication headers expired (replay protection)');
  }

  // Verify HMAC signature
  const data = `${userId}:${role}:${timestamp}`;
  const expectedSignature = crypto
    .createHmac('sha256', config.internalHmacKey)
    .update(data)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
    throw new Error('Internal authentication signature mismatch');
  }

  return { userId, role };
};

// ── Password Hashing ───────────────────────────────────────────

/**
 * Hash a password using scrypt with a random salt.
 */
export const hashPassword = (password: string): string => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

/**
 * Verify a password against a stored hash.
 */
export const verifyPassword = (password: string, storedHash: string): boolean => {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const computedHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computedHash, 'hex'));
};