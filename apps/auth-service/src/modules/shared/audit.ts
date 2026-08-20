import type { NextFunction, Request, Response } from 'express';
import { logger } from '@futurespark/logger';
import db from '../../database/datasource';

/**
 * The Activity Log writer — "who did what", as a human sentence.
 *
 * An Express middleware watches every successful mutating request, maps the
 * route to a readable event ("Parent SJ was created", "SJ updated their
 * name") and records it in AuditLog. Mapped routes get precise wording; any
 * unmapped mutation still lands with a generic sentence, so new endpoints are
 * never silently invisible.
 *
 * Everything here is best-effort: an audit failure must never fail the action
 * it describes. Bodies are captured for the "what changed" list with
 * credential-looking keys dropped.
 *
 * NOTE: learning-service carries a sibling of this file (its own route map);
 * both write the same auth-schema table.
 */

const SERVICE = 'auth-service';

const SENSITIVE_KEY = /pass|token|secret|otp|key|hash|auth|pin/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditEntry {
  actorId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityName?: string | null;
  summary: string;
  changes?: Array<{ field: string; to: string }> | null;
  method?: string;
  path?: string;
  /** Defaults from the entityType via CATEGORY_OF. */
  category?: string;
  /** Which service produced the event; defaults to this one. Set by /audit/record callers. */
  service?: string;
}

/** Broad groupings the UI filters by. One place to classify entity types. */
export const CATEGORY_OF: Record<string, string> = {
  login: 'auth',
  parent: 'people',
  student: 'people',
  'parent-profile': 'people',
  enrollment: 'people',
  staff: 'people',
  user: 'people',
  role: 'people',
  'mentor-schedule': 'people',
  'mentor-availability': 'people',
  class: 'classes',
  program: 'curriculum',
  session: 'curriculum',
  'payment-plan': 'curriculum',
  resource: 'curriculum',
  'ai-models': 'ai',
  'ai-prompt': 'ai',
  'ai-errors': 'ai',
  recording: 'recordings',
  meeting: 'recordings',
  'zoom-host': 'recordings',
  storage: 'recordings',
  transcription: 'recordings',
  'ai-summary': 'ai',
  report: 'classes',
};

/** Best-effort write; never throws. */
export const recordAudit = async (entry: AuditEntry): Promise<void> => {
  try {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorName: entry.actorName ?? null,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        entityName: entry.entityName ?? null,
        summary: entry.summary.slice(0, 500),
        category: entry.category ?? CATEGORY_OF[entry.entityType] ?? 'other',
        changes: entry.changes && entry.changes.length > 0 ? (entry.changes as object[]) : undefined,
        service: entry.service ?? SERVICE,
        method: entry.method ?? null,
        path: entry.path ? entry.path.slice(0, 300) : null,
      },
    });
  } catch (err: any) {
    logger.warn(`[Audit] Could not record "${entry.summary}": ${err.message}`);
  }
};

/* ── Actor names ──────────────────────────────────────────────────────────
 * x-user-id can point at a staff User, a Student, or a ParentAccount
 * depending on the role. Resolved lazily with a 10-minute cache so the
 * middleware never adds a per-request lookup for repeat actors.
 * ─────────────────────────────────────────────────────────────────────── */
const nameCache = new Map<string, { name: string | null; at: number }>();

export const resolveActorName = async (actorId: string, role?: string): Promise<string | null> => {
  const cached = nameCache.get(actorId);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.name;

  let name: string | null = null;
  try {
    if (role === 'STUDENT') {
      const s = await db.student.findUnique({ where: { id: actorId }, select: { firstName: true, lastName: true } });
      if (s) name = [s.firstName, s.lastName].filter(Boolean).join(' ');
    }
    if (!name) {
      const u = await db.user.findUnique({ where: { id: actorId }, select: { firstName: true, lastName: true } });
      if (u) name = [u.firstName, u.lastName].filter(Boolean).join(' ');
    }
    if (!name) {
      const p = await db.parentAccount
        .findUnique({
          where: { id: actorId },
          select: {
            email: true,
            profiles: { select: { firstName: true, lastName: true }, orderBy: { createdAt: 'asc' }, take: 1 },
          },
        })
        .catch(() => null);
      if (p) {
        const profile = p.profiles?.[0];
        name = profile ? [profile.firstName, profile.lastName].filter(Boolean).join(' ') : p.email;
      }
    }
  } catch {
    /* unnamed is fine */
  }
  nameCache.set(actorId, { name, at: Date.now() });
  return name;
};

/** "SJ" | "an admin" — subject of the sentence. */
const actorLabel = (name: string | null, role: string | null): string => {
  if (name) return name;
  if (!role) return 'Someone';
  const r = role.toLowerCase();
  if (r === 'admin') return 'An admin';
  if (r === 'system') return 'The system';
  return `A ${r.replace(/_/g, ' ').toLowerCase()}`;
};

