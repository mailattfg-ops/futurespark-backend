import { db } from '../../database/datasource';
import { CreateGroupInput, UpdateGroupInput } from './scheduler-group.schema';

export const schedulerGroupRepository = {
  async create(data: CreateGroupInput) {
    return db.schedulerGroup.create({
      data: {
        name: data.name,
        description: data.description,
        schedulerId: data.schedulerId,
        maxMentors: data.maxMentors ?? 50,
        maxStudents: data.maxStudents ?? 100,
      },
      include: {
        scheduler: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        _count: {
          select: { mentors: true, students: true },
        },
      },
    });
  },

  async findById(id: string) {
    return db.schedulerGroup.findUnique({
      where: { id },
      include: {
        scheduler: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        mentors: {
          select: { id: true, email: true, firstName: true, lastName: true, mentorTypes: true, isActive: true },
        },
        students: {
          select: { id: true, email: true, firstName: true, lastName: true, isActive: true, studentCode: true },
        },
        _count: {
          select: { mentors: true, students: true },
        },
      },
    });
  },

  async findByName(name: string) {
    return db.schedulerGroup.findUnique({
      where: { name },
    });
  },

  async update(id: string, data: UpdateGroupInput) {
    return db.schedulerGroup.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.schedulerId !== undefined && { schedulerId: data.schedulerId }),
        ...(data.maxMentors !== undefined && { maxMentors: data.maxMentors }),
        ...(data.maxStudents !== undefined && { maxStudents: data.maxStudents }),
      },
      include: {
        scheduler: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        _count: {
          select: { mentors: true, students: true },
        },
      },
    });
  },

  async delete(id: string) {
    return db.schedulerGroup.delete({
      where: { id },
    });
  },

  async findAll(filters?: { schedulerId?: string }) {
    const where: any = {};
    if (filters?.schedulerId) {
      where.schedulerId = filters.schedulerId;
    }

    return db.schedulerGroup.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        scheduler: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        // Ids, not a bare count: the scheduler-facing mentors page shows only
        // the mentors of the viewer's own groups, and it matches on these.
        // With _count alone that filter compared against undefined and every
        // scheduler saw an empty mentors tab.
        mentors: { select: { id: true } },
        _count: {
          select: { mentors: true, students: true },
        },
      },
    });
  },

  async addMentors(groupId: string, mentorIds: string[]) {
    return db.user.updateMany({
      where: { id: { in: mentorIds } },
      data: { schedulerGroupId: groupId },
    });
  },

  async removeMentors(mentorIds: string[]) {
    return db.user.updateMany({
      where: { id: { in: mentorIds } },
      data: { schedulerGroupId: null },
    });
  },

  async addStudents(groupId: string, studentIds: string[]) {
    return db.student.updateMany({
      where: { id: { in: studentIds } },
      data: { schedulerGroupId: groupId },
    });
  },

  async removeStudents(studentIds: string[]) {
    return db.student.updateMany({
      where: { id: { in: studentIds } },
      data: { schedulerGroupId: null },
    });
  },
};
