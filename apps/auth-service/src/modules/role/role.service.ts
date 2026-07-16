import { db } from '../../database/datasource';
import { CreateRoleInput, UpdateRoleInput } from './role.schema';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export const roleService = {
  async getAllRoles() {
    const roles = await db.role.findMany({
      include: {
        _count: {
          select: { users: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Map _count.users to userCount
    return roles.map(({ _count, ...rest }) => ({
      ...rest,
      userCount: _count.users,
    }));
  },

  async getRoleById(id: string) {
    const role = await db.role.findUnique({
      where: { id },
      include: {
        _count: {
          select: { users: true },
        },
      },
    });

    if (!role) throw new AppError('Role not found', HTTP_STATUS.NOT_FOUND);

    const { _count, ...rest } = role;
    return {
      ...rest,
      userCount: _count.users,
    };
  },

  async createRole(input: CreateRoleInput) {
    const existing = await db.role.findUnique({
      where: { name: input.name },
    });
    if (existing) throw new AppError('Role name already exists', HTTP_STATUS.CONFLICT);

    return db.role.create({
      data: {
        name: input.name,
        description: input.description,
        permissions: input.permissions,
      },
    });
  },

  async updateRole(id: string, input: UpdateRoleInput) {
    const role = await this.getRoleById(id);
    return db.role.update({
      where: { id: role.id },
      data: {
        description: input.description !== undefined ? input.description : undefined,
        permissions: input.permissions !== undefined ? input.permissions : undefined,
      },
    });
  },

  async deleteRole(id: string) {
    const role = await this.getRoleById(id);
    if (role.name === 'ADMIN' || role.name === 'STUDENT') {
      throw new AppError('Cannot delete system reserved roles', HTTP_STATUS.BAD_REQUEST);
    }
    if (role.userCount > 0) {
      throw new AppError('Cannot delete a role that has assigned users', HTTP_STATUS.BAD_REQUEST);
    }
    return db.role.delete({ where: { id: role.id } });
  },
};