/**
 * What kind of machine a request came from, from the User-Agent — device
 * class, brand/model where the UA carries one (Android does), OS, browser.
 * Heuristics, not exact science: "Unknown" beats a wrong guess.
 */
export const parseUserAgent = (ua: string | undefined) => {
  const s = ua ?? '';
  const deviceType = /iPad|Tablet/i.test(s) ? 'Tablet' : /Mobi|iPhone/i.test(s) ? 'Mobile' : 'Desktop';

  let brand: string | null =
    /iPhone/.test(s) ? 'Apple iPhone'
    : /iPad/.test(s) ? 'Apple iPad'
    : /Macintosh/.test(s) ? 'Apple Mac'
    : /Windows/.test(s) ? 'Windows PC'
    : null;
  if (!brand && /Android/i.test(s)) {
    const model =
      (s.match(/;\s*([^;)]+?)\s+Build\//) ?? s.match(/Android [\d.]+;\s*([^;)]+)[;)]/))?.[1]?.trim() ?? null;
    const maker = !model ? null
      : /^SM-|Samsung/i.test(model) ? 'Samsung'
      : /Redmi|POCO|^Mi |Xiaomi|^2\d{3}/i.test(model) ? 'Xiaomi'
      : /Pixel/i.test(model) ? 'Google'
      : /OnePlus/i.test(model) ? 'OnePlus'
      : /^CPH/i.test(model) ? 'Oppo'
      : /vivo|^V\d{4}/i.test(model) ? 'Vivo'
      : /RMX|Realme/i.test(model) ? 'Realme'
      : /moto/i.test(model) ? 'Motorola'
      : null;
    brand = model ? `${maker && !model.toLowerCase().includes(maker.toLowerCase()) ? `${maker} ` : ''}${model}` : 'Android device';
  }

  const os =
    /Windows NT 10/.test(s) ? 'Windows 10/11'
    : /Windows/.test(s) ? 'Windows'
    : /Android ([\d.]+)/.test(s) ? `Android ${s.match(/Android ([\d.]+)/)?.[1]}`
    : /iPhone OS (\d+)/.test(s) ? `iOS ${s.match(/iPhone OS (\d+)/)?.[1]}`
    : /iPad; CPU OS (\d+)/.test(s) ? `iPadOS ${s.match(/iPad; CPU OS (\d+)/)?.[1]}`
    : /Mac OS X/.test(s) ? 'macOS'
    : /Linux/.test(s) ? 'Linux'
    : 'Unknown OS';

  const browser =
    /Edg\//.test(s) ? `Edge ${s.match(/Edg\/(\d+)/)?.[1] ?? ''}`.trim()
    : /OPR\//.test(s) ? 'Opera'
    : /SamsungBrowser/i.test(s) ? 'Samsung Internet'
    : /Chrome\/(\d+)/.test(s) ? `Chrome ${s.match(/Chrome\/(\d+)/)?.[1]}`
    : /Version\/(\d+).*Safari/.test(s) ? `Safari ${s.match(/Version\/(\d+)/)?.[1]}`
    : /Firefox\/(\d+)/.test(s) ? `Firefox ${s.match(/Firefox\/(\d+)/)?.[1]}`
    : 'Unknown browser';

  return { deviceType, brand: brand ?? 'Unknown device', os, browser };
};

/* ── Change capture ─────────────────────────────────────────────────────── */
const captureChanges = (body: unknown): Array<{ field: string; to: string }> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.entries(body as Record<string, unknown>)
    .filter(([k, v]) => !SENSITIVE_KEY.test(k) && v !== undefined && v !== null && typeof v !== 'object')
    .slice(0, 15)
    .map(([field, v]) => ({ field, to: String(v).slice(0, 120) }));
};

/** Pull a display name out of a response body's data object. */
const extractEntityName = (resBody: any): string | null => {
  const d = resBody?.data;
  if (!d || typeof d !== 'object') return null;
  const source = d.student ?? d.parent ?? d.user ?? d.account ?? d;
  const first = source.firstName ?? source.name ?? source.title;
  if (!first) return null;
  return [first, source.lastName].filter(Boolean).join(' ').slice(0, 120);
};

const extractEntityId = (resBody: any, params: Record<string, string>): string | null => {
  const d = resBody?.data;
  if (d && typeof d === 'object' && typeof d.id === 'string') return d.id;
  for (const v of Object.values(params)) if (UUID_RE.test(v)) return v;
  return null;
};

