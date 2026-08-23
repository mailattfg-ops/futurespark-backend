import { Request, Response } from 'express';
import { db } from '../../../database/datasource';
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

      // Query ADMIN and QA_AUDITOR emails from the auth schema to inject as attendees (co-admins/trusted guests)
      let adminAndQaEmails: string[] = [];
      try {
        const adminAndQaUsers = await db.$queryRaw<{ email: string }[]>`
          SELECT email FROM "auth"."User" u
          JOIN "auth"."Role" r ON u."roleId" = r.id
          WHERE r.name IN ('ADMIN', 'QA_AUDITOR') AND u."isActive" = true
        `;
        adminAndQaEmails = adminAndQaUsers.map(u => u.email).filter(Boolean);
      } catch (err: any) {
        logger.warn(`Failed to retrieve Admin/QA emails for co-admin injection: ${err.message}`);
      }

      const mergedAttendees = Array.from(new Set([
        ...(attendees || []),
        ...adminAndQaEmails
      ])).filter(email => email !== workspaceEmail);

      const result = await GoogleMeetingsService.create(workspaceEmail, {
        title,
        description,
        startTime,
        endTime,
        timezone,
        attendees: mergedAttendees,
        teacherId,
        studentId,
        programId,
        sessionId,
        // Only a literal true is consent to book over a known clash.
        allowConflict: req.body?.allowConflict === true || req.body?.allowConflict === 'true',
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

  /** Reschedule the Calendar event for a class, addressed by its Meet link. */
  static async rescheduleByLink(req: Request, res: Response) {
    try {
      const { meetUrl, startTime, endTime, timezone } = req.body;
      if (!meetUrl || !startTime || !endTime) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(errorResponse('meetUrl, startTime and endTime are required.'));
      }

      const result = await GoogleMeetingsService.rescheduleByLink(meetUrl, { startTime, endTime, timezone });
      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Meeting rescheduled successfully.'));
    } catch (err: any) {
      logger.error(`Error rescheduling meeting by link: ${err.message}`);
      return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse(err.message || 'Failed to reschedule meeting'));
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

  static async syncManual(req: Request, res: Response) {
    try {
      const { meetingLink, title, description, startTime, endTime, organizerEmail, teacherId, studentId, programId, sessionId } = req.body;
      
      if (!meetingLink || !title || !startTime || !endTime || !organizerEmail || !teacherId || !studentId || !programId || !sessionId) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(
          errorResponse('Missing required parameters for manual sync.')
        );
      }

      const result = await GoogleMeetingsService.syncManualClass({
        meetingLink,
        title,
        description,
        startTime,
        endTime,
        organizerEmail,
        teacherId,
        studentId,
        programId,
        sessionId,
      });

      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Manual meeting synced successfully.'));
    } catch (err: any) {
      logger.error(`Error syncing manual meeting: ${err.message}`);
      return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse(err.message || 'Failed to sync manual meeting'));
    }
  }

  static async deleteByLink(req: Request, res: Response) {
    try {
      const { meetUrl } = req.query;
      if (typeof meetUrl !== 'string') {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('meetUrl query parameter is required.'));
      }
      const result = await GoogleMeetingsService.deleteByLink(meetUrl);
      return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Meeting deleted successfully.'));
    } catch (err: any) {
      logger.error(`Error deleting meeting by link: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to delete meeting'));
    }
  }
}
