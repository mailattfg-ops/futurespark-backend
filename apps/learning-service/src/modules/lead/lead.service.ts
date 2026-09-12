import { db } from '../../database/datasource';
import { sendLeadEvent } from '../shared/meta-capi';
import { CreateLeadInput, UpdateLeadInput } from './lead.schema';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';
import { pilotLeadService } from '../pilot-lead/pilot-lead.service';

export const leadService = {
  /**
   * A family asking to move their own demo, from the portal link they were sent.
   *
   * Public on purpose — a parent has no staff credentials, and the alternative
   * the portal used before was to POST a WHOLE NEW LEAD carrying the request in
   * its notes. That duplicated the family in the CRM on every click, left the
   * original booking untouched (so the change vanished on refresh), fired a
   * "New Demo Class Lead" alert at the team, and sent the parent another
   * WhatsApp reminder pointing at the duplicate.
   *
   * Scoped by the lead id in the URL: it can only ever move the one booking that
   * id names, and it writes nothing a staff member would not have written.
   */
  async requestReschedule(
    leadId: string,
    input: { date?: string; time?: string; timezone?: string; reason?: string }
  ) {
    const lead = await db.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new AppError('Booking not found', HTTP_STATUS.NOT_FOUND);

    const date = String(input.date ?? '').trim();
    const time = String(input.time ?? '').trim();
    if (!date || !time) {
      throw new AppError('A date and a time are both required', HTTP_STATUS.BAD_REQUEST);
    }

    // A slot the admin has switched off must not be bookable by editing the
    // request, the same rule createPilotLead enforces for new bookings.
    const { hiddenSlots } = await pilotLeadService.getDemoSettings();
    if (hiddenSlots.includes(time)) {
      throw new AppError(
        `The time slot '${time}' is currently unavailable. Please choose another time.`,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const timezone = String(input.timezone ?? '').trim() || lead.preferredTimezone || 'Asia/Kolkata';
    const reason = String(input.reason ?? '').trim();
    const stamp = new Date().toISOString();

    const updated = await db.lead.update({
      where: { id: leadId },
      data: {
        preferredDays: [date],
        preferredTime: time,
        preferredTimezone: timezone,
        // Appended, never replaced — the original signup answers stay readable.
        notes: `${lead.notes ? `${lead.notes}\n` : ''}[Reschedule Requested ${stamp}] ${date} at ${time} (${timezone}).${reason ? ` Reason: ${reason}` : ''}`,
      },
    });

    // Tell the team. No new lead, and no WhatsApp to the FAMILY — the slot is a
    // REQUEST until a scheduler confirms it and moves the class.
    const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://127.0.0.1:3003';
    const parentName = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'A parent';
    const studentName =
      [lead.studentFirstName, lead.studentLastName].filter(Boolean).join(' ').trim() ||
      lead.studentFirstName ||
      'Student';

    /* On WhatsApp as well as in-app: a reschedule is time-critical — the old
     * slot may be hours away — and an in-app notification is only seen by
     * whoever happens to be logged in. DEMO_RESCHEDULED maps to the same
     * approved internal_demo_scheduled template. */
    fetch(`${COMMUNICATION_SERVICE_URL}/whatsapp/internal-notify-staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'DEMO_RESCHEDULED',
        context: {
          studentName,
          grade: typeof lead.notes === 'string' ? lead.notes.match(/Grade:\s*([^,\n]+)/i)?.[1]?.trim() || '-' : '-',
          country: '-',
          parentContact: lead.phone || '-',
          date,
          time,
          mentorName: 'To be assigned',
          meetingLink: 'To be created',
        },
      }),
    }).catch((err) => console.error('[Reschedule Internal Notify Error]', err?.message));

    fetch(`${COMMUNICATION_SERVICE_URL}/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientId: 'ADMIN',
        title: 'Demo Reschedule Requested',
        message: `${parentName} asked to move their demo to ${date} at ${time} (${timezone}).${reason ? ` Reason: ${reason}` : ''} Phone: ${lead.phone || 'N/A'}`,
        priority: 'HIGH',
      }),
    }).catch((err) => console.error('[Reschedule Notification Error]', err?.message));

    return updated;
  },

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

    /* ── Meta Conversions API ─────────────────────────────────────────────
     * The server-side "Lead", fired ONLY after the row above committed —
     * validation failures and database errors never reach this line. Not
     * awaited, like the notification and WhatsApp dispatches below it: Meta
     * being slow is Meta's problem, never the family's. */
    if (!input.staffEntry) {
      sendLeadEvent({
        email: lead.email,
        phone: lead.phone,
        firstName: lead.firstName,
        eventId: input.eventId,
      })
        .then((capiEventId) => {
          if (capiEventId) console.log(`[Meta CAPI] Lead event ${capiEventId} sent for ${lead.email}`);
        })
        .catch((err: any) => console.error('Meta CAPI failed:', err?.message ?? err));
    }

    // Dispatch System In-App Notification for Lead Creation
    const COMMUNICATION_SERVICE_URL = process.env.COMMUNICATION_SERVICE_URL || 'http://127.0.0.1:3003';
    const parentName = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'Parent';
    const studentName = [lead.studentFirstName, lead.studentLastName].filter(Boolean).join(' ').trim() || lead.studentFirstName || 'Student';

    /* Tell the TEAM on WhatsApp that a demo needs putting on the calendar.
     *
     * Only the pilot "reserve your seat" widget did this, so a booking from the
     * claim-free-class form reached the team as an in-app notification alone —
     * which nobody sees unless they happen to be logged in. Same approved
     * template (internal_demo_scheduled) and the same staff-number lookup the
     * pilot path uses.
     *
     * Scoped to PUBLIC demo bookings: a telecaller entering a lead by hand
     * already knows about it, and messaging them about their own typing is
     * noise that trains people to ignore the channel.
     */
    if (lead.demoClass && !input.staffEntry) {
      const gradeFromNotes = typeof lead.notes === 'string' ? lead.notes.match(/Grade:\s*([^,\n]+)/i)?.[1]?.trim() : undefined;
      fetch(`${COMMUNICATION_SERVICE_URL}/whatsapp/internal-notify-staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'DEMO_SCHEDULED',
          context: {
            studentName,
            grade: gradeFromNotes || '-',
            country: '-',
            parentContact: lead.phone || '-',
            date: lead.preferredDays?.[0] || 'to be confirmed',
            time: lead.preferredTime || 'to be confirmed',
            // The form only states a preference — a human assigns the mentor
            // and creates the room, which is what this message asks for.
            mentorName: 'To be assigned',
            meetingLink: 'To be created',
          },
        }),
      }).catch((err) => console.error('[Lead Internal Notify Error]', err?.message));
    }

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