/* ── Route → sentence map ─────────────────────────────────────────────────
 * Matched in order against `${METHOD} ${path}`; :seg matches one segment.
 * `who` is the actor label; `name` the entity name when one was found.
 * ─────────────────────────────────────────────────────────────────────── */
interface RouteRule {
  match: RegExp;
  action: string;
  entityType: string;
  summary: (who: string, name: string | null) => string;
  /** Reset-password style routes must not capture bodies at all. */
  noChanges?: boolean;
}

const S = '[^/]+';
const rule = (
  method: string, pattern: string, action: string, entityType: string,
  summary: (who: string, name: string | null) => string, noChanges = false
): RouteRule => ({
  match: new RegExp(`^${method} ${pattern.replace(/:[a-zA-Z]+/g, S)}/?$`),
  action, entityType, summary, noChanges,
});

const ROUTE_RULES: RouteRule[] = [
  // Parents & students (the customers module)
  rule('POST', '/users/customers', 'created', 'parent', (w, n) => `${w} created parent ${n ?? ''}`.trim()),
  rule('PUT', '/users/customers/students/:id/reset-password', 'reset-password', 'student', (w, n) => `${w} reset the password of student ${n ?? ''}`.trim(), true),
  rule('POST', '/users/customers/:parentId/students', 'created', 'student', (w, n) => `${w} created student ${n ?? ''}`.trim()),
  rule('PUT', '/users/customers/students/:id', 'updated', 'student', (w, n) => `${w} updated student ${n ?? 'details'}`),
  rule('DELETE', '/users/customers/students/:id', 'deleted', 'student', (w) => `${w} deleted a student`),
  rule('POST', '/users/customers/:parentId/profiles', 'created', 'parent-profile', (w) => `${w} added a parent profile`),
  rule('PUT', '/users/customers/profiles/:profileId', 'updated', 'parent-profile', (w) => `${w} updated a parent profile`),
  rule('POST', '/users/customers/:parentId/enrollments', 'created', 'enrollment', (w) => `${w} added an enrollment`),
  rule('PUT', '/users/customers/enrollments/:enrollmentId', 'updated', 'enrollment', (w) => `${w} updated an enrollment`),
  rule('DELETE', '/users/customers/enrollments/:enrollmentId', 'deleted', 'enrollment', (w) => `${w} removed an enrollment`),
  rule('PUT', '/users/customers/:id/reset-password', 'reset-password', 'parent', (w, n) => `${w} reset the password of parent ${n ?? ''}`.trim(), true),
  rule('PUT', '/users/customers/:id', 'updated', 'parent', (w, n) => `${w} updated parent ${n ?? 'account'}`),
  rule('DELETE', '/users/customers/:id', 'deleted', 'parent', (w) => `${w} deleted a parent account`),

  // Mentors & staff
  rule('PUT', '/users/mentors/:id/availability', 'updated', 'mentor-availability', (w) => `${w} updated mentor availability`),
  rule('POST', '/users/mentors/:id/schedules', 'created', 'mentor-schedule', (w) => `${w} added a mentor schedule slot`),
  rule('DELETE', '/users/mentors/schedules/:scheduleId', 'deleted', 'mentor-schedule', (w) => `${w} removed a mentor schedule slot`),
  rule('POST', '/users/qa-action/warn', 'warned', 'user', (w, n) => `${w} issued a QA warning${n ? ` to ${n}` : ''}`),
  rule('POST', '/users/qa-action/blacklist', 'blacklisted', 'user', (w, n) => `${w} blacklisted ${n ?? 'a user'}`),
  rule('POST', '/users/qa-action/unblacklist', 'unblacklisted', 'user', (w, n) => `${w} removed ${n ?? 'a user'} from the blacklist`),
  rule('PUT', '/users/:id/reset-password', 'reset-password', 'staff', (w, n) => `${w} reset the password of ${n ?? 'a staff member'}`, true),
  rule('POST', '/users', 'created', 'staff', (w, n) => `${w} created staff member ${n ?? ''}`.trim()),
  rule('PUT', '/users/:id', 'updated', 'staff', (w, n) => `${w} updated staff member ${n ?? 'details'}`),
  rule('DELETE', '/users/:id', 'deleted', 'staff', (w) => `${w} deleted a staff member`),

  // Classes
  rule('PUT', '/schedules/:id/complete', 'completed', 'class', (w) => `${w} marked a class completed`),
  rule('POST', '/schedules/:id/quiz/launch', 'quiz-launched', 'class', (w) => `${w} launched the live quiz for a class`),
  rule('POST', '/schedules/:id/reflection/review', 'quiz-reviewed', 'class', (w) => `${w} reviewed a student's quiz answers`),
  rule('POST', '/schedules/:id/reflection', 'quiz-submitted', 'class', (w) => `${w} submitted the class quiz`, true),
  rule('POST', '/schedules/:id/send-report', 'report-sent', 'class', (w) => `${w} sent the parent report on WhatsApp`),
  rule('POST', '/schedules', 'created', 'class', (w) => `${w} scheduled a class`),
  rule('PUT', '/schedules/:id', 'updated', 'class', (w) => `${w} updated a class`),
  rule('DELETE', '/schedules/:id', 'deleted', 'class', (w) => `${w} deleted a class`),

  // Roles / permissions
  rule('POST', '/roles', 'created', 'role', (w, n) => `${w} created role ${n ?? ''}`.trim()),
  rule('PUT', '/roles/:id', 'updated', 'role', (w, n) => `${w} updated role ${n ?? ''}`.trim()),
  rule('DELETE', '/roles/:id', 'deleted', 'role', (w) => `${w} deleted a role`),
];

