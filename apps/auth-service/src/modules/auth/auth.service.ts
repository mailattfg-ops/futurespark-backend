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
import { logger } from '@futurespark/logger';

// ── Token Expiry Config ────────────────────────────────────────

const REFRESH_TOKEN_EXPIRY_DAYS = parseInt(process.env.JWT_REFRESH_TTL_DAYS || '90', 10);
const ACCESS_TOKEN_TTL_SECONDS = parseInt(process.env.JWT_ACCESS_TTL_SECONDS || '2592000', 10); // 30 days default

// ── Helpers ────────────────────────────────────────────────────

const buildAuthResponse = (user: any, tokens: TokenPair, jti: string): AuthResponse => ({
  user: {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    // Without this the header falls back to initials on every fresh login,
    // making an uploaded profile photo look like it never saved.
    avatarUrl: user.avatarUrl ?? null,
    role: user.role?.name || user.role || 'STUDENT',
    requiresFtlReset: user.requiresFtlReset,
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
    const defaultRole = await db.role.findUnique({ where: { name: 'STUDENT' } });
    const user = await db.user.create({
      data: {
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        roleId: defaultRole?.id,
      },
      include: { role: true },
    });

    // Generate tokens
    const { tokens, jti } = generateTokenPair({
      userId: user.id,
      email: user.email,
      role: user.role?.name || 'STUDENT',
      requiresFtlReset: user.requiresFtlReset,
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
    // Helper for TLS 10054 resilience on remote database connections
    const withDbRetry = async <T>(fn: () => Promise<T>, retries = 3): Promise<T> => {
      let lastErr: any;
      for (let i = 0; i < retries; i++) {
        try {
          return await fn();
        } catch (err: any) {
          lastErr = err;
          if (err.message && (err.message.includes('10054') || err.message.includes('TLS') || err.message.includes('Can\'t reach database'))) {
            logger.warn(`[AuthService] Transient TLS connection reset. Retrying query ${i + 1}/${retries}...`);
            await new Promise((r) => setTimeout(r, 200 * (i + 1)));
          } else {
            throw err;
          }
        }
      }
      throw lastErr;
    };

    // 1. Try finding in User table (case-insensitive)
    const user = await withDbRetry(() => db.user.findFirst({
      where: { email: { equals: input.email, mode: 'insensitive' } },
      include: { role: true },
    }));

    let account: any = null;
    let role = '';
    let type: 'user' | 'parent' | 'student' = 'user';

    if (user) {
      account = user;
      role = user.role?.name || 'STUDENT';
      type = 'user';
    } else {
      // 2. Try finding in ParentAccount table (case-insensitive)
      const parent = await withDbRetry(() => db.parentAccount.findFirst({
        where: { email: { equals: input.email, mode: 'insensitive' } },
        include: { profiles: true },
      }));
      if (parent) {
        account = parent;
        const firstProfile = parent.profiles[0];
        account.firstName = firstProfile?.firstName || 'Parent';
        account.lastName = firstProfile?.lastName || 'Account';
        role = 'PARENT';
        type = 'parent';
      } else {
        // 3. Try finding in Student table (case-insensitive)
        const student = await withDbRetry(() => db.student.findFirst({
          where: { email: { equals: input.email, mode: 'insensitive' } },
        }));
        if (student) {
          account = student;
          role = 'STUDENT';
          type = 'student';
        }
      }
    }

    if (!account) {
      throw new AppError('Invalid email or password', HTTP_STATUS.UNAUTHORIZED);
    }

    if (!account.isActive) {
      throw new AppError('Account is deactivated', HTTP_STATUS.FORBIDDEN);
    }

    const isPasswordValid = verifyPassword(input.password, account.passwordHash);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password', HTTP_STATUS.UNAUTHORIZED);
    }

    // Generate tokens
    const { tokens, jti } = generateTokenPair({
      userId: account.id,
      email: account.email,
      role: role,
      requiresFtlReset: account.requiresFtlReset,
    });

    // Store refresh token
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    await db.refreshToken.create({
      data: {
        token: tokens.refreshToken,
        userId: type === 'user' ? account.id : undefined,
        parentAccountId: type === 'parent' ? account.id : undefined,
        studentId: type === 'student' ? account.id : undefined,
        expiresAt,
      },
    });

    // Update lastLoginAt if User
    if (type === 'user') {
      await db.user.update({
        where: { id: account.id },
        data: { lastLoginAt: new Date() },
      });
    }

    return buildAuthResponse({ ...account, role }, tokens, jti);
  },

  /**
   * Rotate tokens: verify the refresh token, delete it, issue new pair.
   */
  async refresh(refreshToken: string): Promise<AuthResponse> {
    // Find the stored refresh token
    const storedToken = await db.refreshToken.findUnique({
      where: { token: refreshToken },
      include: {
        user: { include: { role: true } },
        parentAccount: { include: { profiles: true } },
        student: true,
      },
    });

    if (!storedToken) {
      throw new AppError('Invalid refresh token', HTTP_STATUS.UNAUTHORIZED);
    }

    if (storedToken.expiresAt < new Date()) {
      // Clean up expired token
      await db.refreshToken.delete({ where: { id: storedToken.id } });
      throw new AppError('Refresh token has expired', HTTP_STATUS.UNAUTHORIZED);
    }

    let account: any = null;
    let role = '';
    let type: 'user' | 'parent' | 'student' = 'user';

    if (storedToken.user) {
      account = storedToken.user;
      role = storedToken.user.role?.name || 'STUDENT';
      type = 'user';
    } else if (storedToken.parentAccount) {
      account = storedToken.parentAccount;
      const firstProfile = storedToken.parentAccount.profiles[0];
      account.firstName = firstProfile?.firstName || 'Parent';
      account.lastName = firstProfile?.lastName || 'Account';
      role = 'PARENT';
      type = 'parent';
    } else if (storedToken.student) {
      account = storedToken.student;
      role = 'STUDENT';
      type = 'student';
    }

    if (!account) {
      throw new AppError('Associated account not found', HTTP_STATUS.NOT_FOUND);
    }

    if (!account.isActive) {
      throw new AppError('Account is deactivated', HTTP_STATUS.FORBIDDEN);
    }

    // Delete the old refresh token (rotation)
    await db.refreshToken.delete({ where: { id: storedToken.id } });

    // Generate a new token pair
    const { tokens, jti } = generateTokenPair({
      userId: account.id,
      email: account.email,
      role: role,
      requiresFtlReset: account.requiresFtlReset,
    });

    // Store the new refresh token
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    await db.refreshToken.create({
      data: {
        token: tokens.refreshToken,
        userId: type === 'user' ? account.id : undefined,
        parentAccountId: type === 'parent' ? account.id : undefined,
        studentId: type === 'student' ? account.id : undefined,
        expiresAt,
      },
    });

    return buildAuthResponse({ ...account, role }, tokens, jti);
  },

  /**
   * Change your own password. Works for staff, parents and students alike —
   * the account type is resolved below. Proving the current password is the
   * only authorisation: knowing it is what makes the caller the owner.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<AuthResponse> {
    let account: any = null;
    let type: 'user' | 'parent' | 'student' = 'user';
    let role = '';

    const user = await db.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (user) {
      account = user;
      type = 'user';
      role = user.role?.name || 'STUDENT';
    } else {
      const parent = await db.parentAccount.findUnique({
        where: { id: userId },
        include: { profiles: true },
      });
      if (parent) {
        account = parent;
        type = 'parent';
        role = 'PARENT';
      } else {
        const student = await db.student.findUnique({
          where: { id: userId },
        });
        if (student) {
          account = student;
          type = 'student';
          role = 'STUDENT';
        }
      }
    }

    if (!account) {
      throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);
    }

    if (!account.isActive) {
      throw new AppError('Account is deactivated', HTTP_STATUS.FORBIDDEN);
    }

    const isPasswordValid = verifyPassword(currentPassword, account.passwordHash);
    if (!isPasswordValid) {
      throw new AppError('Invalid current password', HTTP_STATUS.UNAUTHORIZED);
    }

    const newPasswordHash = hashPassword(newPassword);

    let updatedAccount: any = null;
    if (type === 'user') {
      updatedAccount = await db.user.update({
        where: { id: userId },
        data: {
          passwordHash: newPasswordHash,
          requiresFtlReset: false,
        },
        include: { role: true },
      });
    } else if (type === 'parent') {
      updatedAccount = await db.parentAccount.update({
        where: { id: userId },
        data: {
          passwordHash: newPasswordHash,
          requiresFtlReset: false,
        },
        include: { profiles: true },
      });
      const firstProfile = updatedAccount.profiles[0];
      updatedAccount.firstName = firstProfile?.firstName || 'Parent';
      updatedAccount.lastName = firstProfile?.lastName || 'Account';
      updatedAccount.role = 'PARENT';
    } else if (type === 'student') {
      updatedAccount = await db.student.update({
        where: { id: userId },
        data: {
          passwordHash: newPasswordHash,
          requiresFtlReset: false,
        },
      });
      updatedAccount.role = 'STUDENT';
    }

    const { tokens, jti } = generateTokenPair({
      userId: updatedAccount.id,
      email: updatedAccount.email,
      role: updatedAccount.role?.name || updatedAccount.role || 'STUDENT',
      requiresFtlReset: false,
    });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    await db.refreshToken.create({
      data: {
        token: tokens.refreshToken,
        userId: type === 'user' ? updatedAccount.id : undefined,
        parentAccountId: type === 'parent' ? updatedAccount.id : undefined,
        studentId: type === 'student' ? updatedAccount.id : undefined,
        expiresAt,
      },
    });

    return buildAuthResponse({ ...updatedAccount, role: role || updatedAccount.role }, tokens, jti);
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
