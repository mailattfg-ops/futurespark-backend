import { db } from '../../database/datasource';
import { CreatePilotLeadInput, UpdatePilotLeadInput } from './pilot-lead.schema';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export const pilotLeadService = {
  async getAllPilotLeads() {
    return (db as any).pilotLead.findMany({
      orderBy: { createdAt: 'desc' },
    });
  },

  async getPilotLeadById(id: string) {
    const lead = await (db as any).pilotLead.findUnique({
      where: { id },
    });
    if (!lead) throw new AppError('Pilot Lead not found', HTTP_STATUS.NOT_FOUND);
    return lead;
  },

  async createPilotLead(input: CreatePilotLeadInput) {
    return (db as any).pilotLead.create({
      data: {
        parentName: input.parentName,
        studentName: input.studentName,
        studentGrade: input.studentGrade,
        parentEmail: input.parentEmail,
        parentPhone: input.parentPhone,
        presentCountry: input.presentCountry,
        preferredLanguage: input.preferredLanguage,
        hearAbout: input.hearAbout || null,
        status: 'NEW',
        preferredSlotDate: input.preferredSlotDate || null,
        preferredSlotTime: input.preferredSlotTime || null,
        preferredTimezone: input.preferredTimezone || 'Asia/Kolkata',
        telecallerNotes: input.telecallerNotes || null,
      },
    });
  },

  async updatePilotLead(id: string, input: UpdatePilotLeadInput) {
    const existing = await (db as any).pilotLead.findUnique({ where: { id } });
    if (!existing) throw new AppError('Pilot Lead not found', HTTP_STATUS.NOT_FOUND);

    return (db as any).pilotLead.update({
      where: { id },
      data: input,
    });
  },

  async deletePilotLead(id: string) {
    const existing = await (db as any).pilotLead.findUnique({ where: { id } });
    if (!existing) throw new AppError('Pilot Lead not found', HTTP_STATUS.NOT_FOUND);

    await (db as any).pilotLead.delete({ where: { id } });
    return { success: true, message: 'Pilot Lead deleted successfully' };
  },
};
