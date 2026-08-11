import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { scheduleController } from './schedule.controller';

/**
 * Every route below is mounted behind the gateway's `authenticate`, so a caller
 * always holds *a* valid token — which is the whole reason authorization cannot
 * live here. There is no role middleware in this codebase; each handler's gate
 * is in `schedule.service.ts`, decided from the HMAC-signed `x-user-id` and
 * `x-user-role` the gateway injects and never from the body or query string.
 *
 * A route added here is open until its service method gates it. The comments
 * below record which predicate each one ended up with, so the next person to add
 * a sibling route can see what the neighbours require of a caller.
 */
const router = Router();

router.get('/mentors', asyncHandler(scheduleController.listMentors));
// Service-to-service only: the presence pollers and the Zoom webhook reporting
// an emptied room. The gateway *does* proxy this prefix, so the handler refuses
// any request carrying gateway identity headers rather than trusting the path.
router.post('/internal/room-ended', asyncHandler(scheduleController.markRoomEnded));
// Static prefix, so "students" is never matched as a class id by "/:id".
// Gated: the student, their parent, or a mentor who teaches them.
router.get('/students/:studentId/overview', asyncHandler(scheduleController.getStudentOverview));
// Gated: scope derived from the caller — ADMIN/QA_AUDITOR see the queue,
// everyone else sees only the reports they filed. `?reporterId=` only narrows.
router.get('/reports', asyncHandler(scheduleController.listReports));
// Gated: the reporter must have been in the class, or be staff.
router.post('/reports', asyncHandler(scheduleController.createReport));
// Gated: ADMIN / QA_AUDITOR — it writes the verdict and notifies the reporter.
router.put('/reports/:id', asyncHandler(scheduleController.updateReport));
// Static prefix again: "doubts" must be claimed before "/:id" can swallow it as
// a class id. The inbox spans classes, so it hangs off the collection, not a class.
router.get('/doubts/inbox', asyncHandler(scheduleController.listDoubtInbox));
router.post('/doubts/:doubtId/answer', asyncHandler(scheduleController.answerDoubt));
router.get('/',       asyncHandler(scheduleController.list));
router.post('/',      asyncHandler(scheduleController.create));
router.put('/:id/complete', asyncHandler(scheduleController.completeClass));
router.post('/:id/rate', asyncHandler(scheduleController.rateClass));
router.get('/:id/reflection', asyncHandler(scheduleController.getReflection));
router.post('/:id/reflection', asyncHandler(scheduleController.submitReflection));
router.post('/:id/reflection/review', asyncHandler(scheduleController.reviewReflection));
router.get('/:id/doubts', asyncHandler(scheduleController.listDoubts));
router.post('/:id/doubts', asyncHandler(scheduleController.createDoubt));
// Gated: staff, or someone who was in the class. Participants get a narrowed
// payload — the transcript and the reflection answer key are auditor-only.
router.get('/:id',    asyncHandler(scheduleController.getById));
// Gated per *field*, not per role, because students, parents and mentors all
// use this route to request a reschedule. Slot/mentor/link/status/credits are
// ADMIN+SCHEDULER; qaStatus/qaFeedback are ADMIN+QA_AUDITOR; a participant may
// only write a reschedule reason and flip SCHEDULED ⇄ RESCHEDULE_REQUESTED.
router.put('/:id',    asyncHandler(scheduleController.update));
// Gated: ADMIN / SCHEDULER. `?deleteAll=true` wipes a child's whole remaining
// timetable for a programme, so there is no participant tier.
router.delete('/:id', asyncHandler(scheduleController.delete));

export const scheduleRoutes = router;
