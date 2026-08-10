import { Request, Response } from 'express';
import { ZoomMeetingsService, CreateZoomMeetingInput } from './meetings.service';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';

export class ZoomMeetingsController {
  static async create(req: Request, res: Response) {
    try {
      const {
        workspaceEmail = 'zoom@meet.futurespark.com',
        title,
        description,
        startTime,
        endTime,
        timezone = 'Asia/Kolkata',
        attendees = [],
        teacherId,
        studentId,
        programId,
        sessionId,
      } = req.body;

      if (!title || !startTime || !endTime || !teacherId || !studentId || !programId || !sessionId) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(
          errorResponse('Missing required fields: title, startTime, endTime, teacherId, studentId, programId, sessionId.')
        );
      }

      const input: CreateZoomMeetingInput = {
        title,
        description,
        startTime,
        endTime,
        timezone,
        attendees,
        teacherId,
        studentId,
        programId,
        sessionId,
      };

      const result = await ZoomMeetingsService.create(workspaceEmail, input);
      return res.status(HTTP_STATUS.CREATED).json(successResponse(result, 'Zoom meeting created successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] create error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to create Zoom meeting.')
      );
    }
  }

  static async list(req: Request, res: Response) {
    try {
      const { teacherId, studentId, programId, status } = req.query as Record<string, string>;
      const meetings = await ZoomMeetingsService.list({
        teacherId,
        studentId,
        programId,
        status,
        provider: 'ZOOM',
      });
      return res.status(HTTP_STATUS.OK).json(successResponse(meetings, 'Zoom meetings fetched successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] list error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to list Zoom meetings.')
      );
    }
  }

  static async get(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const meeting = await ZoomMeetingsService.get(id);
      return res.status(HTTP_STATUS.OK).json(successResponse(meeting, 'Zoom meeting retrieved successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] get error: ${err.message}`);
      return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse(err.message || 'Zoom meeting not found.'));
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const updated = await ZoomMeetingsService.update(id, req.body);
      return res.status(HTTP_STATUS.OK).json(successResponse(updated, 'Zoom meeting updated successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] update error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to update Zoom meeting.')
      );
    }
  }

  static async rescheduleByLink(req: Request, res: Response) {
    try {
      const { zoomUrl, startTime, endTime } = req.body;
      if (!zoomUrl || !startTime || !endTime) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(
          errorResponse('zoomUrl, startTime, and endTime are required.')
        );
      }

      const updated = await ZoomMeetingsService.rescheduleByLink(zoomUrl, startTime, endTime);
      return res.status(HTTP_STATUS.OK).json(successResponse(updated, 'Zoom meeting rescheduled successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] reschedule error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to reschedule Zoom meeting.')
      );
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const result = await ZoomMeetingsService.delete(id);
      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Zoom meeting cancelled successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] delete error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to delete Zoom meeting.')
      );
    }
  }

  static async deleteByLink(req: Request, res: Response) {
    try {
      const zoomUrl = (req.query.zoomUrl as string) || (req.body?.zoomUrl as string) || (req.query.meetUrl as string);
      if (!zoomUrl) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('zoomUrl or meetUrl query parameter is required.'));
      }

      const result = await ZoomMeetingsService.deleteByLink(zoomUrl);
      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Zoom meeting cancelled successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] deleteByLink error: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(
        errorResponse(err.message || 'Failed to delete Zoom meeting by link.')
      );
    }
  }
}
