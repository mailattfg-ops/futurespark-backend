import { enqueue, startWorker } from '@futurespark/queue';
import { db } from '../../database/datasource';

/**
 * Abandoned-form nurture: the marketing template, ten minutes later.
 *
 * Someone who starts the claim-free-class form and walks away gets one nudge.
 * Someone who FINISHES it must not — they get the session reminder from the
 * completed-lead path instead, and two templates minutes apart reads as spam.
 *
 * ── How the two paths stay independent ────────────────────────────────────
 * Completing the form DELETES the partial record. This worker sends only if
 * that record is still present when the job runs, so neither path needs to know
 * the other exists — no flags passed between them, no shared state to keep in
 * sync. The database row is the single source of truth for "did they finish?".
 *
 * Idempotency comes from the job id (one job per partial record), so repeated
 * saves of the same form cannot queue a second message.
 */
export const PARTIAL_LEAD_QUEUE = 'partial-lead-followup';
const JOB_NAME = 'marketing-nudge';

export const FOLLOW_UP_DELAY_MS =
  Number(process.env.PARTIAL_LEAD_FOLLOWUP_MINUTES ?? 10) * 60 * 1000;

export interface PartialLeadNudge {
  partialLeadId: string;
  to: string;
  parentName: string;
}

/** Queue the nudge. Never throws — a form submission must not fail on Redis. */
export const schedulePartialLeadNudge = async (payload: PartialLeadNudge): Promise<void> => {
  const queued = await enqueue(PARTIAL_LEAD_QUEUE, JOB_NAME, payload, {
    delay: FOLLOW_UP_DELAY_MS,
    // One job per partial record: a second save of the same form is ignored by
    // BullMQ rather than producing a duplicate message.
    //
    // A hyphen, NOT a colon — BullMQ reserves ':' as its Redis key separator and
    // rejects any custom id containing one ("Custom Id cannot contain :"), which
    // silently dropped every nudge.
    jobId: `nudge-${payload.partialLeadId}`,
  });
  if (queued) {
    console.log(
      `[PartialLead] Nudge queued for ${payload.partialLeadId} in ${FOLLOW_UP_DELAY_MS / 60000} min.`
    );
  }
};

export const startPartialLeadWorker = () =>
  startWorker(
    PARTIAL_LEAD_QUEUE,
    async (job) => {
      const { partialLeadId, to, parentName } = job.data as PartialLeadNudge;

      // The completion check. Gone = they finished the form (or an admin removed
      // them); either way this message must not go out.
      const record = await (db as any).partialLead.findUnique({ where: { id: partialLeadId } });
      if (!record) {
        console.log(`[PartialLead] ${partialLeadId} completed or removed — nudge skipped.`);
        return;
      }
      if (record.status !== 'PARTIAL') {
        console.log(`[PartialLead] ${partialLeadId} is ${record.status} — nudge skipped.`);
        return;
      }

      const landingUrl = process.env.LANDING_PAGE_URL || 'https://junior.finquo.ai';
      const COMMUNICATION_SERVICE_URL =
        process.env.COMMUNICATION_SERVICE_URL || 'http://127.0.0.1:3003';

      const res = await fetch(`${COMMUNICATION_SERVICE_URL}/whatsapp/send-marketing-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to,
          parentName: parentName || record.parentName || record.studentName || 'Parent',
          templateName: 'finquo_free_demo_marketing',
          claimUrl: `${landingUrl.replace(/\/$/, '')}/claim-free-class`,
        }),
      });

      // Thrown, not swallowed: BullMQ retries a genuine failure, and the job id
      // keeps that retry pointed at the same single message.
      if (!res.ok) {
        throw new Error(`communication-service answered ${res.status}`);
      }
      console.log(`[PartialLead] Nudge sent for ${partialLeadId}.`);
    },
    3
  );
