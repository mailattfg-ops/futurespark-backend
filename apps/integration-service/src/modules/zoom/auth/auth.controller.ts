import { Request, Response } from 'express';
import { ZoomAuthService } from './auth.service';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';

export class ZoomAuthController {
  static async connectWorkspace(req: Request, res: Response) {
    try {
      const { email } = req.query;
      if (!email || typeof email !== 'string') {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Query parameter "email" is required.'));
      }

      const url = ZoomAuthService.getAuthUrl(email);
      return res.status(HTTP_STATUS.OK).json(successResponse({ url }, 'Zoom authorization URL generated successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomAuthController] Error generating auth URL: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to connect Zoom workspace'));
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

      const account = await ZoomAuthService.handleCallback(code, state);
      return res.status(HTTP_STATUS.OK).json(successResponse({
        email: account.accountEmail,
        connected: account.connected,
      }, 'Zoom Workspace connected successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomAuthController] Error in OAuth callback: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Zoom OAuth verification failed'));
    }
  }

  static async disconnectWorkspace(req: Request, res: Response) {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Body parameter "email" is required.'));
      }

      const result = await ZoomAuthService.disconnect(email);
      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Zoom Workspace disconnected successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomAuthController] Error disconnecting workspace: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to disconnect Zoom workspace'));
    }
  }

  static async status(_req: Request, res: Response) {
    try {
      const status = await ZoomAuthService.getStatus();
      return res.status(HTTP_STATUS.OK).json(successResponse(status, 'Zoom integration status retrieved.'));
    } catch (err: any) {
      logger.error(`[ZoomAuthController] Error fetching status: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to get Zoom status'));
    }
  }
}
