import { db } from '../../database/datasource';
import { SavePartialLeadInput } from './partial-lead.schema';
import { leadService } from '../lead/lead.service';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export const partialLeadService = {
  async getAllPartialLeads() {
    return (db as any).partialLead.findMany({
      orderBy: { createdAt: 'desc' },
    });
  },

  async getById(id: string) {
    const record = await (db as any).partialLead.findUnique({ where: { id } });
    if (!record) throw new AppError('Partial lead record not found', HTTP_STATUS.NOT_FOUND);
    return record;
  },

  async savePartialLead(input: SavePartialLeadInput) {
    const fullPhone = `${input.dialCode || '+91'} ${input.phone}`.trim();
    let existingRecord = null;

    if (input.id) {
      existingRecord = await (db as any).partialLead.findUnique({ where: { id: input.id } });
    }

    if (!existingRecord && input.phone) {
      existingRecord = await (db as any).partialLead.findFirst({
        where: {
          phone: input.phone,
          status: 'PARTIAL',
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    let record: any;
    const now = new Date();

    if (existingRecord) {
      record = await (db as any).partialLead.update({
        where: { id: existingRecord.id },
        data: {
          studentName: input.studentName || existingRecord.studentName,
          studentGrade: input.studentGrade || existingRecord.studentGrade,
          dialCode: input.dialCode || existingRecord.dialCode,
          phone: input.phone || existingRecord.phone,
          email: input.email || existingRecord.email,
          hasLaptop: input.hasLaptop !== undefined ? input.hasLaptop : existingRecord.hasLaptop,
          preferredSlotDate: input.preferredSlotDate !== undefined ? input.preferredSlotDate : existingRecord.preferredSlotDate,
          preferredSlotTime: input.preferredSlotTime !== undefined ? input.preferredSlotTime : existingRecord.preferredSlotTime,
          parentName: input.parentName !== undefined ? input.parentName : existingRecord.parentName,
          whoAreYou: input.whoAreYou !== undefined ? input.whoAreYou : existingRecord.whoAreYou,
          bookingReason: input.bookingReason !== undefined ? input.bookingReason : existingRecord.bookingReason,
          purchaseTimeline: input.purchaseTimeline !== undefined ? input.purchaseTimeline : existingRecord.purchaseTimeline,
        },
      });
    } else {
      record = await (db as any).partialLead.create({
        data: {
          studentName: input.studentName,
          studentGrade: input.studentGrade,
          dialCode: input.dialCode || '+91',
          phone: input.phone,
          email: input.email,
          hasLaptop: input.hasLaptop !== undefined ? input.hasLaptop : true,
          preferredSlotDate: input.preferredSlotDate || null,
          preferredSlotTime: input.preferredSlotTime || null,
          parentName: input.parentName || null,
          whoAreYou: input.whoAreYou || null,
          bookingReason: input.bookingReason || null,
          purchaseTimeline: input.purchaseTimeline || null,
          status: 'PARTIAL',
          notifiedAt: now,
        },
      });
    }

    // Trigger Notification for Section 1 completion if not notified yet or new record
    if (!existingRecord?.notifiedAt || !record.notifiedAt) {
      await (db as any).partialLead.update({
        where: { id: record.id },
        data: { notifiedAt: now },
      }).catch(() => {});

      // 1. Dispatch System In-App Admin Notification
      const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://127.0.0.1:3003';
      fetch(`${COMMUNICATION_SERVICE_URL}/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientId: 'ADMIN',
          title: 'Partial Form Submitted (Step 1)',
          message: `Partial registration started by ${record.studentName} (Phone: ${fullPhone}, Email: ${record.email}). Grade: ${record.studentGrade}`,
          priority: 'MEDIUM',
        }),
      }).catch((err) => console.error('[Partial Lead Admin Notification Error]', err?.message));

      // 2. Dispatch WhatsApp Notification / Reminder to Parent's Phone
      if (record.phone) {
        const landingUrl = process.env.LANDING_PAGE_URL || 'https://junior.finquo.ai';
        fetch(`${COMMUNICATION_SERVICE_URL}/whatsapp/session-reminder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: fullPhone,
            parentName: record.parentName || record.studentName,
            studentName: record.studentName,
            courseName: 'Free Trial Coding Class',
            sessionDate: record.preferredSlotDate || new Date().toLocaleDateString('en-GB'),
            sessionTime: record.preferredSlotTime || 'Upcoming Slot',
            timezone: 'IST',
            joinUrl: `${landingUrl.replace(/\/$/, '')}/claim-free-class?id=${record.id}`,
          }),
        }).catch(() => {});
      }
    }

    return record;
  },

  async completePartialLead(input: SavePartialLeadInput) {
    // First save/update partial lead
    const partialRecord = await this.savePartialLead(input);

    // Promote/Save into main Lead section following current lead flow
    const splitNames = (nameStr?: string): { first: string; last: string } => {
      const parts = String(nameStr || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { first: 'Parent', last: '' };
      return { first: parts[0], last: parts.slice(1).join(' ') };
    };

    const parentSplit = splitNames(input.parentName || input.studentName);
    const studentSplit = splitNames(input.studentName);
    const fullPhone = `${input.dialCode || '+91'} ${input.phone}`.trim();

    const createdLead = await leadService.createLead({
      firstName: parentSplit.first,
      lastName: parentSplit.last || 'Lead',
      studentFirstName: studentSplit.first,
      studentLastName: studentSplit.last,
      email: input.email,
      phone: fullPhone,
      source: 'Claim Free Class Form',
      status: 'NEW',
      demoClass: true,
      notes: `[Claim Free Class Form Submission] Grade: ${input.studentGrade}, Role: ${input.whoAreYou || 'Parent'}, Reason: ${input.bookingReason || 'N/A'}, Timeline: ${input.purchaseTimeline || 'N/A'}, Laptop: ${input.hasLaptop ? 'Yes' : 'No'}`,
      preferredDays: input.preferredSlotDate ? [input.preferredSlotDate] : [],
      preferredTime: input.preferredSlotTime,
    });

    // Delete/Remove from partial forms once Section 3 is fully completed
    if (partialRecord?.id) {
      await (db as any).partialLead.delete({
        where: { id: partialRecord.id },
      }).catch(() => {});
    }

    return {
      lead: createdLead,
    };
  },

  async deletePartialLead(id: string) {
    const found = await (db as any).partialLead.findUnique({ where: { id } });
    if (!found) throw new AppError('Partial lead record not found', HTTP_STATUS.NOT_FOUND);
    return (db as any).partialLead.delete({ where: { id } });
  },
};
