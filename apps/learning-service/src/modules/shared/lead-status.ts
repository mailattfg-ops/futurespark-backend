/**
 * Lead pipeline statuses, in one place.
 *
 * They were duplicated in lead.schema.ts and pilot-lead.schema.ts, so adding a
 * stage meant remembering both — and the two lists had already drifted apart.
 * The Prisma enums (LeadStatus / PilotLeadStatus) must stay in step with this.
 */

/** Every status a lead may hold. Order is the order the dropdown shows. */
export const LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'INTERESTED',
  'DEMO_SCHEDULED',
  'PILOT_REGISTERED',
  'PILOT_ONGOING',
  'ADMISSION_PENDING',
  'PAYMENT_SUBMITTED',
  'ENROLLED',
  'NOT_INTERESTED',
  'DROPPED',
  'LOST_NOT_RESPONDING',
  'COLD',
  'LOST',
] as const;

/** Pilot leads share the pipeline, minus the two payment stages they never use. */
export const PILOT_LEAD_STATUSES = LEAD_STATUSES.filter(
  (s) => s !== 'ADMISSION_PENDING' && s !== 'PAYMENT_SUBMITTED'
);

/**
 * Statuses that RELEASE a held demo slot.
 *
 * Slot capacity counts leads whose status is not "dead" — a family that said no
 * must not keep a demo seat occupied, or the widget reports slots full while
 * the calendar is empty. Only LOST used to count as dead; every new dead stage
 * has to be listed here or it silently holds a seat forever.
 *
 * ENROLLED is deliberately NOT here: that is existing behaviour, and changing
 * which leads occupy capacity is a separate decision from adding stages.
 */
export const INACTIVE_LEAD_STATUSES = [
  'LOST',
  'NOT_INTERESTED',
  'DROPPED',
  'LOST_NOT_RESPONDING',
  'COLD',
] as const;

export type LeadStatusValue = (typeof LEAD_STATUSES)[number];
