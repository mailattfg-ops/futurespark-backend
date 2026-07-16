import { db } from '../../database/datasource';
import { CreateRoleInput, UpdateRoleInput } from './role.schema';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export const roleService = {
  async getAllRoles() {
    // Self-healing: Ensure PARENT role exists in DB
    const parentRole = await db.role.findUnique({ where: { name: 'PARENT' } });
    if (!parentRole) {
      await db.role.create({
        data: {
          name: 'PARENT',
          description: 'Parent accounts managing connected profiles and student billing information.',
          permissions: ['view:lessons']
        }
      });
    }

    const roles = await db.role.findMany({
      include: {
        _count: {
          select: { users: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    const parentCount = await db.parentAccount.count();
    const studentCount = await db.student.count();

    // Map _count.users to userCount, correctly counting non-user tables for PARENT and STUDENT roles
    return roles.map(({ _count, ...rest }) => {
      let count = _count.users;
      if (rest.name === 'PARENT') {
        count = parentCount;
      } else if (rest.name === 'STUDENT') {
        count = studentCount + _count.users;
      }
      return {
        ...rest,
        userCount: count,
      };
    });
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
    let count = _count.users;
    if (role.name === 'PARENT') {
      count = await db.parentAccount.count();
    } else if (role.name === 'STUDENT') {
      count = (await db.student.count()) + _count.users;
    }

    return {
      ...rest,
      userCount: count,
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
    if (role.name === 'ADMIN' || role.name === 'STUDENT' || role.name === 'PARENT') {
      throw new AppError('Cannot delete system reserved roles', HTTP_STATUS.BAD_REQUEST);
    }
    if (role.userCount > 0) {
      throw new AppError('Cannot delete a role that has assigned users', HTTP_STATUS.BAD_REQUEST);
    }
    return db.role.delete({ where: { id: role.id } });
  },
};
