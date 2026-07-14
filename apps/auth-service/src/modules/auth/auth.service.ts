import {
  hashPassword,
  verifyPassword,
  generateTokenPair,
  generateRefreshToken,
  verifyAccessToken,
  blockToken,
} from '@futurespark/authentication';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';
import { db } from '../../database/datasource';
import { RegisterInput, LoginInput } from './auth.schema';
import type { AuthResponse, TokenPair } from '@futurespark/types';

// ── Token Expiry Config ────────────────────────────────────────

const REFRESH_TOKEN_EXPIRY_DAYS = 7;
const ACCESS_TOKEN_TTL_SECONDS = 900; // 15 minutes

// ── Helpers ────────────────────────────────────────────────────

const buildAuthResponse = (user: any, tokens: TokenPair, jti: string): AuthResponse => ({
  user: {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
  },
  tokens,
});

// ── Auth Service ───────────────────────────────────────────────

export const authService = {
  /**
   * Register a new user, hash their password, and return a token pair.
   */
  async register(input: RegisterInput): Promise<AuthResponse> {
    // Check for existing user
    const existing = await db.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new AppError('Email is already registered', HTTP_STATUS.CONFLICT);
    }

    // Hash password and create user
    const passwordHash = hashPassword(input.password);
    const user = await db.user.create({
      data: {
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
      },
    });

    // Generate tokens
    const { tokens, jti } = generateTokenPair({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    // Store refresh token in DB
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    await db.refreshToken.create({
      data: {
        token: tokens.refreshToken,
        userId: user.id,
        expiresAt,
      },
    });

    return buildAuthResponse(user, tokens, jti);
  },

  /**
   * Authenticate a user by email and password. Returns a token pair.
   */
  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await db.user.findUnique({ where: { email: input.email } });
    if (!user) {
      throw new AppError('Invalid email or password', HTTP_STATUS.UNAUTHORIZED);
    }

    if (!user.isActive) {
      throw new AppError('Account is deactivated', HTTP_STATUS.FORBIDDEN);
    }

    const isPasswordValid = verifyPassword(input.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password', HTTP_STATUS.UNAUTHORIZED);
    }

    // Generate tokens
    const { tokens, jti } = generateTokenPair({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    // Store refresh token and update last login
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    await db.refreshToken.create({
      data: {
        token: tokens.refreshToken,
        userId: user.id,
        expiresAt,
      },
    });

    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return buildAuthResponse(user, tokens, jti);
  },

  /**
   * Rotate tokens: verify the refresh token, delete it, issue new pair.
   */
  async refresh(refreshToken: string): Promise<AuthResponse> {
    // Find the stored refresh token
    const storedToken = await db.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!storedToken) {
      throw new AppError('Invalid refresh token', HTTP_STATUS.UNAUTHORIZED);
    }

    if (storedToken.expiresAt < new Date()) {
      // Clean up expired token
      await db.refreshToken.delete({ where: { id: storedToken.id } });
      throw new AppError('Refresh token has expired', HTTP_STATUS.UNAUTHORIZED);
    }

    if (!storedToken.user.isActive) {
      throw new AppError('Account is deactivated', HTTP_STATUS.FORBIDDEN);
    }

    // Delete the old refresh token (rotation)
    await db.refreshToken.delete({ where: { id: storedToken.id } });

    // Generate a new token pair
    const { tokens, jti } = generateTokenPair({
      userId: storedToken.user.id,
      email: storedToken.user.email,
      role: storedToken.user.role,
    });

    // Store the new refresh token
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    await db.refreshToken.create({
      data: {
        token: tokens.refreshToken,
        userId: storedToken.user.id,
        expiresAt,
      },
    });

    return buildAuthResponse(storedToken.user, tokens, jti);
  },

  /**
   * Logout: block the access token JTI and delete the refresh token.
   */
  async logout(accessToken: string, refreshToken: string): Promise<void> {
    // Block the access token JTI in Redis
    try {
      const decoded = verifyAccessToken(accessToken);
      if (decoded.jti) {
        // Block for the remaining lifespan of the access token
        await blockToken(decoded.jti, ACCESS_TOKEN_TTL_SECONDS);
      }
    } catch {
      // Token may already be expired — still proceed to delete refresh token
    }

    // Delete the refresh token from DB
    const storedToken = await db.refreshToken.findUnique({
      where: { token: refreshToken },
    });

    if (storedToken) {
      await db.refreshToken.delete({ where: { id: storedToken.id } });
    }
  },
};
