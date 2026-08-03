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
        assignedAdvisorId: input.assignedAdvisorId,
        preferredDays: input.preferredDays || [],
        preferredTime: input.preferredTime,
        preferredTimezone: input.preferredTimezone || 'Asia/Kolkata',
        paymentAmount: input.paymentAmount,
        paymentTxnRef: input.paymentTxnRef,
        paymentMethod: input.paymentMethod,
        paymentStatus: input.paymentStatus || 'NONE',
        telecallerNotes: input.telecallerNotes,
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
        assignedAdvisorId: input.assignedAdvisorId !== undefined ? input.assignedAdvisorId : undefined,
        preferredDays: input.preferredDays !== undefined ? input.preferredDays : undefined,
        preferredTime: input.preferredTime !== undefined ? input.preferredTime : undefined,
        preferredTimezone: input.preferredTimezone !== undefined ? input.preferredTimezone : undefined,
        paymentAmount: input.paymentAmount !== undefined ? input.paymentAmount : undefined,
        paymentTxnRef: input.paymentTxnRef !== undefined ? input.paymentTxnRef : undefined,
        paymentMethod: input.paymentMethod !== undefined ? input.paymentMethod : undefined,
        paymentStatus: input.paymentStatus !== undefined ? input.paymentStatus : undefined,
        paymentVerifiedBy: input.paymentVerifiedBy !== undefined ? input.paymentVerifiedBy : undefined,
        paymentVerifiedAt: input.paymentVerifiedAt !== undefined ? new Date(input.paymentVerifiedAt) : undefined,
        telecallerNotes: input.telecallerNotes !== undefined ? input.telecallerNotes : undefined,
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

  async collectPayment(id: string, payload: {
    preferredDays: string[];
    preferredTime: string;
    preferredTimezone?: string;
    paymentAmount: number;
    paymentTxnRef: string;
    paymentMethod: string;
    telecallerNotes?: string;
  }) {
    await this.getLeadById(id);
    return db.lead.update({
      where: { id },
      data: {
        preferredDays: payload.preferredDays || [],
        preferredTime: payload.preferredTime,
        preferredTimezone: payload.preferredTimezone || 'Asia/Kolkata',
        paymentAmount: payload.paymentAmount,
        paymentTxnRef: payload.paymentTxnRef,
        paymentMethod: payload.paymentMethod,
        paymentStatus: 'SUBMITTED',
        status: 'PAYMENT_SUBMITTED',
        telecallerNotes: payload.telecallerNotes,
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

  async verifyPayment(id: string, adminUserId: string) {
    await this.getLeadById(id);
    return db.lead.update({
      where: { id },
      data: {
        paymentStatus: 'VERIFIED',
        paymentVerifiedBy: adminUserId,
        paymentVerifiedAt: new Date(),
        status: 'ENROLLED',
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
