import { Request, Response } from 'express';
import { GoogleMeetingsService } from './meetings.service';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';

export class GoogleMeetingsController {
  static async create(req: Request, res: Response) {
    try {
      const { workspaceEmail, title, description, startTime, endTime, timezone, attendees, teacherId, studentId, programId, sessionId } = req.body;

      if (!workspaceEmail || !title || !startTime || !endTime || !timezone || !teacherId || !studentId || !programId || !sessionId) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(
          errorResponse('Missing required parameters. Required fields: workspaceEmail, title, startTime, endTime, timezone, teacherId, studentId, programId, sessionId')
        );
      }

      const result = await GoogleMeetingsService.create(workspaceEmail, {
        title,
        description,
        startTime,
        endTime,
        timezone,
        attendees: attendees || [],
        teacherId,
        studentId,
        programId,
        sessionId,
      });

      return res.status(HTTP_STATUS.CREATED).json(successResponse(result, 'Meeting created successfully.'));
    } catch (err: any) {
      logger.error(`Error creating meeting: ${err.message}`);
      return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse(err.message || 'Failed to create meeting'));
    }
  }

  static async get(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const meeting = await GoogleMeetingsService.getById(id);
      return res.status(HTTP_STATUS.OK).json(successResponse(meeting, 'Meeting retrieved successfully.'));
    } catch (err: any) {
      logger.error(`Error retrieving meeting details: ${err.message}`);
      return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse(err.message || 'Failed to retrieve meeting details'));
    }
  }

  static async list(req: Request, res: Response) {
    try {
      const { teacherId, studentId, status } = req.query;
      const meetings = await GoogleMeetingsService.list({
        teacherId: typeof teacherId === 'string' ? teacherId : undefined,
        studentId: typeof studentId === 'string' ? studentId : undefined,
        status: typeof status === 'string' ? status : undefined,
      });

      return res.status(HTTP_STATUS.OK).json(successResponse(meetings, 'Meetings listed successfully.'));
    } catch (err: any) {
      logger.error(`Error listing meetings: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to list meetings'));
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { title, description, startTime, endTime, timezone, attendees, status } = req.body;

      const result = await GoogleMeetingsService.update(id, {
        title,
        description,
        startTime,
        endTime,
        timezone,
        attendees,
        status,
      });

      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Meeting updated successfully.'));
    } catch (err: any) {
      logger.error(`Error updating meeting: ${err.message}`);
      return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse(err.message || 'Failed to update meeting'));
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const result = await GoogleMeetingsService.delete(id);
      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Meeting cancelled and deleted successfully.'));
    } catch (err: any) {
      logger.error(`Error deleting meeting: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to delete meeting'));
    }
  }
}
