import { Request, Response } from 'express';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { roleService } from './role.service';
import { validateCreateRole, validateUpdateRole } from './role.schema';

export const roleController = {
  async list(req: Request, res: Response) {
    const roles = await roleService.getAllRoles();
    return res.status(HTTP_STATUS.OK).json(successResponse(roles, 'Roles fetched successfully'));
  },

  async getById(req: Request, res: Response) {
    const role = await roleService.getRoleById(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(role, 'Role fetched successfully'));
  },

  async create(req: Request, res: Response) {
    const input = validateCreateRole(req.body);
    const role = await roleService.createRole(input);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(role, 'Role created successfully'));
  },

  async update(req: Request, res: Response) {
    const input = validateUpdateRole(req.body);
    const role = await roleService.updateRole(req.params.id, input);
    return res.status(HTTP_STATUS.OK).json(successResponse(role, 'Role updated successfully'));
  },

  async delete(req: Request, res: Response) {
    await roleService.deleteRole(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Role deleted successfully'));
  },
};
