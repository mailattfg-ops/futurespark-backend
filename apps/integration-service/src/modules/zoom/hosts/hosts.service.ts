import { logger } from '@futurespark/logger';
import db from '../../../database/datasource';
import { callZoom, ZoomApiError, ZoomAuthService, zoomConfig } from '../auth/auth.service';

/**
 * The Zoom seat register.
 *
 * A licensed Zoom user can host exactly one live meeting at a time, so the
 * number of active seats here IS the number of classes that can run
 * concurrently. This table replaced `ZOOM_HOST_EMAILS`, which meant buying a
 * licence needed an env edit and a redeploy on a production box.
 *
 * ── The cutover contract ────────────────────────────────────────────────────
 * Switching the allocator from env to database is the one change here that
 * could take Zoom bookings down, so it is deliberately impossible for it to:
 *
 *   1. `seedFromEnvIfEmpty()` runs at boot. Empty table + a configured
 *      ZOOM_HOST_EMAILS => the seats are copied in, marked source=ENV.
 *   2. `getActiveHostPool()` falls back to the env list whenever the table
 *      yields no active seat, and says so loudly in the log.
 *
 * So a deploy that lands before anyone opens the admin page still books
 * classes on exactly the seats it used yesterday. ZOOM_HOST_EMAILS can be
 * deleted from the environment once the table is populated; the fallback then
 * simply never fires again.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** Emails are compared and stored lowercased — Zoom treats them that way. */
export const emailKey = (value: string): string => value.trim().toLowerCase();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isValidEmail = (value: unknown): value is string =>
  typeof value === 'string' && EMAIL_PATTERN.test(value.trim());

/**
 * The pool is read on every booking, so it is cached briefly rather than
 * queried each time. The TTL is short and every write clears it, so a seat
 * added in the UI is usable on the next booking rather than in a minute.
 */
const POOL_TTL_MS = 30_000;
let poolCache: { at: number; emails: string[] } | null = null;

export const invalidateHostPoolCache = (): void => {
  poolCache = null;
};

/**
 * The ordered list of seat addresses the allocator may use.
 *
 * Order matters: it is the tie-breaker in `rankFreeHosts`, so allocation stays
 * deterministic and "which host ran that class" has a reproducible answer.
 * Oldest seat first, matching the order they were bought.
 */
export const getActiveHostPool = async (): Promise<string[]> => {
  if (poolCache && Date.now() - poolCache.at < POOL_TTL_MS) return poolCache.emails;

  let emails: string[] = [];
  try {
    const rows = await db.zoomHost.findMany({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
      select: { email: true },
    });
    emails = rows.map((row) => row.email);
  } catch (err: any) {
    // A missing table (deploy landed before db push) must not stop bookings —
    // fall through to the env list, which is what ran before this table.
    logger.error(
      `[ZoomHosts] Could not read the seat table (${err.message}). ` +
        'Falling back to ZOOM_HOST_EMAILS so bookings continue.'
    );
    emails = [];
  }

  if (emails.length === 0) {
    const fallback = zoomConfig.hostEmails;
    if (fallback.length > 0) {
      logger.warn(
        `[ZoomHosts] No active seats in the database — falling back to the ${fallback.length} ` +
          'seat(s) in ZOOM_HOST_EMAILS. Add them under System → Zoom Hosts so the environment ' +
          'variable can be removed.'
      );
    }
    emails = fallback;
  }

  poolCache = { at: Date.now(), emails };
  return emails;
};

/**
 * Copy ZOOM_HOST_EMAILS into the table, once, when the table is empty.
 *
 * Only ever runs on a genuinely empty table, so it can never overwrite or
 * resurrect a seat an admin deleted on purpose. Best-effort: a failure here
 * leaves the env fallback carrying bookings, which is the same behaviour as
 * before this module existed.
 */
