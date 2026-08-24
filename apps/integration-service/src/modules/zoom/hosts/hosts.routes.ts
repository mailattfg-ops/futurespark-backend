import { Router, Request, Response } from 'express';
import { HTTP_STATUS } from '@futurespark/constants';
import { successResponse, errorResponse } from '@futurespark/response';
import { logger } from '@futurespark/logger';
import { createHost, deleteHost, listHosts, updateHost, verifyHost, ZoomHostError,
} from './hosts.service';

/**
 * /zoom/hosts — the licensed Zoom seat register, managed from the admin UI.
 *
 * Reached through the gateway's existing `/api/zoom` proxy, so no gateway
 * change was needed. ADMIN-only, judged from the gateway-injected x-user-role
 * header the same way the neighbouring modules do it: a seat controls which
 * Zoom account children's classes run on, and the list carries staff emails.
 */

const router = Router();

const isAdmin = (req: Request): boolean =>
  String(req.headers['x-user-role'] ?? '').toUpperCase() === 'ADMIN';

const requireAdmin = (req: Request, res: Response): boolean => {
  if (isAdmin(req)) return true;
  res.status(HTTP_STATUS.FORBIDDEN).json(errorResponse('Only an admin can manage Zoom hosts.'));
  return false;
};

/** A refusal an admin can act on is a 400, not a 500. */
const fail = (res: Response, err: any, fallback: string) => {
  if (err instanceof ZoomHostError) {
    const status = err.code === 'NOT_FOUND' ? HTTP_STATUS.NOT_FOUND : HTTP_STATUS.BAD_REQUEST;
    return res.status(status).json(errorResponse(err.message));
  }
  logger.error(`[ZoomHosts] ${fallback}: ${err?.message ?? err}`);
  return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err?.message || fallback));
};

router.get('/', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const data = await listHosts();
    return res.status(HTTP_STATUS.OK).json(successResponse(data, 'Zoom hosts loaded.'));
  } catch (err: any) {
    return fail(res, err, 'Failed to load Zoom hosts');
  }
});

router.post('/', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const host = await createHost(req.body ?? {});
    return res.status(HTTP_STATUS.CREATED).json(successResponse(host, `${host.email} added as a Zoom host.`));
  } catch (err: any) {
    return fail(res, err, 'Failed to add the Zoom host');
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const host = await updateHost(req.params.id, req.body ?? {});
    return res.status(HTTP_STATUS.OK).json(successResponse(host, `${host.email} updated.`));
  } catch (err: any) {
    return fail(res, err, 'Failed to update the Zoom host');
  }
});

/** Ask Zoom what this address really is. Advisory — never blocks a save. */
router.post('/:id/verify', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const host = await verifyHost(req.params.id);
    return res
      .status(HTTP_STATUS.OK)
      .json(successResponse(host, host.verifiedAt ? `Zoom confirmed ${host.email} is ${host.verifiedType}.` : 'Zoom could not confirm this seat.'));
  } catch (err: any) {
    return fail(res, err, 'Failed to verify the Zoom host');
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const host = await deleteHost(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(host, `${host.email} removed.`));
  } catch (err: any) {
    return fail(res, err, 'Failed to delete the Zoom host');
  }
});

export const zoomHostsRouter = router;
