import { db, withDbRetry } from '../../../database/datasource';
import {
  ZoomAuthService,
  ZoomApiError,
  ZoomConfigError,
  ZoomResolvedToken,
  callZoom,
  getZoomConfigErrors,
  zoomConfig,
} from '../auth/auth.service';
import { getActiveHostPool } from '../hosts/hosts.service';
import { logger } from '@futurespark/logger';

export interface CreateZoomMeetingInput {
  title: string;
  description?: string;
  startTime: string; // ISO string
  endTime: string; // ISO string
  timezone: string;
  attendees: string[];
  teacherId: string;
  studentId: string;
  programId: string;
  sessionId: string;
  /**
   * The mentor's own Zoom-licensed address, used as the preferred host when
   * ZOOM_PREFER_MENTOR_HOST is on. Optional and ignored otherwise.
   *
   * It has to be passed in: `teacherId` is an opaque id from another service's
   * database and this service holds no user table to resolve it against.
   */
  mentorEmail?: string;
}

export interface UpdateZoomMeetingInput {
  title?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  attendees?: string[];
  status?: string;
}

export type ZoomServiceErrorCode =
  | 'ZOOM_NOT_CONFIGURED'
  | 'ZOOM_VALIDATION'
  | 'ZOOM_DOUBLE_BOOKING'
  | 'ZOOM_HOST_POOL_EXHAUSTED'
  | 'ZOOM_NOT_FOUND'
  | 'ZOOM_API_FAILED';

/** Carries a machine-readable code so the controller can pick an HTTP status. */
export class ZoomServiceError extends Error {
  readonly code: ZoomServiceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ZoomServiceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ZoomServiceError';
    this.code = code;
    this.details = details;
  }
}

/** Statuses this service will write. Anything else is a caller bug, not data. */
const ALLOWED_STATUSES = new Set(['SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED']);

const normaliseEmail = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const emailKey = (value: string): string => value.trim().toLowerCase();

/** Seat ids for the meetings we create, so a row can be joined back to its
 *  host without matching on the address. Email stays the allocation key. */
let hostIdByEmailCache: { at: number; map: Map<string, string> } | null = null;
const HOST_ID_TTL_MS = 30_000;

const resolveHostId = async (email: string | null): Promise<string | null> => {
  if (!email) return null;
  if (!hostIdByEmailCache || Date.now() - hostIdByEmailCache.at > HOST_ID_TTL_MS) {
    try {
      const rows = await db.zoomHost.findMany({ select: { id: true, email: true } });
      hostIdByEmailCache = { at: Date.now(), map: new Map(rows.map((r) => [emailKey(r.email), r.id])) };
    } catch {
      // The id is a convenience for the admin table; never fail a booking for it.
      return null;
    }
  }
  return hostIdByEmailCache.map.get(emailKey(email)) ?? null;
};

/**
 * The instant, written as a wall-clock time in `timeZone`, for Zoom's API.
 *
 * Zoom reads `start_time` two ways: with a `Z` suffix it is GMT and the
 * `timezone` field becomes display decoration; without one it is local to the
 * `timezone` sent beside it. We were sending GMT-with-Z, so a class booked for
 * 7:00 PM IST showed in the Zoom client as its UTC clock time — "01:30 PM
 * Mumbai, Kolkata, New Delhi". The INSTANT was always right; the presentation
 * was not.
 *
 * The database keeps storing UTC. Only this outbound string is local, and it
 * is derived from the UTC instant through Intl — so DST and every other zone
 * rule is the ICU library's problem, not ours.
 */
export const zoomLocalTime = (at: Date, timeZone: string): string => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    // Some ICU builds render midnight as 24:00; Zoom wants 00:00.
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
  } catch {
    // An invalid IANA zone reached us. GMT-with-Z keeps the INSTANT correct,
    // which beats refusing to book; the display zone is then Zoom's default.
    logger.warn(`[ZoomMeetingsService] "${timeZone}" is not a valid IANA timezone — sending GMT to Zoom instead.`);
    return at.toISOString();
  }
};

const formatWindow = (start: Date, end: Date, timezone: string): string => {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    return `${fmt.format(start)} - ${fmt.format(end)}`;
  } catch {
    // An invalid IANA zone reached us from the request body.
    return `${start.toISOString()} - ${end.toISOString()}`;
  }
};

/**
 * Zoom errors that mean "not this host" rather than "not this request".
 *
 * 1001 user does not exist / 1010 user not in this account / 1113 host has no
 * privilege. Anything matching the message test covers the licence and
 * scheduling-privilege phrasings Zoom returns with a 400 or 403.
 */
const HOST_SPECIFIC_ZOOM_CODES = new Set([1001, 1010, 1113]);
const HOST_SPECIFIC_MESSAGE =
  /user (does not exist|not exist|not found)|does not belong|not belong to this account|schedule privilege|licen[cs]e|concurrent meeting/i;

/**
 * A missing credential is a deployment problem, not a Zoom rejection, and the
 * two want different HTTP statuses and different people looking at them.
 */
const rethrowAsConfigError = (err: unknown): void => {
  if (err instanceof ZoomConfigError) {
    throw new ZoomServiceError('ZOOM_NOT_CONFIGURED', err.message);
  }
};