export const seedFromEnvIfEmpty = async (): Promise<void> => {
  try {
    const existing = await db.zoomHost.count();
    if (existing > 0) return;

    const emails = zoomConfig.hostEmails;
    if (emails.length === 0) return;

    for (const email of emails) {
      await db.zoomHost.create({
        data: {
          // No display name exists in the env format; the local part is a
          // better placeholder than the whole address repeated twice.
          name: email.split('@')[0] || email,
          email: emailKey(email),
          licenseType: 'PRO',
          active: true,
          source: 'ENV',
        },
      });
    }

    invalidateHostPoolCache();
    logger.info(
      `[ZoomHosts] Seeded ${emails.length} Zoom seat(s) from ZOOM_HOST_EMAILS into the seat table. ` +
        'Manage them under System → Zoom Hosts; the environment variable is now only a fallback.'
    );
  } catch (err: any) {
    logger.error(
      `[ZoomHosts] Could not seed seats from ZOOM_HOST_EMAILS: ${err.message}. ` +
        'Bookings continue on the environment list.'
    );
  }
};

/* ══════════════════════════════════════════════════════════════════════════
 * BUSY STATE
 *
 * Never stored. A "busy" flag on the row would go stale the moment a meeting
 * was cancelled or ran long; deriving it from the same overlap rule the
 * allocator uses means the badge and the scheduler can never disagree.
 * ═══════════════════════════════════════════════════════════════════════ */

export interface HostBusyState {
  busy: boolean;
  meetingTitle: string | null;
  meetingStartTime: Date | null;
  meetingEndTime: Date | null;
}

/** Which seats are hosting a meeting right now, keyed by lowercased email. */
const loadBusyByEmail = async (at: Date): Promise<Map<string, HostBusyState>> => {
  const live = await db.meeting.findMany({
    where: {
      provider: 'ZOOM',
      status: { not: 'CANCELLED' },
      zoomHostEmail: { not: null },
      startTime: { lte: at },
      endTime: { gt: at },
    },
    select: { zoomHostEmail: true, title: true, startTime: true, endTime: true },
  });

  const byEmail = new Map<string, HostBusyState>();
  for (const meeting of live) {
    if (!meeting.zoomHostEmail) continue;
    byEmail.set(emailKey(meeting.zoomHostEmail), {
      busy: true,
      meetingTitle: meeting.title,
      meetingStartTime: meeting.startTime,
      meetingEndTime: meeting.endTime,
    });
  }
  return byEmail;
};

/** How many future meetings are booked on each seat — the delete guard. */
const loadUpcomingByEmail = async (at: Date): Promise<Map<string, number>> => {
  const rows = await db.meeting.groupBy({
    by: ['zoomHostEmail'],
    where: {
      provider: 'ZOOM',
      status: { not: 'CANCELLED' },
      zoomHostEmail: { not: null },
      startTime: { gt: at },
    },
    _count: { _all: true },
  });

  const byEmail = new Map<string, number>();
  for (const row of rows) {
    if (!row.zoomHostEmail) continue;
    byEmail.set(emailKey(row.zoomHostEmail), row._count._all);
  }
  return byEmail;
};

/** Every seat, with its live state — what the admin table renders. */
export const listHosts = async () => {
  const now = new Date();
  const [hosts, busyByEmail, upcomingByEmail] = await Promise.all([
    db.zoomHost.findMany({ orderBy: [{ active: 'desc' }, { createdAt: 'asc' }] }),
    loadBusyByEmail(now),
    loadUpcomingByEmail(now),
  ]);

  const rows = hosts.map((host) => {
    const busy = busyByEmail.get(emailKey(host.email));
    return {
      id: host.id,
      name: host.name,
      email: host.email,
      licenseType: host.licenseType,
      active: host.active,
      verifiedAt: host.verifiedAt ? host.verifiedAt.toISOString() : null,
      verifiedType: host.verifiedType,
      lastError: host.lastError,
      source: host.source,
      createdAt: host.createdAt.toISOString(),
      // An inactive seat is never "available" — it receives nothing new.
      status: !host.active ? 'INACTIVE' : busy ? 'BUSY' : 'AVAILABLE',
      currentSession: busy
        ? {
            title: busy.meetingTitle,
            startTime: busy.meetingStartTime?.toISOString() ?? null,
            endTime: busy.meetingEndTime?.toISOString() ?? null,
          }
        : null,
      upcomingMeetings: upcomingByEmail.get(emailKey(host.email)) ?? 0,
    };
  });

  const active = rows.filter((r) => r.active);
  return {
    hosts: rows,
    summary: {
      total: rows.length,
      active: active.length,
      available: rows.filter((r) => r.status === 'AVAILABLE').length,
      busy: rows.filter((r) => r.status === 'BUSY').length,
      inactive: rows.filter((r) => r.status === 'INACTIVE').length,
      /** Concurrent classes the pool can currently run. */
      capacity: active.length,
    },
    // Surfaced so the page can tell an admin the table is not yet in charge.
    envFallbackActive: active.length === 0 && zoomConfig.hostEmails.length > 0,
    envFallbackSeats: active.length === 0 ? zoomConfig.hostEmails : [],
  };
};

