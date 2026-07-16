import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export interface CreateRoleInput {
  name: string;
  description?: string;
  permissions: string[];
}

export const validateCreateRole = (data: any): CreateRoleInput => {
  const errors: string[] = [];

  if (!data.name || typeof data.name !== 'string') {
    errors.push('Role name is required and must be a string');
  } else if (!/^[A-Z0-9_]+$/.test(data.name)) {
    errors.push('Role name must contain only uppercase alphanumeric characters and underscores');
  }

  if (data.description !== undefined && typeof data.description !== 'string') {
    errors.push('Description must be a string');
  }

  if (!data.permissions || !Array.isArray(data.permissions)) {
    errors.push('Permissions is required and must be an array of strings');
  } else {
    for (const p of data.permissions) {
      if (typeof p !== 'string') {
        errors.push('Each permission must be a string');
        break;
      }
    }
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    name: data.name.trim().toUpperCase(),
    description: data.description?.trim() || undefined,
    permissions: data.permissions,
  };
};

export interface UpdateRoleInput {
  description?: string;
  permissions?: string[];
}

export const validateUpdateRole = (data: any): UpdateRoleInput => {
  const errors: string[] = [];

  if (data.description !== undefined && typeof data.description !== 'string') {
    errors.push('Description must be a string');
  }

  if (data.permissions !== undefined) {
    if (!Array.isArray(data.permissions)) {
      errors.push('Permissions must be an array of strings');
    } else {
      for (const p of data.permissions) {
        if (typeof p !== 'string') {
          errors.push('Each permission must be a string');
          break;
        }
      }
    }
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  return {
    description: data.description?.trim() || undefined,
    permissions: data.permissions,
  };
};