const isHostSpecificZoomError = (err: unknown): boolean => {
  if (!(err instanceof ZoomApiError) || err.transport) return false;
  if (err.status === 404) return true;
  if (err.status !== 400 && err.status !== 403) return false;
  const code = Number(err.zoomCode);
  return HOST_SPECIFIC_ZOOM_CODES.has(code) || HOST_SPECIFIC_MESSAGE.test(err.message);
};

/**
 * Free seats, least-recently-used first.
 *
 * Deterministic on purpose: ties break on the order the seat was declared in
 * ZOOM_HOST_EMAILS, so the same inputs always pick the same seat and a support
 * question about "which host ran that class" has an answer that can be
 * reproduced. Seats never used inside the LRU window sort first (lastUsed 0),
 * so a freshly added seat is taken up immediately and load spreads instead of
 * piling onto seat 1.
 */
export const rankFreeHosts = (
  candidates: string[],
  busyKeys: Set<string>,
  lastUsedByKey: Map<string, number>
): string[] =>
  candidates
    .map((host, index) => ({ host, index, lastUsed: lastUsedByKey.get(emailKey(host)) ?? 0 }))
    .filter((seat) => !busyKeys.has(emailKey(seat.host)))
    .sort((a, b) => a.lastUsed - b.lastUsed || a.index - b.index)
    .map((seat) => seat.host);

/**
 * ONE lock for the whole seat pool, deliberately not per booking.
 *
 * Allocation is a read-then-write over a shared resource: "which seats are
 * busy in this window" followed by "take one". Two bookings for DIFFERENT
 * mentors at the same hour contend for the same last free seat, so a key
 * derived from the booking — the pair, the programme, the slot — puts them in
 * different lock classes, lets both read the same free seat and lets both take
 * it. That is the exact failure this work exists to remove, reproduced one
 * layer down. The pool is the contended resource, so the pool is the key.
 *
 * The cost is that Zoom creates serialise platform-wide for the duration of
 * one Zoom API call each. That is acceptable: the pool is small (a seat is a
 * paid licence), and Google Meet — not Zoom — is the primary provider.
 */
const HOST_POOL_LOCK_KEY = 'zoom:host-pool';

/**
 * Second lock, and the one taken FIRST: the same key string the Google path
 * uses (`google/meetings/meetings.service.ts`). It makes a Zoom booking and a
 * Google booking for the same mentor/student/programme serialise against each
 * other, which matters because the person-level conflict check below is
 * deliberately cross-provider — a mentor already teaching on Google Meet is
 * busy, whichever vendor the new class would use.
 *
 * Lock ORDER is the invariant that keeps this deadlock-free: pair BEFORE pool,
 * always, and Google only ever takes the pair lock. A cycle needs two
 * transactions acquiring in opposite orders, and no path does. Anything added
 * later must keep that order.
 *
 * Pair first is also the cheaper order. The alternative — pool first — would
 * mean a Zoom booking sits on the GLOBAL pool lock while waiting for a pair
 * lock that a slow Google Calendar call is holding, freezing every Zoom
 * booking on the platform behind one unrelated pair. This way the wait for the
 * global lock is the last thing that happens, and it is only ever held across
 * the seat queries plus one Zoom create.
 */
const pairLockKey = (input: { teacherId: string; studentId: string; programId: string }) =>
  `meeting:${input.teacherId}:${input.studentId}:${input.programId}`;

