import { Request, Response } from 'express';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { scheduleService } from './schedule.service';
import { validateCreateSchedule, validateUpdateSchedule } from './schedule.schema';

export const scheduleController = {
  async listMentors(req: Request, res: Response) {
    const list = await scheduleService.getMentorsWithSchedules();
    return res.status(HTTP_STATUS.OK).json(successResponse(list, 'Mentors availability fetched successfully'));
  },

  async list(req: Request, res: Response) {
    const { studentId, mentorId, status } = req.query;
    const list = await scheduleService.listSchedules({
      studentId: typeof studentId === 'string' ? studentId : undefined,
      mentorId: typeof mentorId === 'string' ? mentorId : undefined,
      status: typeof status === 'string' ? status : undefined,
    });
    return res.status(HTTP_STATUS.OK).json(successResponse(list, 'Schedules fetched successfully'));
  },

  async getById(req: Request, res: Response) {
    const classSession = await scheduleService.getScheduleById(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(classSession, 'Schedule fetched successfully'));
  },

  async create(req: Request, res: Response) {
    const input = validateCreateSchedule(req.body);
    const scheduledById = req.headers['x-user-id'] as string | undefined;
    const classSession = await scheduleService.createSchedule(input, scheduledById);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(classSession, 'Class scheduled successfully'));
  },

  async update(req: Request, res: Response) {
    const input = validateUpdateSchedule(req.body);
    const classSession = await scheduleService.updateSchedule(req.params.id, input);
    return res.status(HTTP_STATUS.OK).json(successResponse(classSession, 'Schedule updated successfully'));
  },

  async delete(req: Request, res: Response) {
    await scheduleService.deleteSchedule(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Schedule deleted successfully'));
  },
};
