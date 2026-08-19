import { Router, type Request, type Response } from 'express';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import db from '../../database/datasource';
import { recordAudit, resolveActorName, type AuditEntry } from '../shared/audit';

/**
 * /audit — the Activity Log feed for the admin's /logs page.
 * Rows are written by the audit middleware in auth-service and
 * learning-service (one shared table in the auth schema).
 */

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  if (String(req.headers['x-user-role'] ?? '').toUpperCase() !== 'ADMIN') {
    return res
      .status(HTTP_STATUS.FORBIDDEN)
      .json(errorResponse('Only an admin can read the activity log.'));
  }

  try {
    const role = typeof req.query.role === 'string' && req.query.role ? req.query.role.toUpperCase() : undefined;
    const entity = typeof req.query.entity === 'string' && req.query.entity ? req.query.entity : undefined;
    const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
    const q = typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined;
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));

    const [rows, entityGroups, roleGroups, categoryGroups] = await Promise.all([
      db.auditLog.findMany({
        where: {
          ...(role ? { actorRole: role } : {}),
          ...(entity ? { entityType: entity } : {}),
          ...(category ? { category } : {}),
          ...(q
            ? {
                OR: [
                  { summary: { contains: q, mode: 'insensitive' } },
                  { actorName: { contains: q, mode: 'insensitive' } },
                  { entityName: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: { occurredAt: 'desc' },
        take: limit,
      }),
      db.auditLog.groupBy({ by: ['entityType'], _count: { _all: true } }),
      db.auditLog.groupBy({ by: ['actorRole'], _count: { _all: true } }),
      db.auditLog.groupBy({ by: ['category'], _count: { _all: true } }),
    ]);

    res.status(HTTP_STATUS.OK).json(
      successResponse(
        {
          rows,
          entityTypes: entityGroups.map((g) => g.entityType).sort(),
          roles: roleGroups.map((g) => g.actorRole).filter(Boolean).sort() as string[],
          categories: categoryGroups.map((g) => g.category).sort(),
        },
        'Activity log loaded.'
      )
    );
  } catch (err: any) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message));
  }
});

/**
 * Internal write endpoint for services on OTHER databases (integration-service
 * cannot reach the auth-schema table directly). Service-to-service only: the
 * gateway both refuses non-GET on /api/audit and stamps every proxied request
 * with x-internal-signature — a request carrying that stamp came from a
 * browser and is rejected here as a second line of defence.
 */
router.post('/record', async (req: Request, res: Response) => {
  if (req.headers['x-internal-signature']) {
    return res.status(HTTP_STATUS.FORBIDDEN).json(errorResponse('Not accessible from outside.'));
  }
  try {
    const entry = req.body as AuditEntry;
    if (!entry?.summary || !entry?.action || !entry?.entityType) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('summary, action and entityType are required.'));
    }
    // The writing service has no user tables — put the name on here.
    if (entry.actorId && !entry.actorName) {
      entry.actorName = await resolveActorName(entry.actorId, entry.actorRole ?? undefined);
      if (entry.actorName) {
        entry.summary = entry.summary.replace(/^(An? [a-z ]+|Someone)\b/, entry.actorName);
      }
    }
    await recordAudit(entry);
    res.status(HTTP_STATUS.OK).json(successResponse({ recorded: true }, 'Recorded.'));
  } catch (err: any) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message));
  }
});

export const auditRoutes = router;
