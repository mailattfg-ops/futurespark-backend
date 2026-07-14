import { Request, Response } from 'express';
import { logger } from '@futurespark/logger';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { authService } from './auth.service';
import { validateRegister, validateLogin, validateRefresh, validateLogout } from './auth.schema';

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
};
