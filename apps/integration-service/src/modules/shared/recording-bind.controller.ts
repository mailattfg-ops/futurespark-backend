import { Request, Response } from 'express';
import { HTTP_STATUS } from '@futurespark/constants';
import { successResponse, errorResponse } from '@futurespark/response';
import { logger } from '@futurespark/logger';
import { db } from '../../database/datasource';

/**
 * Manual attach / detach of a recording to a class.
 *
 * The escape hatch for when the automatic room+time match cannot help: a
 * delete-and-recreate left a video with no row that matches it, or a human
 * knows the right owner better than the timestamp does. Writing the binding
 * here freezes it exactly like an automatic match, so it survives later edits.
 *
 * Staff only — the same roles that manage the timetable. x-user-role is signed
 * by the gateway upstream.
 */
const MANAGE_ROLES = new Set(['ADMIN', 'SCHEDULER']);

const isManager = (req: Request): boolean =>
  MANAGE_ROLES.has((req.headers['x-user-role'] as string) || '');

export const bindRecording = async (req: Request, res: Response) => {
  if (!isManager(req)) {
    return res.status(HTTP_STATUS.FORBIDDEN).json(errorResponse('Only an admin or scheduler can attach a recording.'));
  }
  const { id } = req.params;
  const classId = typeof req.body?.classId === 'string' ? req.body.classId.trim() : '';
  if (!classId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('classId is required.'));
  }
  try {
    const updated = await db.meetingRecording.update({
      where: { id },
      data: { boundClassId: classId, boundAt: new Date(), boundBy: (req.headers['x-user-id'] as string) || 'manual' },
    });
    logger.info(`[Recording] ${id} manually attached to class ${classId} by ${req.headers['x-user-id'] ?? 'unknown'}.`);
    return res.status(HTTP_STATUS.OK).json(successResponse(updated, 'Recording attached to the class.'));
  } catch (err: any) {
    logger.error(`[Recording] Attach failed for ${id}: ${err.message}`);
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse('Could not attach the recording.'));
  }
};

export const unbindRecording = async (req: Request, res: Response) => {
  if (!isManager(req)) {
    return res.status(HTTP_STATUS.FORBIDDEN).json(errorResponse('Only an admin or scheduler can detach a recording.'));
  }
  const { id } = req.params;
  try {
    const updated = await db.meetingRecording.update({
      where: { id },
      data: { boundClassId: null, boundAt: null, boundBy: null },
    });
    logger.info(`[Recording] ${id} detached (back to automatic matching) by ${req.headers['x-user-id'] ?? 'unknown'}.`);
    return res.status(HTTP_STATUS.OK).json(successResponse(updated, 'Recording detached — automatic matching restored.'));
  } catch (err: any) {
    logger.error(`[Recording] Detach failed for ${id}: ${err.message}`);
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse('Could not detach the recording.'));
  }
};