/* ══════════════════════════════════════════════════════════════════════════
 * WRITES
 * ═══════════════════════════════════════════════════════════════════════ */

export class ZoomHostError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ZoomHostError';
  }
}

export const createHost = async (input: { name?: unknown; email?: unknown; licenseType?: unknown; active?: unknown }) => {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? emailKey(input.email) : '';

  if (!isValidEmail(email)) {
    throw new ZoomHostError('INVALID_EMAIL', 'Enter the Zoom account\'s email address, e.g. host2@yourdomain.com.');
  }
  if (name.length === 0) {
    throw new ZoomHostError('INVALID_NAME', 'Give the seat a name so it is recognisable in the schedule.');
  }

  const existing = await db.zoomHost.findUnique({ where: { email } });
  if (existing) {
    throw new ZoomHostError(
      'DUPLICATE_EMAIL',
      `${email} is already registered as a Zoom host. Two rows for one Zoom account would look like two ` +
        'seats and let the scheduler book the same host twice at the same time.'
    );
  }

  const host = await db.zoomHost.create({
    data: {
      name,
      email,
      licenseType: input.licenseType === 'BASIC' ? 'BASIC' : 'PRO',
      active: input.active !== false,
      source: 'ADMIN',
    },
  });

  invalidateHostPoolCache();
  logger.info(`[ZoomHosts] Added Zoom seat ${email} (${host.active ? 'active' : 'inactive'}).`);
  return host;
};

export const updateHost = async (
  id: string,
  input: { name?: unknown; email?: unknown; licenseType?: unknown; active?: unknown }
) => {
  const host = await db.zoomHost.findUnique({ where: { id } });
  if (!host) throw new ZoomHostError('NOT_FOUND', 'That Zoom host no longer exists.');

  const data: Record<string, unknown> = {};

  if (typeof input.name === 'string' && input.name.trim().length > 0) data.name = input.name.trim();

  if (typeof input.email === 'string') {
    const email = emailKey(input.email);
    if (!isValidEmail(email)) {
      throw new ZoomHostError('INVALID_EMAIL', 'Enter a valid Zoom account email address.');
    }
    if (email !== host.email) {
      const clash = await db.zoomHost.findUnique({ where: { email } });
      if (clash) {
        throw new ZoomHostError('DUPLICATE_EMAIL', `${email} is already registered as another Zoom host.`);
      }
      data.email = email;
      // The address is the identity Zoom is called with, so a change makes any
      // previous verification meaningless.
      data.verifiedAt = null;
      data.verifiedType = null;
      data.lastError = null;
    }
  }

  if (input.licenseType === 'PRO' || input.licenseType === 'BASIC') data.licenseType = input.licenseType;
  if (typeof input.active === 'boolean') data.active = input.active;

  const updated = await db.zoomHost.update({ where: { id }, data });
  invalidateHostPoolCache();
  logger.info(`[ZoomHosts] Updated Zoom seat ${updated.email}.`);
  return updated;
};

/**
 * Remove a seat.
 *
 * Refused while future meetings are booked on it. Those rooms were created on
 * this Zoom account and will still open, but deleting the row erases the only
 * record of which seat is carrying them — and the allocator would then happily
 * book a second class into the same live account.
 */
