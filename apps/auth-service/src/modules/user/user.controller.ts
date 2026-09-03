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

  async listCustomers(req: Request, res: Response) {
    const result = await userService.listCustomers();
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Customers fetched successfully'));
  },

  async getCustomerById(req: Request, res: Response) {
    const result = await userService.getCustomerById(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Customer fetched successfully'));
  },

  async createCustomer(req: Request, res: Response) {
    const { email, password, programId, profiles } = req.body;
    if (!email || !password || !Array.isArray(profiles) || profiles.length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'Email, password, and profiles are required' });
    }
    const result = await userService.createCustomer({ email, password, programId, profiles });
    logger.info(`[Customer] Created: ${result.email}`);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(result, 'Customer created successfully'));
  },

  async deleteCustomer(req: Request, res: Response) {
    const result = await userService.deleteCustomer(req.params.id);
    logger.info(`[Customer] Deleted: ${result.id}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Customer deleted successfully'));
  },

  async listAllStudents(req: Request, res: Response) {
    const result = await userService.listAllStudents();
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Students fetched successfully'));
  },

  /** Sign one of this parent's children up to another programme. */
  async addEnrollment(req: Request, res: Response) {
    const { parentId } = req.params;
    const { studentId, programId } = req.body;
    const result = await userService.addEnrollment(parentId, { studentId, programId });
    logger.info(`[Enrollment] Student ${studentId} enrolled in program ${programId} (parent ${parentId})`);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(result, 'Program added'));
  },

  /** Every programme a child is on, with the payment state that governs them. */
  async listEnrollments(req: Request, res: Response) {
    const result = await userService.effectiveEnrollments(req.params.studentId);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Enrollments fetched'));
  },

  /** Finance's write: approve or withdraw payment on one enrolment. */
  async updateEnrollment(req: Request, res: Response) {
    const { paymentApproved, selectedPlanType, paidInstallmentIds } = req.body;
    const result = await userService.updateEnrollment(req.params.enrollmentId, {
      paymentApproved,
      selectedPlanType,
      paidInstallmentIds,
    });
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Enrollment updated'));
  },

  async removeEnrollment(req: Request, res: Response) {
    const result = await userService.removeEnrollment(req.params.enrollmentId);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Program removed'));
  },

  async createStudent(req: Request, res: Response) {
    const { parentId } = req.params;
    // `programId` is optional but deliberate: the form asks for an explicit
    // choice, and an omitted one now means "no programme yet" rather than
    // silently inheriting whatever a sibling's family already paid for.
    const { email, password, firstName, lastName, programId } = req.body;
    if (!email || !password || !firstName || !lastName) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'All student details are required' });
    }
    const result = await userService.createStudentForParent(parentId, {
      email, password, firstName, lastName, programId,
    });
    logger.info(`[Student] Created: ${result.email} under Parent: ${parentId}`);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(result, 'Student created successfully'));
  },

  async deleteStudent(req: Request, res: Response) {
    const result = await userService.deleteStudent(req.params.id);
    logger.info(`[Student] Deleted: ${result.id}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Student deleted successfully'));
  },

  async createParentProfile(req: Request, res: Response) {
    const { parentId } = req.params;
    const { firstName, lastName, phone, relationship } = req.body;
    if (!firstName || !lastName || !relationship) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'First name, last name, and relationship are required' });
    }
    const result = await userService.createParentProfile(parentId, { firstName, lastName, phone, relationship });
    logger.info(`[Parent Profile] Created profile for parentAccount: ${parentId}`);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(result, 'Parent profile created successfully'));
  },

  async resetParentPassword(req: Request, res: Response) {
    const { id } = req.params;
    const { password } = req.body;
    if (!password) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'Password is required' });
    }
    const result = await userService.resetParentPassword(id, password);
    logger.info(`[Parent Password Reset] Reset password for parentAccountId: ${id}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Parent password reset successfully'));
  },

  async updateParentAccount(req: Request, res: Response) {
    const { id } = req.params;
    // A parent updating their own account may choose a programme and a photo —
    // nothing else. The raw body carries money fields (paymentApproved,
    // paidInstallmentIds) that only staff may write; passing them through for a
    // self-update would let a family approve its own payment.
    const role = String(req.headers['x-user-role'] ?? '');
    const input = ['ADMIN', 'SCHEDULER'].includes(role)
      ? req.body
      : { programId: req.body.programId, avatarUrl: req.body.avatarUrl };
    const result = await userService.updateParentAccount(id, input);
    logger.info(`[Parent Account Update] Updated parentAccountId: ${id}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Parent account updated successfully'));
  },

  async updateParentProfile(req: Request, res: Response) {
    const { profileId } = req.params;
    const result = await userService.updateParentProfile(profileId, req.body);
    logger.info(`[Parent Profile Update] Updated parentProfileId: ${profileId}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Parent profile updated successfully'));
  },

  async resetStudentPassword(req: Request, res: Response) {
    const { id } = req.params;
    const { password } = req.body;
    if (!password) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'Password is required' });
    }
    const result = await userService.resetStudentPassword(id, password);
    logger.info(`[Student Password Reset] Reset password for studentId: ${id}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Student password reset successfully'));
  },

  async getStudentById(req: Request, res: Response) {
    const result = await userService.getStudentById(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Student fetched successfully'));
  },

  async updateStudent(req: Request, res: Response) {
    const { id } = req.params;
    const result = await userService.updateStudent(id, req.body);
    logger.info(`[Student Update] Updated studentId: ${id}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Student updated successfully'));
  },

  // ── Mentor Schedules ───────────────────────────────────────────────────────

  async getMentorSchedules(req: Request, res: Response) {
    const { id } = req.params;
    const schedules = await userService.getMentorSchedules(id);
    return res.status(HTTP_STATUS.OK).json(successResponse(schedules, 'Mentor schedules fetched'));
  },

  async addMentorSchedule(req: Request, res: Response) {
    const { id } = req.params;
    const { weekday, startTime, endTime, scheduleType, allowConflict } = req.body;
    if (weekday === undefined || weekday === null || !startTime) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'weekday and startTime are required' });
    }
    const slot = await userService.addMentorSchedule(
      id,
      {
        weekday: Number(weekday),
        startTime,
        endTime,
        scheduleType,
        // Only an explicit true overrides the conflict check — a stray "false"
        // string from a form post must not read as consent.
        allowConflict: allowConflict === true || allowConflict === 'true',
      },
      { id: req.headers['x-user-id'] as string | undefined, role: req.headers['x-user-role'] as string | undefined }
    );
    logger.info(
      `[Mentor Schedule] Added slot for mentorId: ${id} weekday=${weekday} ${slot.startTime}–${slot.endTime} ` +
        `type=${scheduleType || 'REGULAR'}${allowConflict ? ' (overlap accepted by the user)' : ''}`
    );
    return res.status(HTTP_STATUS.CREATED).json(successResponse(slot, 'Schedule slot added'));
  },

  async getMentorAvailability(req: Request, res: Response) {
    const result = await userService.getMentorAvailability(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Mentor availability fetched'));
  },

  async updateMentorAvailability(req: Request, res: Response) {
    const { availabilityMode, availabilityNote } = req.body;
    const result = await userService.updateMentorAvailability(
      req.params.id,
      { availabilityMode, availabilityNote },
      {
        id: req.headers['x-user-id'] as string | undefined,
        role: req.headers['x-user-role'] as string | undefined,
      }
    );
    logger.info(`[Mentor Availability] Updated mentorId: ${req.params.id} mode=${result.availabilityMode}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Availability updated'));
  },

  async deleteMentorSchedule(req: Request, res: Response) {
    const { scheduleId } = req.params;
    const result = await userService.deleteMentorSchedule(scheduleId, {
      id: req.headers['x-user-id'] as string | undefined,
      role: req.headers['x-user-role'] as string | undefined,
    });
    logger.info(`[Mentor Schedule] Deleted scheduleId: ${scheduleId}`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Schedule slot deleted'));
  },

  async warnUser(req: Request, res: Response) {
    const { targetId, targetRole, reason } = req.body;
    if (!targetId || !targetRole || !reason) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'targetId, targetRole, and reason are required' });
    }
    const result = await userService.warnUser(targetId, targetRole, reason);
    logger.info(`[QA Action] Warned user: ${targetId} (role: ${targetRole})`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'Warning issued successfully'));
  },

  async blacklistUser(req: Request, res: Response) {
    const { targetId, targetRole, reason } = req.body;
    if (!targetId || !targetRole || !reason) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'targetId, targetRole, and reason are required' });
    }
    const result = await userService.blacklistUser(targetId, targetRole, reason);
    logger.info(`[QA Action] Blacklisted user: ${targetId} (role: ${targetRole})`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'User blacklisted successfully'));
  },

  async unblacklistUser(req: Request, res: Response) {
    const { targetId, targetRole } = req.body;
    if (!targetId || !targetRole) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'targetId and targetRole are required' });
    }
    const result = await userService.unblacklistUser(targetId, targetRole);
    logger.info(`[QA Action] Unblacklisted user: ${targetId} (role: ${targetRole})`);
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'User unblacklisted successfully'));
  },

  async getUserQAInfo(req: Request, res: Response) {
    const { targetId, targetRole } = req.query;
    if (!targetId || !targetRole) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, message: 'targetId and targetRole queries are required' });
    }
    const result = await userService.getUserQAInfo(targetId as string, targetRole as string);
    if (!result) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, message: 'User not found' });
    }
    return res.status(HTTP_STATUS.OK).json(successResponse(result, 'User QA details fetched successfully'));
  },
};