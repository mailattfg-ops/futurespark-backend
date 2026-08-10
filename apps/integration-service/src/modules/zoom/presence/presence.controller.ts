import { Request, Response } from 'express';
import { ZoomPresenceService } from './presence.service';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';

export class ZoomPresenceController {
  static async getSnapshot(_req: Request, res: Response) {
    try {
      const snapshot = await ZoomPresenceService.getPresenceSnapshot();
      return res.status(HTTP_STATUS.OK).json(successResponse(snapshot, 'Zoom presence snapshot retrieved successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomPresenceController] getSnapshot error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to get Zoom presence snapshot.')
      );
    }
  }

  static async pollNow(_req: Request, res: Response) {
    try {
      const result = await ZoomPresenceService.poll();
      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Zoom presence poll executed.'));
    } catch (err: any) {
      logger.error(`[ZoomPresenceController] pollNow error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to trigger Zoom presence poll.')
      );
    }
  }
}
