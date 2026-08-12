import { Request, Response } from 'express';
import {
  ZoomMeetingsService,
  ZoomServiceError,
  CreateZoomMeetingInput,
  UpdateZoomMeetingInput,
} from './meetings.service';
import { zoomConfig } from '../auth/auth.service';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';

/**
 * A scheduler has to be able to tell "try again", "pick another slot" and
 * "this deployment cannot do Zoom" apart, and every one of those used to come
 * back as a 500 with a prose message.
 */
const statusForError = (err: any): number => {
  if (!(err instanceof ZoomServiceError)) return HTTP_STATUS.INTERNAL_SERVER_ERROR;
  switch (err.code) {
    case 'ZOOM_NOT_CONFIGURED':
      return HTTP_STATUS.SERVICE_UNAVAILABLE;
    case 'ZOOM_VALIDATION':
      return HTTP_STATUS.BAD_REQUEST;
    case 'ZOOM_DOUBLE_BOOKING':
    case 'ZOOM_HOST_POOL_EXHAUSTED':
      return HTTP_STATUS.CONFLICT;
    case 'ZOOM_NOT_FOUND':
      return HTTP_STATUS.NOT_FOUND;
    case 'ZOOM_API_FAILED':
      return HTTP_STATUS.BAD_GATEWAY;
    default:
      return HTTP_STATUS.INTERNAL_SERVER_ERROR;
  }
};

const failureBody = (err: any, fallbackMessage: string) =>
  errorResponse(err?.message || fallbackMessage, {
    code: err instanceof ZoomServiceError ? err.code : 'ZOOM_UNEXPECTED_ERROR',
    ...(err instanceof ZoomServiceError ? err.details : {}),
  });

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

export class ZoomMeetingsController {
  static async create(req: Request, res: Response) {
    try {
      const {
        workspaceEmail = zoomConfig.organizerEmail,
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
        mentorEmail,
        teacherEmail,
      } = req.body ?? {};

      const missing = ['title', 'startTime', 'endTime', 'teacherId', 'studentId', 'programId', 'sessionId'].filter(
        (field) => !asOptionalString(req.body?.[field])
      );
      if (missing.length > 0) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(
          errorResponse(
            `Missing or non-string required field(s): ${missing.join(', ')}.`,
            { code: 'ZOOM_VALIDATION', missing }
          )
        );
      }

      const input: CreateZoomMeetingInput = {
        title,
        description: asOptionalString(description),
        startTime,
        endTime,
        timezone: asOptionalString(timezone) ?? 'Asia/Kolkata',
        attendees: Array.isArray(attendees) ? attendees.filter((a: unknown) => typeof a === 'string') : [],
        teacherId,
        studentId,
        programId,
        sessionId,
        // Only consulted when ZOOM_PREFER_MENTOR_HOST is on. `teacherEmail` is
        // accepted as an alias because that is what the class record calls it.
        mentorEmail: asOptionalString(mentorEmail) ?? asOptionalString(teacherEmail),
      };

      const result = await ZoomMeetingsService.create(asOptionalString(workspaceEmail) ?? zoomConfig.organizerEmail, input);
      return res.status(HTTP_STATUS.CREATED).json(successResponse(result, 'Zoom meeting created successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] create error: ${err.message}`);
      return res.status(statusForError(err)).json(failureBody(err, 'Failed to create Zoom meeting.'));
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
      return res.status(statusForError(err)).json(failureBody(err, 'Failed to list Zoom meetings.'));
    }
  }

  static async get(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const meeting = await ZoomMeetingsService.get(id);
      return res.status(HTTP_STATUS.OK).json(successResponse(meeting, 'Zoom meeting retrieved successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] get error: ${err.message}`);
      return res.status(HTTP_STATUS.NOT_FOUND).json(failureBody(err, 'Zoom meeting not found.'));
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const body = req.body ?? {};

      // Whitelisted, not forwarded verbatim: this endpoint is unauthenticated
      // and `req.body` used to go straight into the service, so any caller
      // could set `status` to any string at all.
      const input: UpdateZoomMeetingInput = {
        ...(body.title !== undefined ? { title: String(body.title) } : {}),
        ...(body.description !== undefined ? { description: String(body.description) } : {}),
        ...(body.startTime !== undefined ? { startTime: String(body.startTime) } : {}),
        ...(body.endTime !== undefined ? { endTime: String(body.endTime) } : {}),
        ...(body.timezone !== undefined ? { timezone: String(body.timezone) } : {}),
        ...(body.status !== undefined ? { status: String(body.status) } : {}),
      };

      if (Object.keys(input).length === 0) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(
          errorResponse('Nothing to update. Supply at least one of: title, description, startTime, endTime, timezone, status.', {
            code: 'ZOOM_VALIDATION',
          })
        );
      }

      const updated = await ZoomMeetingsService.update(id, input);
      return res.status(HTTP_STATUS.OK).json(successResponse(updated, 'Zoom meeting updated successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] update error: ${err.message}`);
      return res.status(statusForError(err)).json(failureBody(err, 'Failed to update Zoom meeting.'));
    }
  }

  static async rescheduleByLink(req: Request, res: Response) {
    try {
      const { zoomUrl, startTime, endTime, timezone } = req.body ?? {};
      if (!zoomUrl || !startTime || !endTime) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(
          errorResponse('zoomUrl, startTime, and endTime are required.', { code: 'ZOOM_VALIDATION' })
        );
      }

      // auth-service sends a timezone with every reschedule; it used to be
      // discarded here.
      const updated = await ZoomMeetingsService.rescheduleByLink(
        String(zoomUrl),
        String(startTime),
        String(endTime),
        asOptionalString(timezone)
      );
      return res.status(HTTP_STATUS.OK).json(successResponse(updated, 'Zoom meeting rescheduled successfully.'));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] reschedule error: ${err.message}`);
      return res.status(statusForError(err)).json(failureBody(err, 'Failed to reschedule Zoom meeting.'));
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const result = await ZoomMeetingsService.delete(id);
      return res.status(HTTP_STATUS.OK).json(successResponse(result, result.message));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] delete error: ${err.message}`);
      return res.status(statusForError(err)).json(failureBody(err, 'Failed to delete Zoom meeting.'));
    }
  }

  static async deleteByLink(req: Request, res: Response) {
    try {
      const zoomUrl = (req.query.zoomUrl as string) || (req.body?.zoomUrl as string) || (req.query.meetUrl as string);
      if (!zoomUrl) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(
          errorResponse('zoomUrl or meetUrl query parameter is required.', { code: 'ZOOM_VALIDATION' })
        );
      }

      const result = await ZoomMeetingsService.deleteByLink(zoomUrl);
      if (!result.matched) {
        // A cancel that matched nothing is not a successful cancel. Reporting
        // it as one is how a live Zoom room outlives the class it belonged to.
        return res.status(HTTP_STATUS.NOT_FOUND).json(
          errorResponse(result.message, { code: 'ZOOM_NOT_FOUND', matched: false })
        );
      }
      return res.status(HTTP_STATUS.OK).json(successResponse(result, result.message));
    } catch (err: any) {
      logger.error(`[ZoomMeetingsController] deleteByLink error: ${err.message}`);
      return res.status(statusForError(err)).json(failureBody(err, 'Failed to delete Zoom meeting by link.'));
    }
  }
}