export class ZoomMeetingsService {
  /**
   * Creates a Zoom meeting on an allocated host seat and stores it.
   *
   * A licensed Zoom user can host only ONE live meeting at a time. Creating
   * every session under `users/me` therefore books fine and then fails at
   * class time, when the second mentor of an overlapping pair finds the host
   * already in a meeting. This allocates a free seat per session instead.
   */
  static async create(workspaceEmail: string, input: CreateZoomMeetingInput) {
    // 0. Is Zoom usable at all? Off by default, and never a silent fallback.
    const configErrors = getZoomConfigErrors();
    if (configErrors.length > 0) {
      throw new ZoomServiceError(
        'ZOOM_NOT_CONFIGURED',
        `Zoom is not configured, so no Zoom meeting was created:\n` +
          configErrors.map((e, i) => `  ${i + 1}. ${e}`).join('\n'),
        { configErrors }
      );
    }

    // 1. Validation
    const start = new Date(input.startTime);
    const end = new Date(input.endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new ZoomServiceError('ZOOM_VALIDATION', 'Invalid start or end time format. Use ISO-8601 strings.');
    }
    if (start >= end) {
      throw new ZoomServiceError('ZOOM_VALIDATION', 'Meeting start time must be before end time.');
    }

    const timezone = input.timezone || 'Asia/Kolkata';
    const durationMinutes = Math.max(15, Math.round((end.getTime() - start.getTime()) / (60 * 1000)));
    // The seat register (System → Zoom Hosts), not ZOOM_HOST_EMAILS. Read
    // before the transaction opens so the pool lock is held for as little time
    // as possible, and it falls back to the env list whenever the table has no
    // active seat — see hosts.service.ts for why that fallback exists.
    const pool = await getActiveHostPool();
    const mentorHost = zoomConfig.preferMentorHost ? normaliseEmail(input.mentorEmail) : null;

    if (zoomConfig.preferMentorHost && !mentorHost) {
      logger.info(
        `[ZoomMeetingsService] ZOOM_PREFER_MENTOR_HOST is on but session ${input.sessionId} carried no ` +
          `mentorEmail — allocating from the pool.`
      );
    }

    // Credentials are resolved BEFORE the transaction opens. The pool lock is
    // global, so every query issued while holding it competes for a second
    // pooled connection with every booking queued behind it; see
    // `resolveHostCredentials`. It also means a disabled or uncredentialed
    // Zoom fails here, before any lock is taken.
    const credentials = await ZoomAuthService.resolveHostCredentials(
      mentorHost ? [mentorHost, ...pool] : pool,
      workspaceEmail
    ).catch((err) => {
      rethrowAsConfigError(err);
      throw new ZoomServiceError('ZOOM_API_FAILED', `Could not obtain a Zoom credential: ${err.message}`);
    });

    return db.$transaction(
      async (tx) => {
        // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, and
        // $queryRaw tries to deserialize every returned column — it cannot map
        // a void one and throws. We want the lock, not the result.
        //
        // Both locks are transaction-scoped, so they release on commit OR
        // rollback; a crash mid-booking cannot wedge the pool. Order is fixed:
        // pair first, pool second. See the comments on the keys above.
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', pairLockKey(input));
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', HOST_POOL_LOCK_KEY);

        // 2. Retrying the exact same booking? Reuse the room instead of failing.
        //
        // Provider-scoped, unlike before: the same pair can hold a Google room
        // and a Zoom room for the same slot, and without the filter this
        // returned the Google row and handed a meet.google.com URL back as
        // `joinUrl` with an empty `zoomMeetingId`.
        const sameBooking = await tx.meeting.findFirst({
          where: {
            provider: 'ZOOM',
            startTime: start,
            status: { not: 'CANCELLED' },
            teacherId: input.teacherId,
            studentId: input.studentId,
          },
          orderBy: { createdAt: 'desc' },
        });

        if (sameBooking) {
          logger.info(
            `[ZoomMeetingsService] Reusing existing Zoom room ${sameBooking.zoomJoinUrl || sameBooking.meetUrl} ` +
              `for meeting ${sameBooking.id} (host ${sameBooking.zoomHostEmail ?? 'unknown'}) — no Zoom call.`
          );
          return {
            id: sameBooking.id,
            zoomMeetingId: sameBooking.zoomMeetingId || '',
            hostEmail: sameBooking.zoomHostEmail,
            meetLink: sameBooking.meetUrl,
            joinUrl: sameBooking.zoomJoinUrl || sameBooking.meetUrl,
            startUrl: sameBooking.zoomStartUrl || sameBooking.meetUrl,
            passcode: sameBooking.zoomPasscode || '',
            calendarLink: sameBooking.meetUrl,
            startTime: sameBooking.startTime.toISOString(),
            endTime: sameBooking.endTime.toISOString(),
            reused: true,
          };
        }

        // 3. Double-booking check for the PERSON, deliberately across every
        // provider: a mentor already teaching on Google Meet at that instant
        // is busy regardless of which vendor this class would use.
        const conflict = await tx.meeting.findFirst({
          where: {
            startTime: start,
            status: { not: 'CANCELLED' },
            OR: [{ teacherId: input.teacherId }, { studentId: input.studentId }],
          },
        });

        if (conflict) {
          const who = conflict.teacherId === input.teacherId ? 'mentor' : 'student';
          const localTime = new Intl.DateTimeFormat('en-GB', {
            timeZone: conflict.timezone || timezone || 'Asia/Kolkata',
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(start);
          throw new ZoomServiceError(
            'ZOOM_DOUBLE_BOOKING',
            `This ${who} is already booked at ${localTime} for "${conflict.title}". Pick a different time or mentor.`
          );
        }

        // 4. Seat allocation.
        //
        // A seat is BUSY when a non-CANCELLED ZOOM meeting it hosts overlaps
        // [start, end): existing.startTime < newEnd AND existing.endTime >
        // newStart. Touching endpoints do not overlap, so back-to-back classes
        // share a seat.
        //
        // The query is not filtered by seat address, so a legacy row whose
        // host Zoom reported under different capitalisation still counts
        // against that seat; matching happens case-insensitively below.
        const overlapping = await tx.meeting.findMany({
          where: {
            provider: 'ZOOM',
            status: { not: 'CANCELLED' },
            zoomHostEmail: { not: null },
            startTime: { lt: end },
            endTime: { gt: start },
          },
          select: { zoomHostEmail: true },
        });
        const busyKeys = new Set(
          overlapping
            .map((row) => row.zoomHostEmail)
            .filter((host): host is string => Boolean(host))
            .map(emailKey)
        );

        // Least-recently-used ordering. Bounded by a window so this stays a
        // small aggregate rather than a scan of every Zoom meeting ever, and
        // grouped in the database rather than pulled row by row.
        const lruWindowStart = new Date(Date.now() - zoomConfig.hostLruWindowDays * 24 * 60 * 60 * 1000);
        const usageRows = await tx.meeting.groupBy({
          by: ['zoomHostEmail'],
          where: {
            provider: 'ZOOM',
            status: { not: 'CANCELLED' },
            zoomHostEmail: { not: null },
            startTime: { gte: lruWindowStart },
          },
          _max: { startTime: true },
        });
        const lastUsedByKey = new Map<string, number>();
        for (const row of usageRows) {
          if (!row.zoomHostEmail) continue;
          lastUsedByKey.set(emailKey(row.zoomHostEmail), row._max.startTime?.getTime() ?? 0);
        }

        const freeSeats = rankFreeHosts(pool, busyKeys, lastUsedByKey);
        const candidates: string[] = [];
        // The mentor's own account goes first when preferred and free; the
        // pool is the fallback behind it.
        if (mentorHost && !busyKeys.has(emailKey(mentorHost))) candidates.push(mentorHost);
        for (const seat of freeSeats) {
          if (mentorHost && emailKey(seat) === emailKey(mentorHost)) continue;
          candidates.push(seat);
        }

        if (candidates.length === 0) {
          const window = formatWindow(start, end, timezone);
          logger.error(
            `[ZoomMeetingsService] Host pool exhausted for session ${input.sessionId}: all ${pool.length} ` +
              `seat(s) busy between ${start.toISOString()} and ${end.toISOString()}. ` +
              `Busy seats: ${[...busyKeys].join(', ') || 'none matched the pool'}.`
          );
          throw new ZoomServiceError(
            'ZOOM_HOST_POOL_EXHAUSTED',
            `All ${pool.length} Zoom host seat${pool.length === 1 ? '' : 's'} are already hosting a meeting that ` +
              `overlaps ${window} (${timezone}). A licensed Zoom host can run only one live meeting at a time, so ` +
              `this session cannot be booked in that window. Move the session, or add another licensed seat to ` +
              `ZOOM_HOST_EMAILS (there ${pool.length === 1 ? 'is' : 'are'} ${pool.length} today).`,
            { poolSize: pool.length, startTime: start.toISOString(), endTime: end.toISOString(), timezone }
          );
        }

        // 5. Create on Zoom, under the allocated seat.
        const zoomPayload = {
          topic: input.title,
          agenda: input.description || `FutureSpark Session: ${input.title}`,
          type: 2, // Scheduled meeting
          // The parsed instant, re-expressed as wall-clock time in `timezone`.
          // Derived from the UTC instant — never the raw request string, which
          // was once forwarded verbatim and only meant the right moment by
          // luck. Local-without-Z is what makes the Zoom client display the
          // booked 7:00 PM as 7:00 PM; see zoomLocalTime.
          start_time: zoomLocalTime(start, timezone),
          duration: durationMinutes,
          timezone,
          settings: {
            host_video: true,
            participant_video: true,
            // A pool seat is an unattended service account — nobody signs into
            // it — so without join_before_host there is no host to admit
            // anyone and the class is a locked door. See the honest writeup of
            // the safeguarding tradeoff on `zoomConfig.joinBeforeHost`:
            // join_before_host and waiting_room are mutually exclusive, so
            // this also means no waiting room and no vetting at the door.
            join_before_host: zoomConfig.joinBeforeHost,
            jbh_time: 0,
            mute_upon_entry: true,
            waiting_room: !zoomConfig.joinBeforeHost,
            auto_recording: 'cloud', // the whole recording pipeline hangs on this
            audio: 'both',
            meeting_authentication: false,
          },
        };

        let zoomData: any = null;
        let chosenHost = '';
        const attempted: string[] = [];
        const maxHostAttempts = Math.min(candidates.length, zoomConfig.maxHostAttempts);

        for (let i = 0; i < maxHostAttempts; i++) {
          const host = candidates[i];
          attempted.push(host);
          try {
            // Host selection and token selection are separate concerns: the
            // seat decides the URL, this decides whose credential signs it.
            // Already resolved above — no database work happens under the lock.
            const auth = credentials.byHost.get(emailKey(host)) ?? credentials.fallback;
            const { data } = await callZoom<any>(
              { operation: 'create', host, sessionId: input.sessionId },
              {
                method: 'POST',
                url: `https://api.zoom.us/v2/users/${encodeURIComponent(host)}/meetings`,
                bearer: auth.accessToken,
                json: zoomPayload,
              }
            );
            if (!data?.id || !data?.join_url) {
              throw new ZoomApiError('Zoom accepted the create but returned no meeting id or join_url.');
            }
            zoomData = data;
            chosenHost = host;
            logger.info(
              `[ZoomMeetingsService] Allocated host ${host} for session ${input.sessionId} ` +
                `(credential: ${auth.identity}${auth.identityEmail ? ` as ${auth.identityEmail}` : ''}).`
            );
            break;
          } catch (err: any) {
            // Trying another seat cannot help when the problem is that this
            // deployment has no Zoom credential at all.
            rethrowAsConfigError(err);
            if (err instanceof ZoomServiceError) throw err;
            const canTryAnother = isHostSpecificZoomError(err) && i + 1 < maxHostAttempts;
            if (!canTryAnother) {
              logger.error(
                `[ZoomMeetingsService] Zoom create failed for session ${input.sessionId} on host ${host}: ${err.message}`
              );
              throw new ZoomServiceError(
                'ZOOM_API_FAILED',
                `Could not create the Zoom meeting on host ${host}: ${err.message}. No meeting was scheduled — ` +
                  `please retry. If this repeats, check that ${host} is a licensed Zoom user on this account.`,
                { host, attempted, status: err instanceof ZoomApiError ? err.status : undefined }
              );
            }
            // The seat itself is the problem — unlicensed, unknown, or not on
            // this account. Move to the next free one rather than failing the
            // class, and shout so the bad seat gets fixed.
            logger.error(
              `[ZoomMeetingsService] Host ${host} rejected the create (${err.message}). Falling back to the ` +
                `next free seat. Fix or remove this address in ZOOM_HOST_EMAILS.`
            );
          }
        }

        if (!zoomData || !chosenHost) {
          throw new ZoomServiceError(
            'ZOOM_API_FAILED',
            `Could not create the Zoom meeting after trying ${attempted.length} host(s). No meeting was scheduled.`,
            { attempted }
          );
        }

        const meetingIdStr = String(zoomData.id);
        const joinUrl = zoomData.join_url;
        const startUrl = zoomData.start_url || zoomData.join_url;
        const passcode = zoomData.password || zoomData.encrypted_password || '';

        // Zoom does NOT fail a create when the host cannot honour a setting —
        // it silently downgrades it and returns 201. Cloud recording is
        // per-user licensed, so a Basic or recording-disabled seat produces a
        // perfectly good join URL and zero recordings, which only surfaces
        // days later as an empty recording sync. Read the echo back.
        const echoedRecording = zoomData?.settings?.auto_recording;
        if (echoedRecording !== 'cloud') {
          logger.error(
            `[ZoomMeetingsService] Host ${chosenHost} downgraded auto_recording to "${echoedRecording ?? 'unset'}" ` +
              `for session ${input.sessionId} (Zoom meeting ${meetingIdStr}). THIS CLASS WILL NOT BE RECORDED. ` +
              `Enable cloud recording for that licensed user, or remove it from ZOOM_HOST_EMAILS.`
          );
        }
        const echoedJbh = zoomData?.settings?.join_before_host;
        if (zoomConfig.joinBeforeHost && echoedJbh === false) {
          logger.error(
            `[ZoomMeetingsService] Host ${chosenHost} forced join_before_host off for session ${input.sessionId}. ` +
              `Nobody can enter this room unless a human signs into ${chosenHost} to admit them.`
          );
        }

        // 6. Store. `zoomHostEmail` holds the seat we ASKED for, not the
        // address Zoom echoed, because that column is what the allocator reads
        // back on the next booking and it must match the pool string.
        const hostId = await resolveHostId(chosenHost);

        const meeting = await tx.meeting.create({
          data: {
            provider: 'ZOOM',
            zoomMeetingId: meetingIdStr,
            zoomJoinUrl: joinUrl,
            zoomStartUrl: startUrl,
            zoomPasscode: passcode,
            zoomHostEmail: chosenHost,
            ...(hostId ? { zoomHostId: hostId } : {}),
            meetUrl: joinUrl,
            title: input.title,
            description: input.description || null,
            organizerEmail: workspaceEmail,
            teacherId: input.teacherId,
            studentId: input.studentId,
            programId: input.programId,
            sessionId: input.sessionId,
            startTime: start,
            endTime: end,
            timezone,
            status: 'SCHEDULED',
          },
        });

        logger.info(
          `[ZoomMeetingsService] Created Zoom meeting ${meetingIdStr} on ${chosenHost} ` +
            `(DB ID: ${meeting.id}, session ${input.sessionId}).`
        );

        return {
          id: meeting.id,
          zoomMeetingId: meetingIdStr,
          hostEmail: chosenHost,
          meetLink: joinUrl,
          joinUrl,
          startUrl,
          passcode,
          calendarLink: joinUrl,
          startTime: meeting.startTime.toISOString(),
          endTime: meeting.endTime.toISOString(),
          reused: false,
        };
      },
      {
        // The Zoom create happens inside the locks, so the transaction has to
        // outlast a throttled call plus its backoff. Prisma's 5s default would
        // abort a booking that was about to succeed.
        timeout: zoomConfig.createTimeoutMs,
        maxWait: zoomConfig.createMaxWaitMs,
      }
    );
  }

  /**
   * Lists scheduled meetings from DB with optional filters.
   */
  static async list(filter?: {
    teacherId?: string;
    studentId?: string;
    programId?: string;
    status?: string;
    provider?: string;
  }) {
    return withDbRetry(() =>
      db.meeting.findMany({
        where: {
          ...(filter?.teacherId ? { teacherId: filter.teacherId } : {}),
          ...(filter?.studentId ? { studentId: filter.studentId } : {}),
          ...(filter?.programId ? { programId: filter.programId } : {}),
          ...(filter?.status ? { status: filter.status } : {}),
          ...(filter?.provider ? { provider: filter.provider } : {}),
        },
        include: {
          recordings: true,
        },
        orderBy: { startTime: 'asc' },
      })
    );
  }

  /**
   * Retrieves single meeting by database ID.
   */
  static async get(id: string) {
    const meeting = await withDbRetry(() =>
      db.meeting.findUnique({
        where: { id },
        include: { recordings: true },
      })
    );
    if (!meeting) throw new ZoomServiceError('ZOOM_NOT_FOUND', `Meeting with ID ${id} not found.`);
    // Provider-scoped like every other lookup here. Unfiltered, this returned a
    // Google row verbatim — so GET /zoom/meetings/:id handed back a
    // meet.google.com URL, and worse, update() and delete() inherit this read
    // and would then try to PATCH a Zoom meeting id that does not exist while
    // mutating a Google row's state.
    if (meeting.provider !== 'ZOOM') {
      throw new ZoomServiceError(
        'ZOOM_NOT_FOUND',
        `Meeting ${id} is not a Zoom meeting (provider: ${meeting.provider}).`
      );
    }
    return meeting;
  }

  /**
   * Updates a Zoom meeting on Zoom AND in the database.
   *
   * The old version fired the PATCH, never read the response, and wrote the
   * new times to the row whichever way it went — so a Zoom-side 404 or 400
   * left the platform showing a class as moved while Zoom still held the
   * original room, with nothing louder than a `logger.warn` to say so. Zoom is
   * now updated FIRST and a failure aborts before the row is touched.
   */
  static async update(id: string, input: UpdateZoomMeetingInput) {
    const meeting = await this.get(id);

    // ── Validate before anything else writes or calls out ──
    const nextStart = input.startTime !== undefined ? new Date(input.startTime) : meeting.startTime;
    const nextEnd = input.endTime !== undefined ? new Date(input.endTime) : meeting.endTime;
    if (isNaN(nextStart.getTime()) || isNaN(nextEnd.getTime())) {
      throw new ZoomServiceError('ZOOM_VALIDATION', 'Invalid start or end time format. Use ISO-8601 strings.');
    }
    if (nextStart >= nextEnd) {
      throw new ZoomServiceError('ZOOM_VALIDATION', 'Meeting start time must be before end time.');
    }
    if (input.status !== undefined && !ALLOWED_STATUSES.has(input.status)) {
      throw new ZoomServiceError(
        'ZOOM_VALIDATION',
        `Unknown status "${input.status}". Allowed: ${[...ALLOWED_STATUSES].join(', ')}.`
      );
    }

    // Cancelling is a Zoom operation, not a column write.
    //
    // `zoomPatch` below is built only from fields Zoom knows about, and status
    // is not one of them — so a PUT carrying {"status":"CANCELLED"} used to mark
    // the row cancelled while the Zoom meeting stayed live and its seat stayed
    // occupied. The platform then showed the class as cancelled, the seat was
    // never released for anyone else to book, and the room was still joinable.
    // Route it through the cancel path, which actually tells Zoom.
    if (input.status === 'CANCELLED' && meeting.status !== 'CANCELLED') {
      const otherFields = (Object.keys(input) as (keyof UpdateZoomMeetingInput)[]).filter(
        (k) => k !== 'status' && input[k] !== undefined
      );
      if (otherFields.length > 0) {
        throw new ZoomServiceError(
          'ZOOM_VALIDATION',
          `Cancelling cannot be combined with other changes (received: ${otherFields.join(', ')}). ` +
            `Cancel the meeting, then book a new one.`
        );
      }
      return this.delete(id);
    }

    const startChanged = nextStart.getTime() !== meeting.startTime.getTime();
    const endChanged = nextEnd.getTime() !== meeting.endTime.getTime();
    const timezoneChanged = input.timezone !== undefined && input.timezone !== meeting.timezone;
    const timesChanged = startChanged || endChanged;

    // What Zoom actually needs to hear about. Our own `status` is internal and
    // Zoom has never heard of it.
    const zoomPatch: Record<string, unknown> = {};
    if (input.title !== undefined && input.title !== meeting.title) zoomPatch.topic = input.title;
    if (input.description !== undefined && (input.description || null) !== meeting.description) {
      zoomPatch.agenda = input.description ?? '';
    }
    // The zone the patched times should read in — the new one when the caller
    // is changing it, else whatever the meeting was booked under.
    const nextTimezone = input.timezone ?? meeting.timezone ?? 'Asia/Kolkata';

    if (startChanged) zoomPatch.start_time = zoomLocalTime(nextStart, nextTimezone);
    if (timesChanged) {
      // Recomputed from the EFFECTIVE window, so moving only the end time
      // still resizes the meeting. The old code only sent a duration when both
      // ends were supplied together.
      zoomPatch.duration = Math.max(15, Math.round((nextEnd.getTime() - nextStart.getTime()) / 60000));
    }
    if (timezoneChanged) {
      zoomPatch.timezone = input.timezone;
      zoomPatch.start_time = zoomPatch.start_time ?? zoomLocalTime(nextStart, nextTimezone);
    }
    // A local start_time only means what the timezone beside it says it means,
    // so the two always travel together — a bare local time would otherwise be
    // read in whatever zone the meeting happened to hold before.
    if (zoomPatch.start_time !== undefined && zoomPatch.timezone === undefined) {
      zoomPatch.timezone = nextTimezone;
    }

    const dbData = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.startTime !== undefined ? { startTime: nextStart } : {}),
      ...(input.endTime !== undefined ? { endTime: nextEnd } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    };

    const needsSeatRecheck =
      timesChanged && meeting.provider === 'ZOOM' && Boolean(meeting.zoomHostEmail) && meeting.status !== 'CANCELLED';

    // Resolved before any transaction opens, for the connection-pool reason
    // described on `resolveHostCredentials`, and so that a disabled Zoom is
    // refused before a lock is taken.
    const needsZoomCall = Boolean(meeting.zoomMeetingId) && Object.keys(zoomPatch).length > 0;
    let auth: ZoomResolvedToken | null = null;
    if (needsZoomCall) {
      if (!zoomConfig.enabled) {
        // Refusing is the point: writing new times locally while Zoom keeps
        // the old ones is exactly the failure being fixed here.
        throw new ZoomServiceError(
          'ZOOM_NOT_CONFIGURED',
          `Zoom is disabled (ZOOM_ENABLED is not "true"), so Zoom meeting ${meeting.zoomMeetingId} cannot be ` +
            `updated. Refusing to change the class locally while Zoom still holds the original room.`
        );
      }
      // The host owns the meeting, so prefer its credential; the organizer is
      // the fallback. Previously this always used organizerEmail, which is not
      // the host at all once a pool is in play.
      auth = await ZoomAuthService.resolveTokenForHost(meeting.zoomHostEmail, meeting.organizerEmail).catch((err) => {
        rethrowAsConfigError(err);
        throw new ZoomServiceError('ZOOM_API_FAILED', `Could not obtain a Zoom credential: ${err.message}`);
      });
    }

    // Simple path: nothing that could collide with another booking's seat.
    if (!needsSeatRecheck) {
      const zoomSynced = await this.syncZoomPatch(meeting, zoomPatch, auth);
      const updated = await withDbRetry(() => db.meeting.update({ where: { id }, data: dbData }));
      return { ...updated, zoomSynced };
    }

    // Moving a meeting can move it on top of another class already using the
    // same seat, which recreates the very failure the host pool exists to
    // prevent. A Zoom meeting cannot change owner, so the seat has to still be
    // free in the NEW window. Checked under the pool lock so a concurrent
    // create cannot take the seat in between.
    return db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', HOST_POOL_LOCK_KEY);

        const clash = await tx.meeting.findFirst({
          where: {
            id: { not: id },
            provider: 'ZOOM',
            status: { not: 'CANCELLED' },
            zoomHostEmail: meeting.zoomHostEmail,
            startTime: { lt: nextEnd },
            endTime: { gt: nextStart },
          },
          select: { id: true, title: true, startTime: true, endTime: true },
        });

        if (clash) {
          const window = formatWindow(nextStart, nextEnd, input.timezone || meeting.timezone);
          throw new ZoomServiceError(
            'ZOOM_HOST_POOL_EXHAUSTED',
            `Cannot move this class to ${window}: its Zoom host seat (${meeting.zoomHostEmail}) is already ` +
              `hosting "${clash.title}" in that window, and a Zoom meeting cannot be handed to a different host. ` +
              `Cancel and rebook the session to have a free seat allocated for the new time.`,
            { host: meeting.zoomHostEmail, conflictingMeetingId: clash.id }
          );
        }

        const zoomSynced = await this.syncZoomPatch(meeting, zoomPatch, auth);
        const updated = await tx.meeting.update({ where: { id }, data: dbData });
        return { ...updated, zoomSynced };
      },
      { timeout: zoomConfig.createTimeoutMs, maxWait: zoomConfig.createMaxWaitMs }
    );
  }

  /**
   * PATCHes Zoom, or explains why it did not. Returns whether Zoom now agrees
   * with what we are about to write. THROWS on a real failure — the caller
   * must not touch the database when this rejects.
   */
  private static async syncZoomPatch(
    meeting: { id: string; zoomMeetingId: string | null; zoomHostEmail: string | null; organizerEmail: string; sessionId: string },
    zoomPatch: Record<string, unknown>,
    auth: ZoomResolvedToken | null
  ): Promise<boolean> {
    const skip = (reason: string) => {
      logger.info(
        `[ZoomApi] ${JSON.stringify({
          operation: 'patch',
          sessionId: meeting.sessionId,
          meetingId: meeting.zoomMeetingId,
          host: meeting.zoomHostEmail,
          outcome: 'skipped',
          reason,
          at: new Date().toISOString(),
        })}`
      );
      return false;
    };

    if (!meeting.zoomMeetingId) return skip('the meeting has no Zoom meeting id');
    if (Object.keys(zoomPatch).length === 0) return skip('no Zoom-facing fields changed');
    if (!auth) {
      // Unreachable via `update`, which resolves a credential whenever there
      // is anything to send. Refusing rather than assuming keeps it that way.
      throw new ZoomServiceError(
        'ZOOM_NOT_CONFIGURED',
        `No Zoom credential was resolved for meeting ${meeting.zoomMeetingId}; refusing to change the class ` +
          `locally while Zoom still holds the original room.`
      );
    }

    try {
      await callZoom(
        { operation: 'patch', meetingId: meeting.zoomMeetingId, host: meeting.zoomHostEmail, sessionId: meeting.sessionId },
        {
          method: 'PATCH',
          url: `https://api.zoom.us/v2/meetings/${encodeURIComponent(meeting.zoomMeetingId)}`,
          bearer: auth.accessToken,
          json: zoomPatch,
        }
      );
      return true;
    } catch (err: any) {
      if (err instanceof ZoomApiError && err.status === 404) {
        throw new ZoomServiceError(
          'ZOOM_NOT_FOUND',
          `Zoom meeting ${meeting.zoomMeetingId} no longer exists on Zoom, so it could not be moved. ` +
            `The class was NOT changed. Cancel it and book a new session.`,
          { zoomMeetingId: meeting.zoomMeetingId }
        );
      }
      throw new ZoomServiceError(
        'ZOOM_API_FAILED',
        `Zoom rejected the update to meeting ${meeting.zoomMeetingId}: ${err.message}. The class was NOT changed — ` +
          `please retry.`,
        { zoomMeetingId: meeting.zoomMeetingId, status: err instanceof ZoomApiError ? err.status : undefined }
      );
    }
  }

  /**
   * Reschedules a Zoom meeting by its join link.
   *
   * Provider-scoped: `meetUrl` holds the join URL for both vendors, so without
   * the filter a Google row could answer a Zoom reschedule.
   */
  static async rescheduleByLink(
    zoomUrl: string,
    newStartTime: string,
    newEndTime: string,
    timezone?: string
  ) {
    const meeting = await withDbRetry(() =>
      db.meeting.findFirst({
        where: {
          provider: 'ZOOM',
          OR: [{ meetUrl: zoomUrl }, { zoomJoinUrl: zoomUrl }],
          status: { not: 'CANCELLED' },
        },
        orderBy: { createdAt: 'desc' },
      })
    );

    if (!meeting) {
      throw new ZoomServiceError('ZOOM_NOT_FOUND', `Active Zoom meeting for link ${zoomUrl} was not found.`);
    }

    return this.update(meeting.id, {
      startTime: newStartTime,
      endTime: newEndTime,
      // The scheduler sends a timezone and it used to be dropped on the floor
      // here and in the controller, so a class moved across a DST boundary
      // kept the old zone.
      ...(timezone ? { timezone } : {}),
    });
  }

  /**
   * Cancels a meeting: deleted on Zoom, soft-cancelled locally.
   */
  static async delete(id: string): Promise<ZoomCancelResult> {
    const meeting = await this.get(id);

    if (meeting.status === 'CANCELLED') {
      // Schedulers retry deletes and the UI double-fires them. Cancelling
      // something already cancelled is a no-op, not a Zoom request.
      return {
        success: true,
        matched: true,
        id: meeting.id,
        status: 'CANCELLED',
        zoomSynced: false,
        message: 'Meeting was already cancelled.',
      };
    }

    let zoomSynced = false;
    let note = '';

    if (meeting.zoomMeetingId) {
      if (!zoomConfig.enabled) {
        // Deliberately asymmetric with `update`: an un-deleted room nobody is
        // told to join is a leak, while blocking cancellation forever leaves
        // the platform unable to manage its own classes. Cancel locally, but
        // never silently — the room has to be removed by hand.
        note =
          ` Zoom is disabled (ZOOM_ENABLED is not "true"), so Zoom meeting ${meeting.zoomMeetingId} was NOT deleted` +
          ` and must be removed manually.`;
        logger.error(`[ZoomMeetingsService] ${note.trim()}`);
      } else {
        const auth = await ZoomAuthService.resolveTokenForHost(
          meeting.zoomHostEmail,
          meeting.organizerEmail
        ).catch((err) => {
          rethrowAsConfigError(err);
          throw err;
        });
        try {
          await callZoom(
            {
              operation: 'delete',
              meetingId: meeting.zoomMeetingId,
              host: meeting.zoomHostEmail,
              sessionId: meeting.sessionId,
            },
            {
              method: 'DELETE',
              url: `https://api.zoom.us/v2/meetings/${encodeURIComponent(meeting.zoomMeetingId)}`,
              bearer: auth.accessToken,
            }
          );
          zoomSynced = true;
        } catch (err: any) {
          // Already gone on Zoom is the desired end state, not a failure.
          if (err instanceof ZoomApiError && err.status === 404) {
            zoomSynced = true;
            note = ` Zoom meeting ${meeting.zoomMeetingId} was already gone on Zoom.`;
            logger.warn(`[ZoomMeetingsService]${note}`);
          } else {
            // Anything else and the room is still live. Say so instead of
            // marking the class cancelled and hoping.
            throw new ZoomServiceError(
              'ZOOM_API_FAILED',
              `Zoom refused to delete meeting ${meeting.zoomMeetingId}: ${err.message}. The class was NOT ` +
                `cancelled, because the Zoom room is still live — please retry.`,
              { zoomMeetingId: meeting.zoomMeetingId, status: err instanceof ZoomApiError ? err.status : undefined }
            );
          }
        }
      }
    }

    // Soft delete: keep local history but mark the row CANCELLED, which is
    // also what frees the host seat for that window.
    const cancelled = await withDbRetry(() =>
      db.meeting.update({ where: { id }, data: { status: 'CANCELLED' } })
    );

    logger.info(
      `[ZoomMeetingsService] Meeting ${id} cancelled (host ${meeting.zoomHostEmail ?? 'none'}, ` +
        `zoomSynced=${zoomSynced}).`
    );

    return {
      success: true,
      matched: true,
      id: cancelled.id,
      status: cancelled.status,
      zoomSynced,
      message: `Meeting cancelled.${note}`,
    };
  }

  /**
   * Cancels by join link.
   *
   * No longer answers `{ success: true }` when nothing matched — a cancel that
   * hit no row is not a cancel, and reporting it as one is how a live Zoom
   * room outlives the class that was supposedly called off.
   */
  static async deleteByLink(zoomUrl: string): Promise<ZoomCancelResult> {
    const meeting = await withDbRetry(() =>
      db.meeting.findFirst({
        where: {
          provider: 'ZOOM',
          OR: [{ meetUrl: zoomUrl }, { zoomJoinUrl: zoomUrl }],
          status: { not: 'CANCELLED' },
        },
        orderBy: { createdAt: 'desc' },
      })
    );

    if (!meeting) {
      logger.warn(`[ZoomMeetingsService] No active Zoom meeting found for link: ${zoomUrl}`);
      return {
        success: false,
        matched: false,
        id: null,
        status: null,
        zoomSynced: false,
        message: `No active Zoom meeting matched ${zoomUrl}. Nothing was cancelled.`,
      };
    }

    return this.delete(meeting.id);
  }
}

export interface ZoomCancelResult {
  /** Did something actually get cancelled? */
  success: boolean;
  /** Did a database row match at all? */
  matched: boolean;
  id: string | null;
  status: string | null;
  /** Did Zoom confirm the room is gone? */
  zoomSynced: boolean;
  message: string;
}
