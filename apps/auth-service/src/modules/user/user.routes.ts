import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { userController } from './user.controller';

const router = Router();

// Student Accounts Management (must be defined before /customers/:id catch-all)
router.get('/customers/students',            asyncHandler(userController.listAllStudents));
// Students are not in the User table, so GET /users/:id cannot resolve them.
router.get('/customers/students/:id',        asyncHandler(userController.getStudentById));
router.put('/customers/students/:id/reset-password', asyncHandler(userController.resetStudentPassword));
router.put('/customers/students/:id',                asyncHandler(userController.updateStudent));
router.delete('/customers/students/:id',      asyncHandler(userController.deleteStudent));

// Profile Connections Management (must be defined before /customers/:id catch-all)
router.put('/customers/profiles/:profileId',         asyncHandler(userController.updateParentProfile));

// Enrollments — which child is on which programme, and the money for it.
// Static prefixes again: all of these must sit above the `/customers/:id`
// catch-all or "enrollments" is matched as a parent account id.
router.get('/customers/students/:studentId/enrollments', asyncHandler(userController.listEnrollments));
router.put('/customers/enrollments/:enrollmentId',       asyncHandler(userController.updateEnrollment));
router.delete('/customers/enrollments/:enrollmentId',    asyncHandler(userController.removeEnrollment));

// Customer (Parent Account) & Student Creation
router.get('/customers',                     asyncHandler(userController.listCustomers));
router.post('/customers',                    asyncHandler(userController.createCustomer));
router.post('/customers/:parentId/students', asyncHandler(userController.createStudent));
// Scoped to the parent so the service can verify the child belongs to them —
// without that, any student id would be enrollable by anyone who can reach here.
router.post('/customers/:parentId/enrollments', asyncHandler(userController.addEnrollment));
router.post('/customers/:parentId/profiles', asyncHandler(userController.createParentProfile));

// Customer Account Actions (catch-all parameter routes)
router.get('/customers/:id',                 asyncHandler(userController.getCustomerById));
router.put('/customers/:id/reset-password',  asyncHandler(userController.resetParentPassword));
router.put('/customers/:id',                 asyncHandler(userController.updateParentAccount));
router.delete('/customers/:id',              asyncHandler(userController.deleteCustomer));

// Mentor Schedule Management
router.get('/mentors/:id/availability',           asyncHandler(userController.getMentorAvailability));
router.put('/mentors/:id/availability',           asyncHandler(userController.updateMentorAvailability));
router.get('/mentors/:id/schedules',              asyncHandler(userController.getMentorSchedules));
router.post('/mentors/:id/schedules',             asyncHandler(userController.addMentorSchedule));
router.delete('/mentors/schedules/:scheduleId',   asyncHandler(userController.deleteMentorSchedule));

// QA Disciplinary Actions
router.get('/qa-action/info',        asyncHandler(userController.getUserQAInfo));
router.post('/qa-action/warn',        asyncHandler(userController.warnUser));
router.post('/qa-action/blacklist',   asyncHandler(userController.blacklistUser));
router.post('/qa-action/unblacklist', asyncHandler(userController.unblacklistUser));

// Standard User Management
router.get('/',       asyncHandler(userController.list));
router.post('/',      asyncHandler(userController.create));
router.get('/:id',    asyncHandler(userController.getById));
router.put('/:id',    asyncHandler(userController.update));
router.put('/:id/reset-password', asyncHandler(userController.resetPassword));
router.delete('/:id', asyncHandler(userController.delete));

export const userRoutes = router;