/** Paths never audited: credentials fly through /auth and /otp. */
const SKIP_PATH = /^\/(auth|otp|health)\b/;

/**
 * The one /auth event worth a log line: a successful login. Only the PATH is
 * allowed through — the body (email + password) is never captured for it, and
 * the actor is read from the login RESPONSE, since the request is anonymous.
 */
const AUTH_EVENT = /^\/auth\/login\/?$/;

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

/**
 * Mount AFTER the body parser and BEFORE the routes. Records only successful
 * (2xx) mutations, after the response is finished, off the request's critical
 * path.
 */
export const auditMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  /* Snapshot the path NOW. Inside res.on('finish') Express routers have
   * mutated req.url to be router-relative ("/login" instead of "/auth/login"),
   * which sent every login through the generic branch — with the email
   * captured as a "changed field". originalUrl is never mutated. */
  const reqPath = (req.originalUrl || req.url).split('?')[0];
  if (SKIP_PATH.test(reqPath) && !AUTH_EVENT.test(reqPath)) return next();

  // Capture what res.json sends so entity names can be read from it.
  let resBody: any = null;
  const originalJson = res.json.bind(res);
  res.json = ((body: any) => {
    resBody = body;
    return originalJson(body);
  }) as typeof res.json;

  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;

    void (async () => {
      // A successful login is its own event: the actor comes from the RESPONSE
      // (the request is anonymous), the body is never touched, and the
      // User-Agent tells us what kind of machine they signed in from.
      if (AUTH_EVENT.test(reqPath)) {
        const u = resBody?.data?.user;
        if (!u?.id) return; // no identified user, nothing to log
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || null;
        const role = (u.role ?? null)?.toUpperCase?.() ?? null;
        const device = parseUserAgent(req.headers['user-agent'] as string | undefined);
        const ip =
          ((req.headers['x-forwarded-for'] as string) || '').split(',')[0].trim() ||
          req.socket?.remoteAddress ||
          '';
        await recordAudit({
          actorId: u.id,
          actorName: name,
          actorRole: role,
          action: 'login',
          entityType: 'login',
          entityId: u.id,
          entityName: name,
          summary:
            `${name ?? 'Someone'} logged in${role ? ` (${role.toLowerCase()})` : ''}` +
            ` — ${device.deviceType} · ${device.brand} · ${device.browser}`,
          changes: [
            ...(role ? [{ field: 'role', to: role }] : []),
            { field: 'device', to: device.deviceType },
            { field: 'brand / model', to: device.brand },
            { field: 'os', to: device.os },
            { field: 'browser', to: device.browser },
            ...(ip ? [{ field: 'ip', to: ip }] : []),
          ],
          method,
          path: reqPath,
        });
        return;
      }

      const actorId = (req.headers['x-user-id'] as string) || null;
      const actorRole = ((req.headers['x-user-role'] as string) || (actorId ? null : 'SYSTEM'))?.toUpperCase() ?? null;
      const actorName = actorId ? await resolveActorName(actorId, actorRole ?? undefined) : null;
      const who = actorLabel(actorName, actorRole);

      const key = `${method} ${reqPath}`;
      const matched = ROUTE_RULES.find((r) => r.match.test(key));
      const entityName = extractEntityName(resBody);
      const changes =
        matched?.noChanges || method === 'DELETE' ? [] : captureChanges(req.body);

      await recordAudit({
        actorId,
        actorName,
        actorRole,
        action: matched?.action ?? (method === 'POST' ? 'created' : method === 'DELETE' ? 'deleted' : 'updated'),
        entityType: matched?.entityType ?? 'other',
        entityId: extractEntityId(resBody, req.params as Record<string, string>),
        entityName,
        summary: matched ? matched.summary(who, entityName) : genericSummary(who, method, reqPath),
        changes,
        method,
        path: reqPath,
      });
    })();
  });

  next();
};
