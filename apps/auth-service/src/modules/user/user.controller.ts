import { Request, Response } from 'express';
import { logger } from '@futurespark/logger';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { userService } from './user.service';
import { validateCreateUser, validateUpdateUser, validateListUsers } from './user.schema';

export const userController = {
  async create(req: Request, res: Response) {
    const input = validateCreateUser(req.body);
    const user = await userService.createUser(input);
    logger.info(`[User] Created: ${user.email}`);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(user, 'User created successfully'));
  },

  async getById(req: Request, res: Response) {
    const user = await userService.getUserById(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(user, 'User fetched successfully'));
  },

  async list(req: Request, res: Response) {
    const query = validateListUsers(req.query);
    const result = await userService.listUsers(query);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Users fetched successfully'));
  },

  async update(req: Request, res: Response) {
    const input = validateUpdateUser(req.body);
    const user = await userService.updateUser(req.params.id, input);
    logger.info(`[User] Updated: ${user.id}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(user, 'User updated successfully'));
  },

  async delete(req: Request, res: Response) {
    const user = await userService.deleteUser(req.params.id);
    logger.info(`[User] Deleted: ${user.id}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(user, 'User deleted successfully'));
  },

  async resetPassword(req: Request, res: Response) {
    const { password } = req.body;
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'Password is required and must be at least 8 characters' });
    }
    const user = await userService.resetUserPassword(req.params.id, password);
    logger.info(`[User] Reset Password: ${user.id}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(user, 'Password reset successfully'));
  },
};