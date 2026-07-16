import { Router } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { courseController } from './course.controller';
import { requireInternalAuth, requireRoles } from '../../middlewares/auth';
import { leadRoutes } from '../lead/lead.routes';

const router = Router();

router.use(requireInternalAuth);

router.use('/leads', leadRoutes);

// ── Global session directory ─────────────────────────────────
router.get('/sessions', asyncHandler(courseController.getAllSessions));
router.post('/sessions', requireRoles(['ADMIN', 'INSTRUCTOR']), asyncHandler(courseController.createSession));
router.put('/sessions/:id', requireRoles(['ADMIN', 'INSTRUCTOR']), asyncHandler(courseController.updateSession));
router.delete('/sessions/:id', requireRoles(['ADMIN', 'INSTRUCTOR']), asyncHandler(courseController.deleteSession));

// ── Program routes ───────────────────────────────────────────
router.get('/', asyncHandler(courseController.getAllPrograms));
router.post('/', requireRoles(['ADMIN', 'INSTRUCTOR']), asyncHandler(courseController.createProgram));
router.get('/:id', asyncHandler(courseController.getProgramById));
router.put('/:id', requireRoles(['ADMIN', 'INSTRUCTOR']), asyncHandler(courseController.updateProgram));
router.delete('/:id', requireRoles(['ADMIN', 'INSTRUCTOR']), asyncHandler(courseController.deleteProgram));

// ── Nested sessions under a program ──────────────────────────
router.post('/:programId/sessions', requireRoles(['ADMIN', 'INSTRUCTOR']), asyncHandler(courseController.createSession));

// ── Payment plans per program (upsert by type) ───────────────
router.put('/:programId/payment-plans', requireRoles(['ADMIN', 'INSTRUCTOR']), asyncHandler(courseController.upsertPaymentPlan));
router.delete('/:programId/payment-plans/:type', requireRoles(['ADMIN', 'INSTRUCTOR']), asyncHandler(courseController.deletePaymentPlan));

export const courseRoutes = router;
