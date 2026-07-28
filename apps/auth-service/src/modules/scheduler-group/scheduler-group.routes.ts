import { Router, Request, Response, NextFunction } from 'express';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { schedulerGroupService } from './scheduler-group.service';
import {
  validateCreateGroup,
  validateUpdateGroup,
  validateUpdateMembers,
} from './scheduler-group.schema';

const router = Router();

// GET / - List all scheduler groups
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schedulerId = typeof req.query.schedulerId === 'string' ? req.query.schedulerId : undefined;
    const groups = await schedulerGroupService.getAllGroups({ schedulerId });
    res.status(HTTP_STATUS.OK).json(successResponse(groups, 'Scheduler groups fetched successfully'));
  } catch (error) {
    next(error);
  }
});

// POST / - Create a new scheduler group
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = validateCreateGroup(req.body);
    const group = await schedulerGroupService.createGroup(validated);
    res.status(HTTP_STATUS.CREATED).json(successResponse(group, 'Scheduler group created successfully'));
  } catch (error) {
    next(error);
  }
});

// GET /:id - Get group details with members
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await schedulerGroupService.getGroupById(req.params.id);
    res.status(HTTP_STATUS.OK).json(successResponse(group, 'Scheduler group details fetched successfully'));
  } catch (error) {
    next(error);
  }
});

// PUT /:id - Update group metadata or reassign scheduler
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = validateUpdateGroup(req.body);
    const updated = await schedulerGroupService.updateGroup(req.params.id, validated);
    res.status(HTTP_STATUS.OK).json(successResponse(updated, 'Scheduler group updated successfully'));
  } catch (error) {
    next(error);
  }
});

// POST /:id/members - Add/remove mentors or students
router.post('/:id/members', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = validateUpdateMembers(req.body);
    const updated = await schedulerGroupService.updateGroupMembers(req.params.id, validated);
    res.status(HTTP_STATUS.OK).json(successResponse(updated, 'Group members updated successfully'));
  } catch (error) {
    next(error);
  }
});

// DELETE /:id - Delete group
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await schedulerGroupService.deleteGroup(req.params.id);
    res.status(HTTP_STATUS.OK).json(successResponse(null, 'Scheduler group deleted successfully'));
  } catch (error) {
    next(error);
  }
});

export const schedulerGroupRoutes = router;
