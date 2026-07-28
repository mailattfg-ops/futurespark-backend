import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';
import { schedulerGroupRepository } from './scheduler-group.repository';
import { CreateGroupInput, UpdateGroupInput, UpdateMembersInput } from './scheduler-group.schema';

export const schedulerGroupService = {
  async createGroup(input: CreateGroupInput) {
    const existing = await schedulerGroupRepository.findByName(input.name);
    if (existing) {
      throw new AppError('Scheduler group with this name already exists', HTTP_STATUS.CONFLICT);
    }
    return schedulerGroupRepository.create(input);
  },

  async getGroupById(id: string) {
    const group = await schedulerGroupRepository.findById(id);
    if (!group) {
      throw new AppError('Scheduler group not found', HTTP_STATUS.NOT_FOUND);
    }
    return group;
  },

  async getAllGroups(filters?: { schedulerId?: string }) {
    return schedulerGroupRepository.findAll(filters);
  },

  async updateGroup(id: string, input: UpdateGroupInput) {
    const group = await schedulerGroupRepository.findById(id);
    if (!group) {
      throw new AppError('Scheduler group not found', HTTP_STATUS.NOT_FOUND);
    }

    if (input.name && input.name !== group.name) {
      const existing = await schedulerGroupRepository.findByName(input.name);
      if (existing) {
        throw new AppError('Scheduler group with this name already exists', HTTP_STATUS.CONFLICT);
      }
    }

    return schedulerGroupRepository.update(id, input);
  },

  async updateGroupMembers(id: string, input: UpdateMembersInput) {
    const group = await schedulerGroupRepository.findById(id);
    if (!group) {
      throw new AppError('Scheduler group not found', HTTP_STATUS.NOT_FOUND);
    }

    // Capacity checks
    if (input.mentorIdsToAdd && input.mentorIdsToAdd.length > 0) {
      const currentMentorsCount = group._count.mentors;
      const newTotalMentors = currentMentorsCount + input.mentorIdsToAdd.length;
      if (newTotalMentors > group.maxMentors) {
        throw new AppError(
          `Cannot add ${input.mentorIdsToAdd.length} mentors. Group limit is ${group.maxMentors} (currently ${currentMentorsCount}).`,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      await schedulerGroupRepository.addMentors(id, input.mentorIdsToAdd);
    }

    if (input.mentorIdsToRemove && input.mentorIdsToRemove.length > 0) {
      await schedulerGroupRepository.removeMentors(input.mentorIdsToRemove);
    }

    if (input.studentIdsToAdd && input.studentIdsToAdd.length > 0) {
      const currentStudentsCount = group._count.students;
      const newTotalStudents = currentStudentsCount + input.studentIdsToAdd.length;
      if (newTotalStudents > group.maxStudents) {
        throw new AppError(
          `Cannot add ${input.studentIdsToAdd.length} students. Group limit is ${group.maxStudents} (currently ${currentStudentsCount}).`,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      await schedulerGroupRepository.addStudents(id, input.studentIdsToAdd);
    }

    if (input.studentIdsToRemove && input.studentIdsToRemove.length > 0) {
      await schedulerGroupRepository.removeStudents(input.studentIdsToRemove);
    }

    return schedulerGroupRepository.findById(id);
  },

  async deleteGroup(id: string) {
    const group = await schedulerGroupRepository.findById(id);
    if (!group) {
      throw new AppError('Scheduler group not found', HTTP_STATUS.NOT_FOUND);
    }
    return schedulerGroupRepository.delete(id);
  },
};
