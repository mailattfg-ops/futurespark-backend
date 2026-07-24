import { google } from 'googleapis';
import { db } from '../../../database/datasource';
import { logger } from '@futurespark/logger';
import crypto from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
// Ensure key is 32 bytes
const ENCRYPTION_KEY = Buffer.concat([Buffer.from(process.env.ENCRYPTION_KEY || 'default-secret-key-32-chars-long!')], 32);

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText: string): string {
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return encryptedText; // plain fallback
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    logger.error(`Token decryption failed: ${(err as Error).message}`);
    return encryptedText;
  }
}

export class GoogleAuthService {
  private static getOAuth2Client() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/google/callback';

    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) are not set in the environment.');
    }

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  static getAuthUrl(email: string): string {
    const oauth2Client = this.getOAuth2Client();
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/meetings.space.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state: email, // pass email in state to associate account
    });
  }

  static async handleCallback(code: string, stateEmail: string) {
    const oauth2Client = this.getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token) {
      throw new Error('No access token received from Google.');
    }

    // Verify email matches stateEmail (optional but recommended)
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const googleEmail = userInfo.data.email || stateEmail;

    const encryptedAccessToken = encrypt(tokens.access_token);
    const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : '';

    const expiryDate = new Date(tokens.expiry_date || Date.now() + 3600 * 1000);

    // Upsert the google account connection
    const account = await db.googleAccount.upsert({
      where: { workspaceEmail: googleEmail },
      update: {
        accessToken: encryptedAccessToken,
        // Only update refresh token if a new one is received (offline access)
        ...(encryptedRefreshToken ? { refreshToken: encryptedRefreshToken } : {}),
        tokenExpiry: expiryDate,
        connected: true,
      },
      create: {
        workspaceEmail: googleEmail,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken || '',
        tokenExpiry: expiryDate,
        connected: true,
      },
    });

    logger.info(`Google account connected successfully for Workspace: ${googleEmail}`);
    return account;
  }

  static async disconnect(email: string) {
    const account = await db.googleAccount.findUnique({ where: { workspaceEmail: email } });
    if (!account) {
      throw new Error(`Google account with email ${email} not found.`);
    }

    await db.googleAccount.update({
      where: { workspaceEmail: email },
      data: { connected: false },
    });

    logger.info(`Google account disconnected successfully for Workspace: ${email}`);
    return { email, connected: false };
  }

  static async getClientForEmail(email: string) {
    const account = await db.googleAccount.findUnique({ where: { workspaceEmail: email } });
    if (!account || !account.connected) {
      throw new Error(`Google account ${email} is not connected or registered.`);
    }

    const oauth2Client = this.getOAuth2Client();
    const decryptedAccessToken = decrypt(account.accessToken);
    const decryptedRefreshToken = decrypt(account.refreshToken);

    oauth2Client.setCredentials({
      access_token: decryptedAccessToken,
      refresh_token: decryptedRefreshToken,
      expiry_date: account.tokenExpiry.getTime(),
    });

    // Check if token is expired or close to expiry (within 5 minutes)
    if (account.tokenExpiry.getTime() - Date.now() < 5 * 60 * 1000) {
      logger.info(`Refreshing expired Google access token for email ${email}`);
      if (!decryptedRefreshToken) {
        throw new Error(`Refresh token missing for account ${email}. Please reconnect the account.`);
      }

      const { credentials } = await oauth2Client.refreshAccessToken();
      if (credentials.access_token) {
        const encryptedNewAccess = encrypt(credentials.access_token);
        const newExpiry = new Date(credentials.expiry_date || Date.now() + 3600 * 1000);

        await db.googleAccount.update({
          where: { workspaceEmail: email },
          data: {
            accessToken: encryptedNewAccess,
            tokenExpiry: newExpiry,
          },
        });

        oauth2Client.setCredentials(credentials);
      }
    }

    return oauth2Client;
  }
}
