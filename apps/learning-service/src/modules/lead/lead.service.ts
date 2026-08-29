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

  /**
   * A PilotLead presented in the Lead shape the demo-class portal expects.
   *
   * The two tables ask for the same facts under different column names — one
   * `parentName` where the other has `firstName`/`lastName`. Splitting on the
   * first space is imperfect for compound surnames, but the alternative is
   * showing the family a blank where their name belongs.
   */
  async getPilotLeadAsLead(id: string) {
    const pilot = await (db as any).pilotLead.findUnique({ where: { id } });
    if (!pilot) throw new AppError('Lead not found', HTTP_STATUS.NOT_FOUND);

    const splitName = (full: string | null | undefined): [string, string] => {
      const parts = String(full ?? '').trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return ['', ''];
      return [parts[0], parts.slice(1).join(' ')];
    };

    const [parentFirst, parentLast] = splitName(pilot.parentName);
    const [studentFirst, studentLast] = splitName(pilot.studentName);

    // Pilot demos booked through the scheduler stamp the class with this same
    // id, so the join link appears here the moment one is scheduled — exactly
    // as it does for a regular demo lead.
    const latestClass = await db.scheduledClass.findFirst({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        meetingLink: true,
        startTime: true,
        endTime: true,
        status: true,
        classType: true,
      },
    });

    return {
      id: pilot.id,
      firstName: parentFirst,
      lastName: parentLast,
      email: pilot.parentEmail,
      phone: pilot.parentPhone,
      studentFirstName: studentFirst,
      studentLastName: studentLast,
      source: 'Pilot Program',
      status: pilot.status,
      programId: null,
      program: null,
      notes: pilot.telecallerNotes ?? null,
      demoClass: true,
      preferredDays: pilot.preferredSlotDate ? [pilot.preferredSlotDate] : [],
      preferredTime: pilot.preferredSlotTime ?? null,
      preferredTimezone: pilot.preferredTimezone ?? 'Asia/Kolkata',
      telecallerNotes: pilot.telecallerNotes ?? null,
      createdAt: pilot.createdAt,
      updatedAt: pilot.updatedAt,
      // Pilot-only detail the regular Lead has no column for. Additive, so a
      // reader expecting a Lead is unaffected.
      isPilotLead: true,
      studentGrade: pilot.studentGrade ?? null,
      presentCountry: pilot.presentCountry ?? null,
      preferredLanguage: pilot.preferredLanguage ?? null,
      scheduledClass: latestClass || null,
      meetingUrl: latestClass?.meetingLink || null,
      meetingLink: latestClass?.meetingLink || null,
    };
  },

  /**
   * Confirm a row exists in the Lead table, and only there.
   *
   * `getLeadById` now answers for pilot applicants too, which is right for the
   * public portal read but wrong for the writers below: they all call
   * `db.lead.update`/`delete`, so accepting a pilot id would turn a clean 404
   * into a raw Prisma "record not found" from one line further down.
   */
  async assertLeadExists(id: string) {
    const found = await db.lead.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new AppError('Lead not found', HTTP_STATUS.NOT_FOUND);
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

    // A pilot applicant is a lead to the family holding the link, but lives in
    // its own table — so /demo-class?leadId=<pilotId> used to 404 here and the
    // parent got a dead page. Rather than teach the landing page a second
    // endpoint and a second response shape, the one public lookup answers for
    // both and returns the shape the page already reads.
    if (!lead) return this.getPilotLeadAsLead(id);

    // Fetch the latest scheduled class for this lead (if any)
    const latestClass = await db.scheduledClass.findFirst({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        meetingLink: true,
        startTime: true,
        endTime: true,
        status: true,
        classType: true,
      },
    });

    const extractedNotesUrl = (lead.notes || '').match(/(https?:\/\/[^\s]+)/)?.[1] || (lead.telecallerNotes || '').match(/(https?:\/\/[^\s]+)/)?.[1];
    const meetingUrl = latestClass?.meetingLink || extractedNotesUrl || null;

    return {
      ...lead,
      scheduledClass: latestClass || null,
      meetingUrl,
      meetingLink: latestClass?.meetingLink || null,
    };
  },

  async createLead(input: CreateLeadInput) {
    const lead = await db.lead.create({
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        studentFirstName: input.studentFirstName,
        studentLastName: input.studentLastName,
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

    // Dispatch System In-App Notification for Lead Creation
    const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://127.0.0.1:3003';
    const parentName = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'Parent';
    const studentName = [lead.studentFirstName, lead.studentLastName].filter(Boolean).join(' ').trim() || lead.studentFirstName || 'Student';

    fetch(`${COMMUNICATION_SERVICE_URL}/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientId: 'ADMIN',
        title: 'New Demo Class Lead',
        message: `New Demo Class lead request from ${parentName} for student ${studentName}. Phone: ${lead.phone || 'N/A'}, Email: ${lead.email}`,
        priority: 'HIGH',
      }),
    }).catch((err) => {
      console.error('[Lead Notification Dispatch Error]', err?.message);
    });

    // Trigger WhatsApp session reminder asynchronously
    if (lead.phone) {
      const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://127.0.0.1:3003';
      const parentName = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'Parent';
      const studentName = [lead.studentFirstName, lead.studentLastName].filter(Boolean).join(' ').trim() || lead.studentFirstName || 'Student';
      const courseName = lead.program?.title || 'Financial Literacy';
      const sessionTime = lead.preferredTime || '04:00 PM';
      const timezone = lead.preferredTimezone || 'IST';
      const baseUrl = process.env.LANDING_PAGE_URL || 'https://junior.finquo.ai';
      const joinUrl = `${baseUrl.replace(/\/$/, '')}/demo-class?leadId=${lead.id}`;

      let sessionDate = new Date().toLocaleDateString('en-GB');
      if (lead.notes && typeof lead.notes === 'string') {
        const match = lead.notes.match(/(\d{2}\/\d{2}\/\d{4})/);
        if (match && match[1]) {
          sessionDate = match[1];
        }
      } else if (Array.isArray(lead.preferredDays) && lead.preferredDays.length > 0) {
        sessionDate = lead.preferredDays.join(', ');
      }

      fetch(`${COMMUNICATION_SERVICE_URL}/whatsapp/session-reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: lead.phone,
          parentName,
          studentName,
          courseName,
          sessionDate,
          sessionTime,
          timezone,
          joinUrl,
        }),
      }).catch(() => {
        // Non-blocking catch
      });
    }

    return lead;
  },

  async updateLead(id: string, input: UpdateLeadInput) {
    await this.assertLeadExists(id);
    return db.lead.update({
      where: { id },
      data: {
        firstName: input.firstName !== undefined ? input.firstName : undefined,
        lastName: input.lastName !== undefined ? input.lastName : undefined,
        email: input.email !== undefined ? input.email : undefined,
        phone: input.phone !== undefined ? input.phone : undefined,
        // Empty string means "clear it", which has to reach the column as NULL.
        // Passing '' through would leave a name that is present but blank, and
        // every reader's "does this lead name a child?" check would then pass
        // and render nothing.
        studentFirstName:
          input.studentFirstName !== undefined ? input.studentFirstName || null : undefined,
        studentLastName:
          input.studentLastName !== undefined ? input.studentLastName || null : undefined,
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
    await this.assertLeadExists(id);
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
    await this.assertLeadExists(id);
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
    await this.assertLeadExists(id);
    return db.lead.delete({
      where: { id },
    });
  },
};
