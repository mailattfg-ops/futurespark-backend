import { Request, Response } from 'express';
import { GoogleAuthService } from './auth.service';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';

export class GoogleAuthController {
  static async connectWorkspace(req: Request, res: Response) {
    try {
      const { email } = req.query;
      if (!email || typeof email !== 'string') {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Query parameter "email" is required.'));
      }

      const url = GoogleAuthService.getAuthUrl(email);
      return res.status(HTTP_STATUS.OK).json(successResponse({ url }, 'Redirect URL generated successfully.'));
    } catch (err: any) {
      logger.error(`Error generating redirect: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to connect workspace'));
    }
  }

  static async callback(req: Request, res: Response) {
    try {
      const { code, state } = req.query;
      if (!code || typeof code !== 'string') {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Query parameter "code" is required.'));
      }
      if (!state || typeof state !== 'string') {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Query parameter "state" (email) is required.'));
      }

      const account = await GoogleAuthService.handleCallback(code, state);
      return res.status(HTTP_STATUS.OK).json(successResponse({
        email: account.workspaceEmail,
        connected: account.connected,
      }, 'Google Workspace connected successfully.'));
    } catch (err: any) {
      logger.error(`Error in OAuth callback: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'OAuth verification failed'));
    }
  }

  static async disconnectWorkspace(req: Request, res: Response) {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Body parameter "email" is required.'));
      }

      const result = await GoogleAuthService.disconnect(email);
      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Google Workspace disconnected successfully.'));
    } catch (err: any) {
      logger.error(`Error disconnecting Workspace: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to disconnect workspace'));
    }
  }
}