export const deleteHost = async (id: string) => {
  const host = await db.zoomHost.findUnique({ where: { id } });
  if (!host) throw new ZoomHostError('NOT_FOUND', 'That Zoom host no longer exists.');

  const upcoming = await db.meeting.count({
    where: {
      provider: 'ZOOM',
      status: { not: 'CANCELLED' },
      zoomHostEmail: host.email,
      startTime: { gt: new Date() },
    },
  });

  if (upcoming > 0) {
    throw new ZoomHostError(
      'HAS_UPCOMING_MEETINGS',
      `This host has ${upcoming} future scheduled session${upcoming === 1 ? '' : 's'}. Reassign them before ` +
        'deleting. To stop it taking new classes right now, disable it instead — that leaves the booked ' +
        'sessions working.'
    );
  }

  await db.zoomHost.delete({ where: { id } });
  invalidateHostPoolCache();
  logger.info(`[ZoomHosts] Deleted Zoom seat ${host.email}.`);
  return host;
};

/* ══════════════════════════════════════════════════════════════════════════
 * VERIFICATION
 *
 * Advisory, never blocking. The probe needs a user-read scope the
 * Server-to-Server app may not have been granted, and refusing to save a seat
 * because an unrelated permission is missing would leave an admin unable to
 * add the licence they just paid for.
 * ═══════════════════════════════════════════════════════════════════════ */

/** Zoom user types: 1 = Basic, 2 = Licensed (Pro), 3 = On-prem. */
const ZOOM_TYPE_LABEL: Record<number, string> = { 1: 'BASIC', 2: 'PRO', 3: 'ON_PREM' };

export const verifyHost = async (id: string) => {
  const host = await db.zoomHost.findUnique({ where: { id } });
  if (!host) throw new ZoomHostError('NOT_FOUND', 'That Zoom host no longer exists.');

  if (!zoomConfig.enabled) {
    throw new ZoomHostError('ZOOM_DISABLED', 'Zoom is turned off (ZOOM_ENABLED), so its API cannot be asked.');
  }

  try {
    const token = await ZoomAuthService.getServerToServerToken();
    const response = await callZoom<any>(
      { operation: 'get', host: host.email },
      { method: 'GET', url: `https://api.zoom.us/v2/users/${encodeURIComponent(host.email)}`, bearer: token }
    );

    const user = response.data ?? {};
    const type = Number(user.type);
    const label = ZOOM_TYPE_LABEL[type] ?? 'UNKNOWN';
    // status 'pending' means the invitation has not been accepted, and a
    // pending account cannot host — worth its own label, because everything
    // else about the seat looks correct.
    const pending = String(user.status ?? '').toLowerCase() === 'pending';
    const verifiedType = pending ? 'PENDING' : label;

    const updated = await db.zoomHost.update({
      where: { id },
      data: {
        verifiedAt: new Date(),
        verifiedType,
        lastError: null,
        // Trust Zoom over what was typed: this is the whole point of asking.
        licenseType: label === 'PRO' ? 'PRO' : label === 'BASIC' ? 'BASIC' : host.licenseType,
        name: host.name || [user.first_name, user.last_name].filter(Boolean).join(' ') || host.name,
      },
    });

    invalidateHostPoolCache();
    logger.info(`[ZoomHosts] Verified ${host.email} with Zoom: ${verifiedType}.`);
    return updated;
  } catch (err: any) {
    const missingScope =
      err instanceof ZoomApiError &&
      (Number(err.zoomCode) === 4711 || Number(err.zoomCode) === 104 || /scope/i.test(err.message));
    const notFound = err instanceof ZoomApiError && Number(err.status) === 404;

    const message = notFound
      ? `Zoom has no user with the address ${host.email}. Create the user in Zoom and assign it a licence first.`
      : missingScope
        ? 'The Zoom app is missing the user-read scope, so licences cannot be checked. Grant ' +
          'user:read:user:admin (Users → View users) in the Zoom marketplace; the seat still works either way.'
        : `Zoom could not be asked about this seat: ${err.message}`;

    const updated = await db.zoomHost.update({
      where: { id },
      data: {
        verifiedAt: null,
        verifiedType: notFound ? 'NOT_FOUND' : null,
        lastError: message.slice(0, 500),
      },
    });

    logger.warn(`[ZoomHosts] Verification failed for ${host.email}: ${message}`);
    return updated;
  }
};
