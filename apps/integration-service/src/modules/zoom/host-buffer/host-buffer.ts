import { db, withDbRetry } from '../../../database/datasource';
import { emailKey } from '../hosts/hosts.service';

/**
 * Minimum gap between two bookings on the same Zoom host seat.
 *
 * Without a buffer, back-to-back classes and a reschedule that lands 1 minute
 * after the previous slot share a host while the earlier Zoom session may still
 * be live. The allocator used to treat touching endpoints as free
 * (`end === start`); this module is the single place that applies a cooldown.
 *
 * Pure helpers below are safe to call from a cron, a join handler, or the
 * meeting allocator — wire them in when ready.
 */

/** Default when ZOOM_HOST_BUFFER_MINUTES is unset: 15 minutes each side. */
export const DEFAULT_HOST_BUFFER_MS = 15 * 60 * 1000;

export interface TimeWindow {
  start: Date;
  end: Date;
}

export interface SeatBooking {
  meetingId: string;
  hostEmail: string;
  title: string;
  startTime: Date;
  endTime: Date;
  joinUrl?: string | null;
  meetUrl?: string | null;
  zoomMeetingId?: string | null;
}

/** Payload for API errors — UI can render joinUrl on failed creates. */
export interface ExistingMeetingPayload {
  existingMeetingId: string;
  joinUrl: string | null;
  meetLink: string | null;
  zoomMeetingId: string | null;
  hostEmail: string | null;
  title: string;
  startTime: string;
  endTime: string;
}

export interface HostBufferConflict {
  hostEmail: string;
  proposed: TimeWindow;
  existing: SeatBooking;
  bufferMs: number;
}

