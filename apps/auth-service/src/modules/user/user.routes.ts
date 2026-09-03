import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { userController } from './user.controller';
import { requireRole, allowSelfOr } from '../../middlewares/identity';

/**
 * Every route names its audience explicitly — default deny (BOLA/BFLA fix).
 *
 * requireVerifiedIdentity runs before this router, so x-user-role / x-user-id
 * are gateway-signed. requireRole checks the role; allowSelfOr additionally
 * lets the record's own subject through (a parent reading their own account, a
 * mentor editing their own availability) — which is why changing an id in the
 * URL gains nothing: the id is compared against the signed identity.
 *
 * DISPLAY appears in no list on purpose, and the gateway fences it besides.
 */
const STAFF_VIEW = ['ADMIN', 'SCHEDULER', 'FINANCE_ADMIN', 'QA_AUDITOR', 'WAREHOUSE_ADMIN', 'ENROLLMENT_ADVISOR'];
const STAFF_MANAGE = ['ADMIN', 'SCHEDULER'];
/** Advisors onboard families from leads, so they may create — not delete. */
const FAMILY_CREATE = ['ADMIN', 'SCHEDULER', 'ENROLLMENT_ADVISOR'];

const router = Router();

// Student Accounts Management (must be defined before /customers/:id catch-all)
router.get('/customers/students',            requireRole(...STAFF_VIEW), asyncHandler(userController.listAllStudents));
// Students are not in the User table, so GET /users/:id cannot resolve them.
router.get('/customers/students/:id',        allowSelfOr('id', ...STAFF_VIEW), asyncHandler(userController.getStudentById));
router.put('/customers/students/:id/reset-password', requireRole(...STAFF_MANAGE), asyncHandler(userController.resetStudentPassword));
router.put('/customers/students/:id',                requireRole(...STAFF_MANAGE), asyncHandler(userController.updateStudent));
router.delete('/customers/students/:id',      requireRole('ADMIN'), asyncHandler(userController.deleteStudent));

// Profile Connections Management (must be defined before /customers/:id catch-all)
router.put('/customers/profiles/:profileId',         requireRole(...STAFF_MANAGE), asyncHandler(userController.updateParentProfile));

// Enrollments — which child is on which programme, and the money for it.
// Static prefixes again: all of these must sit above the `/customers/:id`
// catch-all or "enrollments" is matched as a parent account id.
router.get('/customers/students/:studentId/enrollments', allowSelfOr('studentId', ...STAFF_VIEW), asyncHandler(userController.listEnrollments));
router.put('/customers/enrollments/:enrollmentId',       requireRole('ADMIN', 'SCHEDULER', 'FINANCE_ADMIN'), asyncHandler(userController.updateEnrollment));
router.delete('/customers/enrollments/:enrollmentId',    requireRole(...STAFF_MANAGE), asyncHandler(userController.removeEnrollment));

// Customer (Parent Account) & Student Creation
router.get('/customers',                     requireRole(...STAFF_VIEW), asyncHandler(userController.listCustomers));
router.post('/customers',                    requireRole(...FAMILY_CREATE), asyncHandler(userController.createCustomer));
router.post('/customers/:parentId/students', requireRole(...FAMILY_CREATE), asyncHandler(userController.createStudent));
// Scoped to the parent so the service can verify the child belongs to them —
// without that, any student id would be enrollable by anyone who can reach here.
router.post('/customers/:parentId/enrollments', requireRole(...FAMILY_CREATE), asyncHandler(userController.addEnrollment));
router.post('/customers/:parentId/profiles', allowSelfOr('parentId', ...FAMILY_CREATE), asyncHandler(userController.createParentProfile));

// Customer Account Actions (catch-all parameter routes).
// A parent may read and update their OWN account (my-children, parent
// dashboard); everyone else's requires staff.
router.get('/customers/:id',                 allowSelfOr('id', ...STAFF_VIEW), asyncHandler(userController.getCustomerById));
router.put('/customers/:id/reset-password',  requireRole(...STAFF_MANAGE), asyncHandler(userController.resetParentPassword));
router.put('/customers/:id',                 allowSelfOr('id', ...STAFF_MANAGE), asyncHandler(userController.updateParentAccount));
router.delete('/customers/:id',              requireRole('ADMIN'), asyncHandler(userController.deleteCustomer));

// Mentor Schedule Management — a mentor manages their own calendar; staff any.
router.get('/mentors/:id/availability',           allowSelfOr('id', ...STAFF_MANAGE), asyncHandler(userController.getMentorAvailability));
router.put('/mentors/:id/availability',           allowSelfOr('id', ...STAFF_MANAGE), asyncHandler(userController.updateMentorAvailability));
router.get('/mentors/:id/schedules',              allowSelfOr('id', ...STAFF_MANAGE), asyncHandler(userController.getMentorSchedules));
router.post('/mentors/:id/schedules',             allowSelfOr('id', ...STAFF_MANAGE), asyncHandler(userController.addMentorSchedule));
// ponytail: TEACHER can delete any slot by id here — the route has no mentor id
// to compare. Move ownership into the service if mentors ever abuse it.
router.delete('/mentors/schedules/:scheduleId',   requireRole('ADMIN', 'SCHEDULER', 'TEACHER'), asyncHandler(userController.deleteMentorSchedule));

// QA Disciplinary Actions
router.get('/qa-action/info',        requireRole('ADMIN', 'QA_AUDITOR'), asyncHandler(userController.getUserQAInfo));
router.post('/qa-action/warn',        requireRole('ADMIN', 'QA_AUDITOR'), asyncHandler(userController.warnUser));
router.post('/qa-action/blacklist',   requireRole('ADMIN', 'QA_AUDITOR'), asyncHandler(userController.blacklistUser));
router.post('/qa-action/unblacklist', requireRole('ADMIN', 'QA_AUDITOR'), asyncHandler(userController.unblacklistUser));

// Standard User Management (staff + mentors live here)
router.get('/',       requireRole(...STAFF_VIEW), asyncHandler(userController.list));
router.post('/',      requireRole(...STAFF_MANAGE), asyncHandler(userController.create));
router.get('/:id',    allowSelfOr('id', ...STAFF_VIEW), asyncHandler(userController.getById));
// No self lane: update() accepts roleId, and a mentor must not re-role themselves.
router.put('/:id',    requireRole(...STAFF_MANAGE), asyncHandler(userController.update));
router.put('/:id/reset-password', requireRole(...STAFF_MANAGE), asyncHandler(userController.resetPassword));
router.delete('/:id', requireRole('ADMIN'), asyncHandler(userController.delete));

export const userRoutes = router;
