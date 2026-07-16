import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { userController } from './user.controller';

const router = Router();

// Student Accounts Management (must be defined before /customers/:id catch-all)
router.get('/customers/students',            asyncHandler(userController.listAllStudents));
router.put('/customers/students/:id/reset-password', asyncHandler(userController.resetStudentPassword));
router.put('/customers/students/:id',                asyncHandler(userController.updateStudent));
router.delete('/customers/students/:id',      asyncHandler(userController.deleteStudent));

// Profile Connections Management (must be defined before /customers/:id catch-all)
router.put('/customers/profiles/:profileId',         asyncHandler(userController.updateParentProfile));

// Customer (Parent Account) & Student Creation
router.get('/customers',                     asyncHandler(userController.listCustomers));
router.post('/customers',                    asyncHandler(userController.createCustomer));
router.post('/customers/:parentId/students', asyncHandler(userController.createStudent));
router.post('/customers/:parentId/profiles', asyncHandler(userController.createParentProfile));

// Customer Account Actions (catch-all parameter routes)
router.get('/customers/:id',                 asyncHandler(userController.getCustomerById));
router.put('/customers/:id/reset-password',  asyncHandler(userController.resetParentPassword));
router.put('/customers/:id',                 asyncHandler(userController.updateParentAccount));
router.delete('/customers/:id',              asyncHandler(userController.deleteCustomer));

// Mentor Schedule Management
router.get('/mentors/:id/schedules',              asyncHandler(userController.getMentorSchedules));
router.post('/mentors/:id/schedules',             asyncHandler(userController.addMentorSchedule));
router.delete('/mentors/schedules/:scheduleId',   asyncHandler(userController.deleteMentorSchedule));

// Standard User Management
router.get('/',       asyncHandler(userController.list));
router.post('/',      asyncHandler(userController.create));
router.get('/:id',    asyncHandler(userController.getById));
router.put('/:id',    asyncHandler(userController.update));
router.put('/:id/reset-password', asyncHandler(userController.resetPassword));
router.delete('/:id', asyncHandler(userController.delete));

export const userRoutes = router;