import { Request, Response, NextFunction } from 'express';
import { verifyInternalHeaders } from '@futurespark/authentication';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';

/**
 * Finding S1-00: this service owns every child's and parent's record and every
 * class transcript, and until this file existed it authenticated NOBODY. The
 * gateway verified logins and forwarded an HMAC-signed identity — and this
 * service read the role header without ever checking the signature, while half
 * its routes read no identity at all. Anyone who could reach the port directly
 * was every role at once.
 *
 * Two lanes now, and no third:
 *
 *   People  — every request must carry the gateway's HMAC-signed identity
 *             headers, verified with the shared key and the 30-second replay
 *             window. All genuine gateway traffic passes untouched, because
 *             the gateway signs on every proxied request. A direct request
 *             with a bare `x-user-role: ADMIN` no longer means anything.
 *
 *   Machines — the handful of service-to-service paths (`/schedules/internal/*`,
 *             `/audit/record`) that by design carry NO user identity. They now
 *             require `x-internal-key` to equal INTERNAL_API_KEY. Absence of
 *             credentials is no longer treated as being a machine — which was
 *             the "wired backwards" check the finding called out.
 *
 * `/auth/*` is mounted before this middleware and stays public: login has to
 * work for someone who is not yet anyone, and change-password verifies its own
 * Bearer token.
 */

const MACHINE_PATHS = ['/audit/record'];
const MACHINE_PREFIXES = ['/schedules/internal/'];

const isMachinePath = (path: string): boolean =>
  MACHINE_PATHS.includes(path) || MACHINE_PREFIXES.some((p) => path.startsWith(p));

let warnedNoKey = false;

export const requireVerifiedIdentity = (req: Request, res: Response, next: NextFunction) => {
  /* The liveness probe answers anyone. It carries the capability list and no
   * data, and gating it made every monitor — including the gateway's own
   * system-health page — read this service as down while it was fine. */
  if (req.path === '/health') return next();

  if (isMachinePath(req.path)) {
    const key = process.env.INTERNAL_API_KEY;
    if (!key) {
      // Not configured yet: behave as before (perimeter trust), but say so
      // loudly once — this lane is only closed when the key is set everywhere.
      if (!warnedNoKey) {
        warnedNoKey = true;
        logger.warn(
          '[Identity] INTERNAL_API_KEY is not set — the service-to-service endpoints are relying on ' +
            'the network perimeter alone. Set it in the root .env for every service to close S1-00 fully.'
        );
      }
      return next();
    }
    if (req.headers['x-internal-key'] !== key) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: 'Internal key required.',
      });
    }
    return next();
  }

  try {
    const identity = verifyInternalHeaders(req.headers as Record<string, string | string[] | undefined>);
    (req as any).verifiedIdentity = identity;
    return next();
  } catch {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      message: 'Authentication required.',
    });
  }
};

/**
 * No response from this service ever carries a password hash.
 *
 * `listCustomers` and `listAllStudents` used Prisma `include` without `select`,
 * which returns every scalar on the row — so the roster endpoints were serving
 * `passwordHash` for every parent and student to anyone who could call them,
 * including through the gateway to any logged-in role. Rather than trust every
 * current and future query to remember a `select`, the field is stripped from
 * every JSON body at the door on the way out.
 */
const scrub = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) scrub(item);
    return;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('passwordHash' in record) delete record.passwordHash;
    for (const key of Object.keys(record)) scrub(record[key]);
  }
};

export const stripPasswordHashes = (_req: Request, res: Response, next: NextFunction) => {
  const original = res.json.bind(res);
  res.json = ((body: unknown) => {
    try {
      scrub(body);
    } catch {
      /* a scrub failure must never break a response — worst case the
       * per-endpoint sanitisers still apply */
    }
    return original(body);
  }) as Response['json'];
  next();
};
