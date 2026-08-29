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
    const lead = await (db as any).pilotLead.create({
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

    // Dispatch System In-App & WhatsApp Notification for Pilot Lead Application
    const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://127.0.0.1:3003';
    fetch(`${COMMUNICATION_SERVICE_URL}/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientId: 'ADMIN',
        title: 'New Pilot Program Application',
        message: `New 1-on-1 Mentorship Pilot lead: ${input.parentName} for student ${input.studentName} (Grade ${input.studentGrade}). Phone: ${input.parentPhone}, Email: ${input.parentEmail}`,
        priority: 'HIGH',
      }),
    }).catch((err) => {
      console.error('[Pilot Lead Notification Dispatch Error]', err.message);
    });

    return lead;
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
