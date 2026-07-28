import { Request, Response } from 'express';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { scheduleService } from './schedule.service';
import { validateCreateSchedule, validateUpdateSchedule } from './schedule.schema';

export const scheduleController = {
  async listMentors(req: Request, res: Response) {
    const { groupId } = req.query;
    const list = await scheduleService.getMentorsWithSchedules(typeof groupId === 'string' ? groupId : undefined);
    return res.status(HTTP_STATUS.OK).json(successResponse(list, 'Mentors availability fetched successfully'));
  },

  async list(req: Request, res: Response) {
    const { studentId, mentorId, status, groupId } = req.query;
    const list = await scheduleService.listSchedules({
      studentId: typeof studentId === 'string' ? studentId : undefined,
      mentorId: typeof mentorId === 'string' ? mentorId : undefined,
      status: typeof status === 'string' ? status : undefined,
      groupId: typeof groupId === 'string' ? groupId : undefined,
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
    const { deleteAll } = req.query;
    await scheduleService.deleteSchedule(req.params.id, deleteAll === 'true');
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Schedule deleted successfully'));
  },

  async createReport(req: Request, res: Response) {
    const { classId, issueType, description } = req.body;
    const reporterId = req.headers['x-user-id'] as string;
    const reporterRole = req.headers['x-user-role'] as string;

    if (!classId || !issueType || !description) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: 'Missing required parameters: classId, issueType, and description are required.',
      });
    }

    const report = await scheduleService.createReport({
      classId,
      reporterId,
      reporterRole,
      issueType,
      description,
    });

    return res.status(HTTP_STATUS.CREATED).json(successResponse(report, 'Issue report submitted successfully'));
  },

  async listReports(req: Request, res: Response) {
    const reporterId = typeof req.query.reporterId === 'string' ? req.query.reporterId : undefined;
    const reports = await scheduleService.listReports(reporterId);
    return res.status(HTTP_STATUS.OK).json(successResponse(reports, 'Session reports fetched successfully'));
  },

  async updateReport(req: Request, res: Response) {
    const { status, qaFeedback } = req.body;
    const report = await scheduleService.updateReport(req.params.id, { status, qaFeedback });
    return res.status(HTTP_STATUS.OK).json(successResponse(report, 'Session report updated successfully'));
  },

  async completeClass(req: Request, res: Response) {
    const { credits } = req.body;
    const classSession = await scheduleService.completeClass(req.params.id, Number(credits || 0));
    return res.status(HTTP_STATUS.OK).json(successResponse(classSession, 'Class session completed and credits awarded successfully'));
  },

  async rateClass(req: Request, res: Response) {
    const { rating, feedback } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: 'Rating must be a number between 1 and 5.',
      });
    }
    const classSession = await scheduleService.rateClass(req.params.id, Number(rating), feedback);
    return res.status(HTTP_STATUS.OK).json(successResponse(classSession, 'Class rating submitted successfully'));
  },
};
