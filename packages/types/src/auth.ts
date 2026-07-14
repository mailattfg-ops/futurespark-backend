/**
 * JWT payload embedded in access tokens.
 */
export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  jti: string; // Unique token identifier for blocklist
}

/**
 * Token pair returned after login/register/refresh.
 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // Access token TTL in seconds
}

/**
 * Login request body.
 */
export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * Registration request body.
 */
export interface RegisterRequest {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Authentication response returned to the client.
 */
export interface AuthResponse {
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
  };
  tokens: TokenPair;
}

/**
 * Refresh token request body.
 */
export interface RefreshTokenRequest {
  refreshToken: string;
}

/**
 * Logout request body.
 */
export interface LogoutRequest {
  refreshToken: string;
}
