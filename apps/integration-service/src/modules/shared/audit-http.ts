import type { NextFunction, Request, Response } from 'express';
import { logger } from '@futurespark/logger';

/**
 * Activity Log writer for integration-service.
 *
 * This service lives on its own database and cannot write the auth-schema
 * AuditLog table directly, so events are posted to auth-service's internal
 * /audit/record endpoint instead (fire-and-forget; the gateway refuses that
 * path from outside). auth-service resolves the actor's name and stores the
 * row. Structure mirrors the in-service middleware in auth/learning.
 */

const SERVICE = 'integration-service';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

const SENSITIVE_KEY = /pass|token|secret|otp|key|hash|auth|pin/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Machine traffic never audited: webhooks, presence polling, and the
 * class-lifecycle signal auth-service sends (already audited at its origin).
 */
const SKIP_PATH = /^\/(health|classes|zoom\/webhooks|google\/presence|zoom\/presence)\b/;

interface RouteRule {
  match: RegExp;
  action: string;
  entityType: string;
  summary: (who: string) => string;
}

const S = '[^/]+';
const rule = (
  method: string, pattern: string, action: string, entityType: string,
  summary: (who: string) => string
): RouteRule => ({
  match: new RegExp(`^${method} ${pattern.replace(/:[a-zA-Z]+/g, S)}/?$`),
  action, entityType, summary,
});

const ROUTE_RULES: RouteRule[] = [
  rule('POST', '/google/meetings/sync-manual', 'created', 'recording', (w) => `${w} linked a Google Meet recording`),
  rule('POST', '/zoom/recordings/sync', 'updated', 'recording', (w) => `${w} synced Zoom cloud recordings`),
  rule('POST', '/google/recordings/:id/download', 'updated', 'recording', (w) => `${w} downloaded a class recording`),
  rule('DELETE', '/google/recordings/:id', 'deleted', 'recording', (w) => `${w} deleted a class recording`),
  rule('DELETE', '/zoom/recordings/:id', 'deleted', 'recording', (w) => `${w} deleted a class recording`),
  rule('POST', '/storage/upload', 'created', 'storage', (w) => `${w} uploaded a file`),
];

const actorLabel = (role: string | null): string => {
  if (!role) return 'Someone';
  const r = role.toLowerCase();
  return r === 'admin' ? 'An admin' : r === 'system' ? 'The system' : `A ${r.replace(/_/g, ' ')}`;
};

const genericSummary = (who: string, method: string, path: string): string => {
  const verb = method === 'POST' ? 'created' : method === 'DELETE' ? 'deleted' : 'updated';
  const noun = path
    .split('/')
    .filter((seg) => seg && !UUID_RE.test(seg) && !/^\d+$/.test(seg))
    .slice(-2)
    .join(' ')
    .replace(/[-_]/g, ' ') || 'a record';
  return `${who} ${verb} ${noun}`;
};

const captureChanges = (body: unknown): Array<{ field: string; to: string }> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.entries(body as Record<string, unknown>)
    .filter(([k, v]) => !SENSITIVE_KEY.test(k) && v !== undefined && v !== null && typeof v !== 'object')
    .slice(0, 15)
    .map(([field, v]) => ({ field, to: String(v).slice(0, 120) }));
};

const post = (entry: object): void => {
  fetch(`${AUTH_SERVICE_URL}/audit/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  }).catch((err) => logger.warn(`[Audit] Could not post event to auth-service: ${err.message}`));
};

/**
 * A background-work event with no HTTP request behind it — the recording
 * sweep, the transcription job, the retry daemon. Fire-and-forget.
 */
export const recordSystemEvent = (event: {
  action: string;
  entityType: string;
  entityId?: string | null;
  entityName?: string | null;
  summary: string;
}): void => {
  post({ actorRole: 'SYSTEM', changes: [], service: SERVICE, ...event });
};

export const auditMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  // Snapshot NOW: inside res.on('finish') Express routers have mutated
  // req.path to be router-relative, which breaks every route rule.
  const reqPath = (req.originalUrl || req.url).split('?')[0];
  if (SKIP_PATH.test(reqPath)) return next();

  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;

    const actorId = (req.headers['x-user-id'] as string) || null;
    const actorRole = ((req.headers['x-user-role'] as string) || (actorId ? null : 'SYSTEM'))?.toUpperCase() ?? null;
    const who = actorLabel(actorRole);

    const key = `${method} ${reqPath}`;
    const matched = ROUTE_RULES.find((r) => r.match.test(key));

    post({
      actorId,
      actorRole,
      action: matched?.action ?? (method === 'POST' ? 'created' : method === 'DELETE' ? 'deleted' : 'updated'),
      entityType: matched?.entityType ?? 'recording',
      summary: matched ? matched.summary(who) : genericSummary(who, method, reqPath),
      changes: method === 'DELETE' ? [] : captureChanges(req.body),
      method,
      path: reqPath,
      service: SERVICE,
    });
  });

  next();
};
