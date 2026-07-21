import { db } from '../../database/datasource';
import { CreateLeadInput, UpdateLeadInput } from './lead.schema';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export const leadService = {
  async getAllLeads() {
    return db.lead.findMany({
      include: {
        program: {
          select: {
            id: true,
            title: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  async getLeadById(id: string) {
    const lead = await db.lead.findUnique({
      where: { id },
      include: {
        program: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });

    if (!lead) throw new AppError('Lead not found', HTTP_STATUS.NOT_FOUND);
    return lead;
  },

  async createLead(input: CreateLeadInput) {
    return db.lead.create({
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        source: input.source,
        status: input.status as any,
        programId: input.programId,
        notes: input.notes,
        demoClass: input.demoClass,
      },
      include: {
        program: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });
  },

  async updateLead(id: string, input: UpdateLeadInput) {
    await this.getLeadById(id);
    return db.lead.update({
      where: { id },
      data: {
        firstName: input.firstName !== undefined ? input.firstName : undefined,
        lastName: input.lastName !== undefined ? input.lastName : undefined,
        email: input.email !== undefined ? input.email : undefined,
        phone: input.phone !== undefined ? input.phone : undefined,
        source: input.source !== undefined ? input.source : undefined,
        status: input.status !== undefined ? (input.status as any) : undefined,
        programId: input.programId !== undefined ? input.programId : undefined,
        notes: input.notes !== undefined ? input.notes : undefined,
        demoClass: input.demoClass !== undefined ? input.demoClass : undefined,
      },
      include: {
        program: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });
  },

  async deleteLead(id: string) {
    await this.getLeadById(id);
    return db.lead.delete({
      where: { id },
    });
  },
};
