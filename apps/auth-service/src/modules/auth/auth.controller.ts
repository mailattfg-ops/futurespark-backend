import { Request, Response } from 'express';
import { logger } from '@futurespark/logger';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { authService } from './auth.service';
import { validateRegister, validateLogin, validateRefresh, validateLogout, validateCompleteFtl } from './auth.schema';
import { verifyAccessToken } from '@futurespark/authentication';

export const authController = {
  /**
   * POST /auth/register
   */
  async register(req: Request, res: Response) {
    const input = validateRegister(req.body);
    const result = await authService.register(input);
    logger.info(`[Auth] New user registered: ${input.email}`);
    return res
      .status(HTTP_STATUS.CREATED)
      .json(successResponse(result, 'Registration successful'));
  },

  /**
   * POST /auth/login
   */
  async login(req: Request, res: Response) {
    const input = validateLogin(req.body);
    const result = await authService.login(input);
    logger.info(`[Auth] User logged in: ${input.email}`);
    return res
      .status(HTTP_STATUS.OK)
      .json(successResponse(result, 'Login successful'));
  },

  /**
   * POST /auth/refresh
   */
  async refresh(req: Request, res: Response) {
    const { refreshToken } = validateRefresh(req.body);
    const result = await authService.refresh(refreshToken);
    return res
      .status(HTTP_STATUS.OK)
      .json(successResponse(result, 'Tokens refreshed successfully'));
  },

  /**
   * POST /auth/logout
   */
  async logout(req: Request, res: Response) {
    const { refreshToken } = validateLogout(req.body);
    const authHeader = req.headers.authorization;
    const accessToken = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : '';

    await authService.logout(accessToken || '', refreshToken);
    logger.info(`[Auth] User logged out`);
    return res
      .status(HTTP_STATUS.OK)
      .json(successResponse(null, 'Logged out successfully'));
  },

  /**
   * POST /auth/complete-ftl
   */
  async completeFtl(req: Request, res: Response) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: 'Authorization token is required',
        timestamp: new Date().toISOString(),
      });
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: 'Invalid or expired authorization token',
        timestamp: new Date().toISOString(),
      });
    }

    const input = validateCompleteFtl(req.body);
    const result = await authService.completeFtl(
      decoded.userId,
      input.currentPassword,
      input.newPassword,
      input.firstName,
      input.lastName
    );

    logger.info(`[Auth] FTL flow completed for user ${decoded.email}`);
    return res
      .status(HTTP_STATUS.OK)
      .json(successResponse(result, 'Password changed and profile completed successfully'));
  },
};
