import { Router, Request, Response } from 'express';
import { asyncHandler } from '@futurespark/middleware';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { requireInternalAuth, requireRoles } from '../../middlewares/auth';
import { resourceService, validateCreateResource } from './resource.service';

const router = Router();

// Same guard the course routes use: only the gateway's HMAC-signed headers get in.
router.use(requireInternalAuth);

/**
 * Who may publish. Mentors read the hub but do not write to it: material is
 * curated so every mentor teaching a session sees the same thing, rather than a
 * library that drifts per person. Keep this in step with CURATOR_ROLES in the
 * Resources Hub page — a role offered a button here but refused there is worse
 * than no button.
 */
const CURATOR_ROLES = ['ADMIN', 'INSTRUCTOR'];

const caller = (req: Request) => ({
  id: (req.headers['x-user-id'] as string) || '',
  role: (req.headers['x-user-role'] as string) || 'TEACHER',
});

/**
 * Reading is open to every signed-in role — a student opening their session
 * materials wants the same list a mentor prepping the class does. Writing is
 * mentor-and-up.
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId, programId } = req.query;
    const list = await resourceService.list({
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      programId: typeof programId === 'string' ? programId : undefined,
    });
    return res.status(HTTP_STATUS.OK).json(successResponse(list, 'Resources fetched'));
  })
);

router.post(
  '/',
  requireRoles(CURATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const input = validateCreateResource(req.body);
    const created = await resourceService.create(input, caller(req));
    return res.status(HTTP_STATUS.CREATED).json(successResponse(created, 'Resource added'));
  })
);

router.put(
  '/:id',
  requireRoles(CURATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const updated = await resourceService.update(req.params.id, req.body, caller(req));
    return res.status(HTTP_STATUS.OK).json(successResponse(updated, 'Resource updated'));
  })
);

router.delete(
  '/:id',
  requireRoles(CURATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const removed = await resourceService.remove(req.params.id, caller(req));
    return res.status(HTTP_STATUS.OK).json(successResponse(removed, 'Resource removed'));
  })
);

export const resourceRoutes = router;
