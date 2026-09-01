import { db } from '../../database/datasource';
import { CreatePilotLeadInput, UpdatePilotLeadInput } from './pilot-lead.schema';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export const pilotLeadService = {
  isSameDate(storedDate: string, targetDate: string): boolean {
    if (!storedDate || !targetDate) return false;
    const s = storedDate.trim().toLowerCase();
    const t = targetDate.trim().toLowerCase();
    if (s === t || s.includes(t) || t.includes(s)) return true;

    const extractParts = (str: string) => {
      const match = str.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
      if (match) return `${match[1].padStart(2, '0')}/${match[2].padStart(2, '0')}/${match[3]}`;
      return null;
    };
    const sPart = extractParts(s);
    const tPart = extractParts(t);
    if (sPart && tPart && sPart === tPart) return true;

    return false;
  },

  async getDemoSettings() {
    try {
      const row = await (db as any).appSetting.findUnique({ where: { key: 'demo_settings' } });
      const val = (row?.value as any) || {};
      const demoTeachersCount = typeof val.demoTeachersCount === 'number' && val.demoTeachersCount > 0 ? val.demoTeachersCount : 3;
      return { demoTeachersCount };
    } catch {
      return { demoTeachersCount: 3 };
    }
  },

  async updateDemoSettings(countInput: number) {
    const demoTeachersCount = Math.max(1, Math.floor(Number(countInput) || 3));
    await (db as any).appSetting.upsert({
      where: { key: 'demo_settings' },
      create: { key: 'demo_settings', value: { demoTeachersCount } },
      update: { value: { demoTeachersCount } },
    });
    return { demoTeachersCount };
  },

  async getSlotAvailability(dateQuery?: string) {
    const { demoTeachersCount } = await this.getDemoSettings();
    const leads = await (db as any).pilotLead.findMany({
      where: { status: { not: 'LOST' } },
      select: { preferredSlotDate: true, preferredSlotTime: true },
    });

    const defaultSlots = [
      "10:00 AM", "11:00 AM", "12:00 PM", "01:00 PM", "02:00 PM", "03:00 PM",
      "04:00 PM", "05:00 PM", "06:00 PM", "07:00 PM", "08:00 PM", "09:00 PM",
    ];

    const slotCounts: Record<string, number> = {};
    defaultSlots.forEach((s) => (slotCounts[s] = 0));

    for (const lead of leads) {
      if (!lead.preferredSlotTime || !lead.preferredSlotDate) continue;
      if (dateQuery && !this.isSameDate(lead.preferredSlotDate, dateQuery)) continue;

      const slotTime = lead.preferredSlotTime;
      slotCounts[slotTime] = (slotCounts[slotTime] || 0) + 1;
    }

    const slotResults = defaultSlots.map((time) => {
      const bookedCount = slotCounts[time] || 0;
      const remainingSeats = Math.max(0, demoTeachersCount - bookedCount);
      const isBookedOut = bookedCount >= demoTeachersCount;
      return {
        time,
        bookedCount,
        maxCapacity: demoTeachersCount,
        remainingSeats,
        isBookedOut,
      };
    });

    return {
      demoTeachersCount,
      date: dateQuery || null,
      slots: slotResults,
    };
  },

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
    if (input.preferredSlotDate && input.preferredSlotTime) {
      const { demoTeachersCount } = await this.getDemoSettings();
      const existingLeads = await (db as any).pilotLead.findMany({
        where: {
          status: { not: 'LOST' },
          preferredSlotTime: input.preferredSlotTime,
        },
        select: { preferredSlotDate: true },
      });

      const matchingCount = existingLeads.filter((l: any) =>
        l.preferredSlotDate && this.isSameDate(l.preferredSlotDate, input.preferredSlotDate!)
      ).length;

      if (matchingCount >= demoTeachersCount) {
        throw new AppError(
          `The time slot '${input.preferredSlotTime}' on ${input.preferredSlotDate} is fully booked (${demoTeachersCount}/${demoTeachersCount} demo teachers booked). Please select another time slot.`,
          HTTP_STATUS.BAD_REQUEST
        );
      }
    }

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

    // Tell the team, in-app.
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

    // Tell the family, on WhatsApp.
    if (input.parentPhone) {
      const baseUrl = process.env.LANDING_PAGE_URL || 'https://junior.finquo.ai';
      fetch(`${COMMUNICATION_SERVICE_URL}/whatsapp/session-reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: input.parentPhone,
          parentName: input.parentName || 'Parent',
          studentName: input.studentName || 'Student',
          courseName: '1-on-1 Financial Literacy Mentorship',
          sessionDate: input.preferredSlotDate || 'to be confirmed',
          sessionTime: input.preferredSlotTime || 'to be confirmed',
          timezone: input.preferredTimezone || 'Asia/Kolkata',
          joinUrl: `${baseUrl.replace(/\/$/, '')}/demo-class?leadId=${lead.id}`,
        }),
      }).catch((err) => {
        console.error('[Pilot Lead WhatsApp Dispatch Error]', err?.message);
      });
    }

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