export interface HostBufferQueryOptions {
  /** Override env/default; 0 = same as the old touching-endpoint rule. */
  bufferMs?: number;
  /** Ignore this meeting row (reschedule of the same room). */
  excludeMeetingId?: string;
  /** Only consider bookings on this seat. */
  hostEmail?: string;
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

const validWindow = (window: TimeWindow): boolean =>
  !Number.isNaN(window.start.getTime()) &&
  !Number.isNaN(window.end.getTime()) &&
  window.start.getTime() < window.end.getTime();

/**
 * Resolve buffer length from an explicit override or ZOOM_HOST_BUFFER_MINUTES.
 */
export const resolveHostBufferMs = (override?: number): number => {
  if (override !== undefined) return Math.max(0, override);
  const raw = process.env.ZOOM_HOST_BUFFER_MINUTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_HOST_BUFFER_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_HOST_BUFFER_MS;
  return Math.round(minutes * 60_000);
};

/**
 * A window padded on both sides — the zone a host must stay clear of.
 */
export const expandWindow = (window: TimeWindow, bufferMs: number): TimeWindow => {
  const buf = Math.max(0, bufferMs);
  return {
    start: new Date(window.start.getTime() - buf),
    end: new Date(window.end.getTime() + buf),
  };
};

/**
 * Do two windows overlap once `bufferMs` is applied around `existing`?
 *
 * Equivalent to expanding `existing` by the buffer and testing intersection
 * against `proposed`. Symmetric padding gives prep time before and cooldown
 * after every booked slot.
 */
export const windowsConflict = (
  proposed: TimeWindow,
  existing: TimeWindow,
  bufferMs = DEFAULT_HOST_BUFFER_MS
): boolean => {
  const padded = expandWindow(existing, bufferMs);
  return proposed.start.getTime() < padded.end.getTime() && proposed.end.getTime() > padded.start.getTime();
};

/**
 * Every stored booking that blocks `proposed` under the buffer rule.
 */
export const findConflictingBookings = (
  proposed: TimeWindow,
  bookings: readonly SeatBooking[],
  options: HostBufferQueryOptions = {}
): HostBufferConflict[] => {
  if (!validWindow(proposed)) return [];

  const bufferMs = resolveHostBufferMs(options.bufferMs);
  const hostFilter = options.hostEmail ? emailKey(options.hostEmail) : null;
  const excludeId = options.excludeMeetingId ?? null;
  const conflicts: HostBufferConflict[] = [];

  for (const booking of bookings) {
    if (excludeId && booking.meetingId === excludeId) continue;
    if (hostFilter && emailKey(booking.hostEmail) !== hostFilter) continue;
    if (!validWindow({ start: booking.startTime, end: booking.endTime })) continue;

    if (windowsConflict(proposed, { start: booking.startTime, end: booking.endTime }, bufferMs)) {
      conflicts.push({
        hostEmail: booking.hostEmail,
        proposed,
        existing: booking,
        bufferMs,
      });
    }
  }

  return conflicts;
};

/**
 * Lowercased host emails that cannot take `proposed` because of an existing booking.
 */
export const busyHostKeys = (
  proposed: TimeWindow,
  bookings: readonly SeatBooking[],
  options: HostBufferQueryOptions = {}
): Set<string> => {
  const keys = new Set<string>();
  for (const conflict of findConflictingBookings(proposed, bookings, options)) {
    keys.add(emailKey(conflict.hostEmail));
  }
  return keys;
};

/**
 * Can `hostEmail` host `proposed` given the bookings already on file?
 */
export const isHostAvailable = (
  hostEmail: string,
  proposed: TimeWindow,
  bookings: readonly SeatBooking[],
  options: Omit<HostBufferQueryOptions, 'hostEmail'> = {}
): boolean =>
  busyHostKeys(proposed, bookings, { ...options, hostEmail }).size === 0;

/**
 * Human-readable line for logs or API errors.
 */
export const bookingJoinUrl = (booking: SeatBooking): string | null =>
  booking.joinUrl || booking.meetUrl || null;

/**
 * Prefer a conflict on `preferredHost`, else the earliest conflicting booking.
 */
export const pickPrimaryConflict = (
  conflicts: readonly HostBufferConflict[],
  preferredHost?: string | null
): HostBufferConflict | null => {
  if (conflicts.length === 0) return null;
  if (preferredHost) {
    const key = emailKey(preferredHost);
    const hit = conflicts.find((c) => emailKey(c.hostEmail) === key);
    if (hit) return hit;
  }
  return conflicts[0];
};

export const seatBookingFromMeetingRow = (row: {
  id: string;
  zoomHostEmail: string | null;
  title: string;
  startTime: Date;
  endTime: Date;
  zoomJoinUrl?: string | null;
  meetUrl?: string | null;
  zoomMeetingId?: string | null;
}): SeatBooking | null => {
  if (!row.zoomHostEmail) return null;
  return {
    meetingId: row.id,
    hostEmail: row.zoomHostEmail,
    title: row.title,
    startTime: row.startTime,
    endTime: row.endTime,
    joinUrl: row.zoomJoinUrl ?? null,
    meetUrl: row.meetUrl ?? null,
    zoomMeetingId: row.zoomMeetingId ?? null,
  };
};

export const existingMeetingPayload = (row: {
  id: string;
  zoomHostEmail: string | null;
  title: string;
  startTime: Date;
  endTime: Date;
  zoomJoinUrl?: string | null;
  meetUrl?: string | null;
  zoomMeetingId?: string | null;
}): ExistingMeetingPayload => {
  const link = row.zoomJoinUrl || row.meetUrl || null;
  return {
    existingMeetingId: row.id,
    joinUrl: link,
    meetLink: link,
    zoomMeetingId: row.zoomMeetingId ?? null,
    hostEmail: row.zoomHostEmail,
    title: row.title,
    startTime: row.startTime.toISOString(),
    endTime: row.endTime.toISOString(),
  };
};

export const formatHostBufferConflict = (conflict: HostBufferConflict): string => {
  const gapMin = Math.round(conflict.bufferMs / 60_000);
  const start = conflict.existing.startTime.toISOString();
  const end = conflict.existing.endTime.toISOString();
  return (
    `Host ${conflict.hostEmail} is blocked by "${conflict.existing.title}" (${start} → ${end}); ` +
    `${gapMin} minute buffer required between bookings on the same seat.`
  );
};

// ── Database helpers (optional — call when you have no booking list in hand) ──

const toSeatBooking = (row: {
  id: string;
  zoomHostEmail: string | null;
  title: string;
  startTime: Date;
  endTime: Date;
  zoomJoinUrl?: string | null;
  meetUrl?: string | null;
  zoomMeetingId?: string | null;
}): SeatBooking | null => seatBookingFromMeetingRow(row);

/**
 * Active ZOOM meetings whose padded window may intersect `proposed`.
 *
 * The query is widened by the buffer so Postgres does the coarse filter and
 * the exact rule stays in `windowsConflict`.
 */
export const loadCandidateBookings = async (
  proposed: TimeWindow,
  options: HostBufferQueryOptions = {}
): Promise<SeatBooking[]> => {
  if (!validWindow(proposed)) return [];

  const bufferMs = resolveHostBufferMs(options.bufferMs);
  const padded = expandWindow(proposed, bufferMs);
  const hostFilter = options.hostEmail ? emailKey(options.hostEmail) : null;

  const rows = await withDbRetry(() =>
    db.meeting.findMany({
      where: {
        provider: 'ZOOM',
        status: { not: 'CANCELLED' },
        zoomHostEmail: hostFilter ? { equals: options.hostEmail, mode: 'insensitive' } : { not: null },
        startTime: { lt: padded.end },
        endTime: { gt: padded.start },
        ...(options.excludeMeetingId ? { id: { not: options.excludeMeetingId } } : {}),
      },
      select: {
        id: true,
        zoomHostEmail: true,
        title: true,
        startTime: true,
        endTime: true,
        zoomJoinUrl: true,
        meetUrl: true,
        zoomMeetingId: true,
      },
      orderBy: { startTime: 'asc' },
    })
  );

  return rows.map(toSeatBooking).filter((row): row is SeatBooking => row !== null);
};

/** Conflicts against the database for a proposed slot. */
export const findConflictsForWindow = async (
  proposed: TimeWindow,
  options: HostBufferQueryOptions = {}
): Promise<HostBufferConflict[]> => {
  const bookings = await loadCandidateBookings(proposed, options);
  return findConflictingBookings(proposed, bookings, options);
};

/** Busy host emails for a proposed slot (database-backed). */
export const findBusyHostsForWindow = async (
  proposed: TimeWindow,
  options: HostBufferQueryOptions = {}
): Promise<Set<string>> => {
  const bookings = await loadCandidateBookings(proposed, options);
  return busyHostKeys(proposed, bookings, options);
};

/** True when no active booking blocks this host for the proposed window. */
export const isHostAvailableForWindow = async (
  hostEmail: string,
  proposed: TimeWindow,
  options: Omit<HostBufferQueryOptions, 'hostEmail'> = {}
): Promise<boolean> => {
  const conflicts = await findConflictsForWindow(proposed, { ...options, hostEmail });
  return conflicts.length === 0;
};

/** Normalise caller input before any of the above. */
export const timeWindowFrom = (start: Date | string, end: Date | string): TimeWindow => ({
  start: asDate(start),
  end: asDate(end),
});
