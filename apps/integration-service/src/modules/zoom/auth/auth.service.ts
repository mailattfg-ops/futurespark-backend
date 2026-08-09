import { db, withDbRetry } from '../../../database/datasource';
import { logger } from '@futurespark/logger';
import crypto from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
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
    if (parts.length !== 2) return encryptedText;
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    logger.error(`Zoom token decryption failed: ${(err as Error).message}`);
    return encryptedText;
  }
}

interface ServerToServerTokenCache {
  accessToken: string;
  expiresAt: number; // Unix epoch ms
}

let s2sTokenCache: ServerToServerTokenCache | null = null;

export class ZoomAuthService {
  /**
   * Retrieves a Server-to-Server OAuth access token for Zoom API operations.
   * Caches token in memory and auto-refreshes 5 minutes before expiry.
   */
  static async getServerToServerToken(): Promise<string> {
    const accountId = process.env.ZOOM_ACCOUNT_ID;
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;

    if (!accountId || !clientId || !clientSecret) {
      // Check if configured in DB
      const dbAccount = await withDbRetry(() =>
        db.zoomAccount.findFirst({
          where: { accountType: 'SERVER_TO_SERVER', connected: true },
        })
      );

      if (dbAccount && dbAccount.accountId && dbAccount.clientId && dbAccount.clientSecret) {
        return this.fetchS2SToken(
          dbAccount.accountId,
          decrypt(dbAccount.clientId),
          decrypt(dbAccount.clientSecret)
        );
      }

      throw new Error(
        'Zoom Server-to-Server credentials (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET) are not configured.'
      );
    }

    // Check memory cache
    const now = Date.now();
    if (s2sTokenCache && s2sTokenCache.expiresAt > now + 5 * 60 * 1000) {
      return s2sTokenCache.accessToken;
    }

    return this.fetchS2SToken(accountId, clientId, clientSecret);
  }

  private static async fetchS2SToken(accountId: string, clientId: string, clientSecret: string): Promise<string> {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!res.ok) {
      const errBody = await res.text();
      logger.error(`[ZoomAuth] Server-to-Server token fetch failed (${res.status}): ${errBody}`);
      throw new Error(`Failed to obtain Zoom access token: ${res.statusText} (${errBody})`);
    }

    const data = await res.json();
    const accessToken = data.access_token;
    const expiresIn = data.expires_in || 3600; // seconds

    s2sTokenCache = {
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    logger.info('[ZoomAuth] Successfully acquired fresh Server-to-Server OAuth token');
    return accessToken;
  }

  /**
   * Generates authorization URL for User OAuth 2.0 flow.
   */
  static getAuthUrl(email: string): string {
    const clientId = process.env.ZOOM_CLIENT_ID;
    const redirectUri = process.env.ZOOM_REDIRECT_URI || 'http://localhost:3000/api/zoom/callback';

    if (!clientId) {
      throw new Error('ZOOM_CLIENT_ID is not configured in the environment.');
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state: email,
    });

    return `https://zoom.us/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchanges authorization code for OAuth 2.0 tokens and saves to DB.
   */
  static async handleCallback(code: string, stateEmail: string) {
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;
    const redirectUri = process.env.ZOOM_REDIRECT_URI || 'http://localhost:3000/api/zoom/callback';

    if (!clientId || !clientSecret) {
      throw new Error('Zoom OAuth credentials (ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET) are not configured.');
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenUrl = 'https://zoom.us/oauth/token';

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      logger.error(`[ZoomAuth] OAuth token exchange failed: ${errText}`);
      throw new Error(`Zoom OAuth token exchange failed: ${errText}`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in || 3600;

    // Fetch user profile from Zoom to verify email
    const userRes = await fetch('https://api.zoom.us/v2/users/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    let zoomEmail = stateEmail;
    if (userRes.ok) {
      const userData = await userRes.json();
      zoomEmail = userData.email || stateEmail;
    }

    const encryptedAccessToken = encrypt(accessToken);
    const encryptedRefreshToken = refreshToken ? encrypt(refreshToken) : '';
    const expiryDate = new Date(Date.now() + expiresIn * 1000);

    const account = await db.zoomAccount.upsert({
      where: { accountEmail: zoomEmail },
      update: {
        accessToken: encryptedAccessToken,
        ...(encryptedRefreshToken ? { refreshToken: encryptedRefreshToken } : {}),
        tokenExpiry: expiryDate,
        connected: true,
        accountType: 'OAUTH',
      },
      create: {
        accountEmail: zoomEmail,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiry: expiryDate,
        connected: true,
        accountType: 'OAUTH',
      },
    });

    logger.info(`[ZoomAuth] Zoom account connected successfully for: ${zoomEmail}`);
    return account;
  }

  /**
   * Returns a valid Bearer access token for Zoom REST API requests.
   * Priority: User OAuth if email is provided & connected, otherwise Server-to-Server OAuth.
   */
  static async getAccessToken(email?: string): Promise<string> {
    if (email) {
      const account = await withDbRetry(() =>
        db.zoomAccount.findUnique({ where: { accountEmail: email } })
      );

      if (account && account.connected && account.accessToken) {
        // Check if token is expired and needs refresh
        if (account.tokenExpiry && account.tokenExpiry.getTime() <= Date.now() + 60000 && account.refreshToken) {
          return this.refreshUserToken(account);
        }
        return decrypt(account.accessToken);
      }
    }

    // Default to Server-to-Server OAuth token
    return this.getServerToServerToken();
  }

  private static async refreshUserToken(account: any): Promise<string> {
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Zoom OAuth credentials missing for token refresh');

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const plainRefreshToken = decrypt(account.refreshToken);

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: plainRefreshToken,
    });

    const res = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      logger.error(`[ZoomAuth] Refresh failed for ${account.accountEmail}`);
      throw new Error('Failed to refresh Zoom OAuth token');
    }

    const data = await res.json();
    const encryptedAccess = encrypt(data.access_token);
    const encryptedRefresh = data.refresh_token ? encrypt(data.refresh_token) : account.refreshToken;
    const expiry = new Date(Date.now() + (data.expires_in || 3600) * 1000);

    await withDbRetry(() =>
      db.zoomAccount.update({
        where: { id: account.id },
        data: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          tokenExpiry: expiry,
        },
      })
    );

    return data.access_token;
  }

  static async disconnect(email: string) {
    const account = await withDbRetry(() =>
      db.zoomAccount.findUnique({ where: { accountEmail: email } })
    );

    if (!account) {
      throw new Error(`No Zoom account found for email: ${email}`);
    }

    return withDbRetry(() =>
      db.zoomAccount.update({
        where: { accountEmail: email },
        data: { connected: false },
      })
    );
  }

  static async getStatus() {
    const s2sConfigured = Boolean(
      process.env.ZOOM_ACCOUNT_ID &&
      process.env.ZOOM_CLIENT_ID &&
      process.env.ZOOM_CLIENT_SECRET
    );

    const accounts = await withDbRetry(() =>
      db.zoomAccount.findMany({
        select: {
          id: true,
          accountEmail: true,
          accountType: true,
          connected: true,
          tokenExpiry: true,
          createdAt: true,
        },
      })
    );

    return {
      serverToServerConfigured: s2sConfigured,
      connectedAccounts: accounts,
    };
  }
}
