import { db } from '../../database/datasource';

/**
 * /metrics — the aggregate numbers behind the admin's System Health page.
 *
 * Everything here is read-only and windowed: counts, groupBys and small
 * take-limited lists, never an unbounded row scan. The auth client is
 * multiSchema, so Program, Session and Lead (learning schema) are queried on
 * the same `db` as the classes — the same follow-up-by-id trick
 * `listSchedules` uses, since none of them has a relation to ScheduledClass.
 *
 * Exported as plain async functions (not a service object) so the gateway's
 * smoke tests can call them straight from dist without standing up Express.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Answers are cached for a minute.
 *
 * Every database URL in this project pins `connection_limit=1`, so concurrent
 * queries do not overlap — they queue, and each one is a full round trip to a
 * hosted Postgres. That makes the query COUNT, not the query cost, the thing
 * that decides how long this endpoint takes, which is why the counts below are
 * folded into single-pass SQL and why the result is held briefly: the dashboard
 * polls every 60s and several admins may watch it at once.
 */
/**
 * Five minutes, not one.
 *
 * These are 7- and 30-day aggregates: they do not meaningfully move in a
 * minute, and every cache miss holds the service's ONE database connection
 * (connection_limit=1 in the URL) long enough to time out an interactive page
 * waiting behind it — measured: a metrics pass under load starved
 * `GET /roles` into a pool-checkout timeout at 10s. Refresh forces through.
 */
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<number, { at: number; data: any }>();

/**
 * One row of counts over ScheduledClass, computed in a single pass.
 *
 * `COUNT(*) FILTER (WHERE …)` is what makes this affordable: as twenty separate
 * `count()` calls this was twenty round trips (~9s of the endpoint's 15s), and
 * Postgres evaluates all of these while streaming the table once.
 */
interface ClassCountsRow {
  funnel_completed: bigint;
  funnel_transcribed: bigint;
  funnel_summarised: bigint;
  funnel_sent: bigint;
  status_completed: bigint;
  status_cancelled: bigint;
  status_reschedule: bigint;
  status_any: bigint;
  upcoming: bigint;
  demo_total: bigint;
  demo_completed: bigint;
  quiz_launched: bigint;
  quiz_submitted: bigint;
  quiz_pending_review: bigint;
  reports_sent_this_month: bigint;
  attempts_0: bigint;
  attempts_1: bigint;
  attempts_2: bigint;
  attempts_3plus: bigint;
}

/** Headcounts across four tables — scalar subqueries, still one round trip. */
interface PeopleCountsRow {
  students_active: bigint;
  students_new: bigint;
  parents_active: bigint;
  parents_new: bigint;
  mentors_active: bigint;
  mentors_new: bigint;
  staff_active: bigint;
  staff_new: bigint;
  leads_total: bigint;
  leads_new: bigint;
  leads_payment_verified: bigint;
  doubts_open: bigint;
  doubts_answered: bigint;
}

/** Postgres counts are int8, which the driver hands back as BigInt. */
const n = (value: bigint | number | null | undefined): number => Number(value ?? 0);

/**
 * Mirrors `isMentorRole` in schedule.service.ts: a mentor reaches us as either
 * `TEACHER` (what the auth schema stores) or `INSTRUCTOR` (what the curriculum
 * side issues). Counting only one of them would halve the mentor headcount.
 */
const MENTOR_ROLE_NAMES = ['TEACHER', 'INSTRUCTOR'];

/** The window is a picker, not a free dial: 7 or 30, anything else means 7. */
export const clampDays = (raw: unknown): 7 | 30 => (Number(raw) === 30 ? 30 : 7);

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * null in, null out: an average over no rows is "could not be measured", and
 * the contract forbids dressing that up as a zero.
 */
const avgOrNull = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

const medianOrNull = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const round1OrNull = (n: number | null): number | null => (n === null ? null : round1(n));

/**
 * Report failures are stored as "[KIND] human sentence" by the dispatcher, so
 * the kind is recoverable without a second column. Anything unprefixed is a
 * genuine surprise and lands in OTHER rather than being dropped.
 */
const failureKindOf = (error: string): string => {
  const match = /^\[([^\]\s]+)\]/.exec(error.trim());
  return match ? match[1] : 'OTHER';
};

/** groupBy actorRole → plain object the dashboard can render as-is. */
const toRoleCounts = (
  groups: { actorRole: string | null; _count: { _all: number } }[]
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const g of groups) {
    counts[g.actorRole ?? 'UNKNOWN'] = g._count._all;
  }
  return counts;
};

/**
 * Batched name/phone lookups for the small take-limited class lists the
 * metrics return. Session and Lead live in the learning schema with no
 * relation to ScheduledClass, so a findMany per id set is the only shape
 * available — never per row.
 */
const loadClassRefContext = async (
  rows: { studentId: string | null; leadId: string | null; sessionId: string | null }[]
) => {
  const uniqueIds = (values: (string | null)[]): string[] =>
    [...new Set(values.filter(Boolean) as string[])];
  const studentIds = uniqueIds(rows.map((r) => r.studentId));
  const leadIds = uniqueIds(rows.map((r) => r.leadId));
  const sessionIds = uniqueIds(rows.map((r) => r.sessionId));

  const [students, leads, sessions] = await Promise.all([
    studentIds.length
      ? db.student.findMany({
          where: { id: { in: studentIds } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            // The report dispatcher dials the first parent profile that has a
            // phone; surfacing the same number here is what lets the gateway's
            // "not-parent-number" anomaly check compare like with like.
            parentAccount: { select: { profiles: { select: { phone: true } } } },
          },
        })
      : [],
    leadIds.length
      ? db.lead.findMany({
          where: { id: { in: leadIds } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            studentFirstName: true,
            studentLastName: true,
            phone: true,
          },
        })
      : [],
    sessionIds.length
      ? db.session.findMany({
          where: { id: { in: sessionIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);

  const studentById = new Map(students.map((s) => [s.id, s]));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  const joinName = (
    first: string | null | undefined,
    last: string | null | undefined
  ): string | null => {
    const full = [first, last].filter(Boolean).join(' ').trim();
    return full || null;
  };

  return {
    studentName(row: { studentId: string | null; leadId: string | null }): string | null {
      if (row.studentId) {
        const student = studentById.get(row.studentId);
        return student ? joinName(student.firstName, student.lastName) : null;
      }
      if (row.leadId) {
        const lead = leadById.get(row.leadId);
        if (!lead) return null;
        // Older leads carry one name for parent and child, with no way to tell
        // which — fall back to it rather than show a blank on a real demo.
        return joinName(lead.studentFirstName, lead.studentLastName) ?? joinName(lead.firstName, lead.lastName);
      }
      return null;
    },
    sessionTitle(row: { sessionId: string | null }): string | null {
      return row.sessionId ? sessionById.get(row.sessionId)?.title ?? null : null;
    },
    parentPhone(row: {
      studentId: string | null;
      leadId: string | null;
      classType: string;
    }): string | null {
      // A demo's family exists only as a Lead — there is no parent account yet.
      if (row.classType === 'DEMO' || row.leadId) {
        return row.leadId ? leadById.get(row.leadId)?.phone ?? null : null;
      }
      if (!row.studentId) return null;
      const student = studentById.get(row.studentId);
      const withPhone = student?.parentAccount.profiles.find((p) => p.phone);
      return withPhone?.phone ?? null;
    },
  };
};

/** GET /metrics/pipeline — the post-class pipeline and platform vitals. */
export async function getPipelineMetrics(daysRaw?: unknown, refresh = false) {
  const days = clampDays(daysRaw);
  const hit = cache.get(days);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);
  // Calendar boundaries are server-local on purpose: the ops team and the
  // server both live on IST, and "this month" must match what they'd count.
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

  // The pipeline funnel is anchored on completedAt — the moment the mentor
  // signed the class off — because that is what starts the recording hunt,
  // never startTime (the booked slot) or updatedAt (moves on every write).
  const completedInWindow = { status: 'COMPLETED', completedAt: { gte: since } };

  /* ── Every ScheduledClass count, in one pass ──────────────────────────── */
  // The funnel is anchored on completedAt; the classes.* section on startTime
  // (what was booked into the window); upcoming and the pending-review count
  // are deliberately un-windowed. All three anchors coexist here as FILTERs.
  const [classCounts] = await db.$queryRaw<ClassCountsRow[]>`
    SELECT
      COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "completedAt" >= ${since}) AS funnel_completed,
      COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "completedAt" >= ${since} AND "transcriptionStatus" = 'COMPLETED') AS funnel_transcribed,
      COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "completedAt" >= ${since} AND "classSummary" IS NOT NULL) AS funnel_summarised,
      COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "completedAt" >= ${since} AND "reportSentAt" IS NOT NULL) AS funnel_sent,
      COUNT(*) FILTER (WHERE "startTime" BETWEEN ${since} AND ${now} AND "status" = 'COMPLETED') AS status_completed,
      COUNT(*) FILTER (WHERE "startTime" BETWEEN ${since} AND ${now} AND "status" = 'CANCELLED') AS status_cancelled,
      COUNT(*) FILTER (WHERE "startTime" BETWEEN ${since} AND ${now} AND "status" = 'RESCHEDULE_REQUESTED') AS status_reschedule,
      COUNT(*) FILTER (WHERE "startTime" BETWEEN ${since} AND ${now}) AS status_any,
      COUNT(*) FILTER (WHERE "status" = 'SCHEDULED' AND "startTime" > ${now}) AS upcoming,
      COUNT(*) FILTER (WHERE "classType" = 'DEMO' AND "startTime" BETWEEN ${since} AND ${now}) AS demo_total,
      COUNT(*) FILTER (WHERE "classType" = 'DEMO' AND "startTime" BETWEEN ${since} AND ${now} AND "status" = 'COMPLETED') AS demo_completed,
      COUNT(*) FILTER (WHERE "quizLaunchedAt" >= ${since}) AS quiz_launched,
      COUNT(*) FILTER (WHERE "reflectionSubmittedAt" >= ${since}) AS quiz_submitted,
      COUNT(*) FILTER (WHERE "reflectionSubmittedAt" IS NOT NULL AND "reflectionReviewedAt" IS NULL) AS quiz_pending_review,
      COUNT(*) FILTER (WHERE "reportSentAt" >= ${monthStart}) AS reports_sent_this_month,
      COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "completedAt" >= ${since} AND "classSummary" IS NOT NULL AND "reportAttempts" = 0) AS attempts_0,
      COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "completedAt" >= ${since} AND "classSummary" IS NOT NULL AND "reportAttempts" = 1) AS attempts_1,
      COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "completedAt" >= ${since} AND "classSummary" IS NOT NULL AND "reportAttempts" = 2) AS attempts_2,
      COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "completedAt" >= ${since} AND "classSummary" IS NOT NULL AND "reportAttempts" >= 3) AS attempts_3plus
    FROM "auth"."ScheduledClass"`;

  const funnelCompleted = n(classCounts?.funnel_completed);
  const funnelTranscribed = n(classCounts?.funnel_transcribed);
  const funnelSummarised = n(classCounts?.funnel_summarised);
  const funnelSent = n(classCounts?.funnel_sent);

  /* ── End-to-end timing: completedAt → reportSentAt ───────────────────── */
  // Timestamps only, per the median rule: the take is a safety guard, not a
  // page — 5000 completed classes in a week is far beyond current volume.
  const sentPairs = await db.scheduledClass.findMany({
    where: { completedAt: { gte: since }, reportSentAt: { not: null } },
    select: { id: true, completedAt: true, reportSentAt: true },
    take: 5000,
  });
  const timingPairs: { id: string; completedAt: Date; minutes: number }[] = [];
  for (const row of sentPairs) {
    // The where guarantees both stamps; the checks are for the nullable types.
    if (!row.completedAt || !row.reportSentAt) continue;
    timingPairs.push({
      id: row.id,
      completedAt: row.completedAt,
      minutes: (row.reportSentAt.getTime() - row.completedAt.getTime()) / 60000,
    });
  }
  const slowestPairs = [...timingPairs].sort((a, b) => b.minutes - a.minutes).slice(0, 5);

  /* ── Stuck reports, attempts, failure kinds ───────────────────────────── */
  const [slowestDetails, stuckRows, failureRows] = await Promise.all([
    slowestPairs.length
      ? db.scheduledClass.findMany({
          where: { id: { in: slowestPairs.map((p) => p.id) } },
          select: { id: true, studentId: true, leadId: true, sessionId: true, classType: true },
        })
      : [],
    // Summary exists but nothing was ever accepted by Meta — these are the
    // rows waiting on a manual dispatch, newest first so the freshest failure
    // is what the admin sees first.
    db.scheduledClass.findMany({
      where: {
        ...completedInWindow,
        classSummary: { not: null },
        reportSentAt: null,
      },
      orderBy: { completedAt: 'desc' },
      take: 15,
      select: {
        id: true,
        studentId: true,
        leadId: true,
        sessionId: true,
        classType: true,
        completedAt: true,
        reportAttempts: true,
        reportLastError: true,
      },
    }),
    db.scheduledClass.findMany({
      where: { completedAt: { gte: since }, reportLastError: { not: null } },
      select: { reportLastError: true },
      take: 5000,
    }),
  ]);

  const refs = await loadClassRefContext([...slowestDetails, ...stuckRows]);
  const slowestDetailById = new Map(slowestDetails.map((d) => [d.id, d]));

  const attemptsHistogram: Record<string, number> = {
    '0': n(classCounts?.attempts_0),
    '1': n(classCounts?.attempts_1),
    '2': n(classCounts?.attempts_2),
    '3+': n(classCounts?.attempts_3plus),
  };

  const kindCounts = new Map<string, number>();
  for (const row of failureRows) {
    if (!row.reportLastError) continue;
    const kind = failureKindOf(row.reportLastError);
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const topFailureKinds = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  /* ── Classes: what was meant to run in the window ─────────────────────── */
  // This section is startTime-anchored (what was *booked* into the window),
  // which is deliberately not the funnel's completedAt anchor.
  const startedInWindow = { gte: since, lte: now };
  // The counts all came from the single pass above; what is left genuinely
  // needs rows (durations, teaching hours, quiz scores) or a grouping.
  const [completedClassRows, scoreRows, badgeGroups, enrolledLeadsInWindow] = await Promise.all([
    db.scheduledClass.findMany({
      where: { status: 'COMPLETED', startTime: startedInWindow },
      select: { startTime: true, endTime: true, actualEndedAt: true, mentorId: true, programId: true },
      take: 5000,
    }),
    db.scheduledClass.findMany({
      where: {
        reflectionSubmittedAt: { gte: since },
        reflectionScore: { not: null },
        reflectionMaxScore: { gt: 0 },
      },
      select: { reflectionScore: true, reflectionMaxScore: true },
      take: 5000,
    }),
    db.scheduledClass.groupBy({
      by: ['reflectionBadge'],
      where: { reflectionSubmittedAt: { gte: since }, reflectionBadge: { not: null } },
      _count: { _all: true },
    }),
    // Demo → enrolment conversion signal: ENROLLED is a terminal status, so
    // updatedAt is when the lead reached it (or was last touched there).
    db.lead.count({ where: { status: 'ENROLLED', updatedAt: { gte: since } } }),
  ]);

  const upcoming = n(classCounts?.upcoming);
  const demoTotal = n(classCounts?.demo_total);
  const demoCompleted = n(classCounts?.demo_completed);
  const quizLaunched = n(classCounts?.quiz_launched);
  const quizSubmitted = n(classCounts?.quiz_submitted);

  const scheduledInWindow = n(classCounts?.status_any);
  const completedCls = n(classCounts?.status_completed);
  const cancelledCls = n(classCounts?.status_cancelled);
  const completionDenominator = completedCls + cancelledCls;

  /* Durations + teaching hours, from the one completed-in-window fetch. */
  const bookedMins: number[] = [];
  const actualMins: number[] = [];
  const gapMins: number[] = [];
  const mentorMinutes = new Map<string, number>();
  const programMinutes = new Map<string | null, number>();
  for (const row of completedClassRows) {
    const booked = (row.endTime.getTime() - row.startTime.getTime()) / 60000;
    bookedMins.push(booked);
    if (row.mentorId) {
      mentorMinutes.set(row.mentorId, (mentorMinutes.get(row.mentorId) ?? 0) + booked);
    }
    programMinutes.set(row.programId, (programMinutes.get(row.programId) ?? 0) + booked);
    if (row.actualEndedAt) {
      const actual = (row.actualEndedAt.getTime() - row.startTime.getTime()) / 60000;
      // Presence stamps from a shared Meet room can land on the wrong class
      // (see markRoomEnded), so a non-positive or >8h "actual" is discarded
      // rather than allowed to poison the average.
      if (actual > 0 && actual < 8 * 60) {
        actualMins.push(actual);
        // The gap is only honest where BOTH ends are computable.
        gapMins.push(actual - booked);
      }
    }
  }

  const topMentorEntries = [...mentorMinutes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const programIds = [...programMinutes.keys()].filter((id): id is string => Boolean(id));
  const [mentorUsers, programs] = await Promise.all([
    topMentorEntries.length
      ? db.user.findMany({
          where: { id: { in: topMentorEntries.map(([id]) => id) } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : [],
    programIds.length
      ? db.program.findMany({ where: { id: { in: programIds } }, select: { id: true, title: true } })
      : [],
  ]);
  const mentorById = new Map(mentorUsers.map((u) => [u.id, u]));
  const programTitleById = new Map(programs.map((p) => [p.id, p.title]));

  const topMentors = topMentorEntries.map(([id, minutes]) => {
    const mentor = mentorById.get(id);
    return {
      name: mentor
        ? `${mentor.firstName || ''} ${mentor.lastName || ''}`.trim() || mentor.email
        : 'Unknown mentor',
      hours: round1(minutes / 60),
    };
  });

  // Keyed by title so a null programId and a deleted programme's dangling id
  // fold into one honest "No programme" line instead of two.
  const hoursByTitle = new Map<string, number>();
  for (const [id, minutes] of programMinutes) {
    const title = (id && programTitleById.get(id)) || 'No programme';
    hoursByTitle.set(title, (hoursByTitle.get(title) ?? 0) + minutes);
  }
  const byProgram = [...hoursByTitle.entries()]
    .map(([title, minutes]) => ({ title, hours: round1(minutes / 60) }))
    .sort((a, b) => b.hours - a.hours);

  const scoreRatios: number[] = [];
  for (const row of scoreRows) {
    if (row.reflectionScore === null || !row.reflectionMaxScore) continue;
    scoreRatios.push((row.reflectionScore / row.reflectionMaxScore) * 100);
  }
  const badges: Record<string, number> = { GOLD: 0, SILVER: 0, BRONZE: 0 };
  for (const g of badgeGroups) {
    if (g.reflectionBadge) badges[g.reflectionBadge] = g._count._all;
  }

  /* ── Platform vitals: people, leads, engagement ───────────────────────── */
  // Thirteen headcounts across five tables as scalar subqueries — one round
  // trip instead of thirteen. Mentors are matched by role name (the same
  // TEACHER/INSTRUCTOR pair isMentorRole uses); staff is deliberately
  // NOT-a-mentor, so a role added later still lands somewhere.
  const mentorRoles = MENTOR_ROLE_NAMES;
  const [peopleCounts] = await db.$queryRaw<PeopleCountsRow[]>`
    SELECT
      (SELECT COUNT(*) FROM "auth"."Student" WHERE "isActive" = true) AS students_active,
      (SELECT COUNT(*) FROM "auth"."Student" WHERE "createdAt" >= ${monthStart}) AS students_new,
      (SELECT COUNT(*) FROM "auth"."ParentAccount" WHERE "isActive" = true) AS parents_active,
      (SELECT COUNT(*) FROM "auth"."ParentAccount" WHERE "createdAt" >= ${monthStart}) AS parents_new,
      (SELECT COUNT(*) FROM "auth"."User" u WHERE u."isActive" = true
         AND EXISTS (SELECT 1 FROM "auth"."Role" r WHERE r."id" = u."roleId" AND r."name" = ANY(${mentorRoles}))) AS mentors_active,
      (SELECT COUNT(*) FROM "auth"."User" u WHERE u."createdAt" >= ${monthStart}
         AND EXISTS (SELECT 1 FROM "auth"."Role" r WHERE r."id" = u."roleId" AND r."name" = ANY(${mentorRoles}))) AS mentors_new,
      (SELECT COUNT(*) FROM "auth"."User" u WHERE u."isActive" = true
         AND NOT EXISTS (SELECT 1 FROM "auth"."Role" r WHERE r."id" = u."roleId" AND r."name" = ANY(${mentorRoles}))) AS staff_active,
      (SELECT COUNT(*) FROM "auth"."User" u WHERE u."createdAt" >= ${monthStart}
         AND NOT EXISTS (SELECT 1 FROM "auth"."Role" r WHERE r."id" = u."roleId" AND r."name" = ANY(${mentorRoles}))) AS staff_new,
      (SELECT COUNT(*) FROM "learning"."Lead") AS leads_total,
      (SELECT COUNT(*) FROM "learning"."Lead" WHERE "createdAt" >= ${monthStart}) AS leads_new,
      (SELECT COUNT(*) FROM "learning"."Lead" WHERE "paymentVerifiedAt" IS NOT NULL) AS leads_payment_verified,
      (SELECT COUNT(*) FROM "auth"."ClassDoubt" WHERE "status" = 'OPEN') AS doubts_open,
      (SELECT COUNT(*) FROM "auth"."ClassDoubt" WHERE "status" = 'ANSWERED') AS doubts_answered`;

  const [leadStatusGroups, loginsTodayGroups, loginsWeekGroups] = await Promise.all([
    db.lead.groupBy({ by: ['status'], _count: { _all: true } }),
    db.auditLog.groupBy({
      by: ['actorRole'],
      where: { entityType: 'login', occurredAt: { gte: todayStart } },
      _count: { _all: true },
    }),
    db.auditLog.groupBy({
      by: ['actorRole'],
      where: { entityType: 'login', occurredAt: { gte: weekAgo } },
      _count: { _all: true },
    }),
  ]);

  const studentsActive = n(peopleCounts?.students_active);
  const studentsNew = n(peopleCounts?.students_new);
  const parentsActive = n(peopleCounts?.parents_active);
  const parentsNew = n(peopleCounts?.parents_new);
  const mentorsActive = n(peopleCounts?.mentors_active);
  const mentorsNew = n(peopleCounts?.mentors_new);
  const staffActive = n(peopleCounts?.staff_active);
  const staffNew = n(peopleCounts?.staff_new);
  const leadsTotal = n(peopleCounts?.leads_total);
  const leadsNew = n(peopleCounts?.leads_new);
  const leadsPaymentVerified = n(peopleCounts?.leads_payment_verified);
  const doubtsOpen = n(peopleCounts?.doubts_open);
  const doubtsAnswered = n(peopleCounts?.doubts_answered);
  // All-time on purpose: a quiz waiting for the mentor's sign-off is owed to
  // the family however long ago it was submitted.
  const quizzesPendingReview = n(classCounts?.quiz_pending_review);
  const reportsSentThisMonth = n(classCounts?.reports_sent_this_month);

  const leadsByStatus: Record<string, number> = {};
  for (const g of leadStatusGroups) {
    leadsByStatus[g.status] = g._count._all;
  }

  const payload = {
    windowDays: days,
    funnel: {
      completed: funnelCompleted,
      transcribed: funnelTranscribed,
      summarised: funnelSummarised,
      sent: funnelSent,
    },
    timings: {
      endToEnd: {
        avgMinutes: round1OrNull(avgOrNull(timingPairs.map((p) => p.minutes))),
        medianMinutes: round1OrNull(medianOrNull(timingPairs.map((p) => p.minutes))),
        count: timingPairs.length,
        slowest: slowestPairs.map((p) => {
          const detail = slowestDetailById.get(p.id);
          return {
            classId: p.id,
            studentName: detail ? refs.studentName(detail) : null,
            sessionTitle: detail ? refs.sessionTitle(detail) : null,
            minutes: round1(p.minutes),
            completedAt: p.completedAt.toISOString(),
          };
        }),
      },
    },
    reports: {
      sent: funnelSent,
      stuck: stuckRows.map((row) => ({
        classId: row.id,
        studentName: refs.studentName(row),
        sessionTitle: refs.sessionTitle(row),
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        ageHours: row.completedAt
          ? round1((now.getTime() - row.completedAt.getTime()) / 3600000)
          : null,
        attempts: row.reportAttempts,
        lastError: row.reportLastError,
      })),
      attemptsHistogram,
      topFailureKinds,
    },
    classes: {
      scheduled: scheduledInWindow,
      completed: completedCls,
      cancelled: cancelledCls,
      rescheduleRequested: n(classCounts?.status_reschedule),
      upcoming,
      completionRatePercent:
        completionDenominator > 0 ? Math.round((completedCls / completionDenominator) * 100) : null,
      demo: {
        total: demoTotal,
        completed: demoCompleted,
        enrolledLeadsInWindow,
      },
      durations: {
        bookedAvgMin: round1OrNull(avgOrNull(bookedMins)),
        actualAvgMin: round1OrNull(avgOrNull(actualMins)),
        gapAvgMin: round1OrNull(avgOrNull(gapMins)),
      },
      teachingHours: {
        // A window with no completed classes genuinely taught zero hours —
        // that is a measured 0, unlike the averages above.
        totalHours: round1(bookedMins.reduce((a, b) => a + b, 0) / 60),
        topMentors,
        byProgram,
      },
      quiz: {
        launched: quizLaunched,
        submitted: quizSubmitted,
        avgScorePercent: scoreRatios.length
          ? Math.round(scoreRatios.reduce((a, b) => a + b, 0) / scoreRatios.length)
          : null,
        badges,
      },
    },
    platform: {
      people: {
        students: { active: studentsActive, newThisMonth: studentsNew },
        parents: { active: parentsActive, newThisMonth: parentsNew },
        mentors: { active: mentorsActive, newThisMonth: mentorsNew },
        staff: { active: staffActive, newThisMonth: staffNew },
      },
      leads: {
        total: leadsTotal,
        newThisMonth: leadsNew,
        byStatus: leadsByStatus,
        paymentVerified: leadsPaymentVerified,
      },
      engagement: {
        loginsToday: toRoleCounts(loginsTodayGroups),
        loginsThisWeek: toRoleCounts(loginsWeekGroups),
        doubts: { open: doubtsOpen, answered: doubtsAnswered },
        quizzes: { submittedInWindow: quizSubmitted, pendingReview: quizzesPendingReview },
      },
      reportsSentThisMonth,
    },
  };

  cache.set(days, { at: Date.now(), data: payload });
  return payload;
}

/**
 * GET /metrics/class-refs — resolves bare class ids into the names and report
 * state the gateway needs to enrich WhatsApp sends. Missing ids are simply
 * absent from the result; the caller treats absence as "unknown class".
 */
export async function getClassRefs(idsRaw?: unknown) {
  // Silently truncate at 60: the gateway caps its own batch at the same
  // number, so anything longer is a caller bug, not a bigger dashboard.
  const ids = [
    ...new Set(
      String(idsRaw ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ].slice(0, 60);
  if (ids.length === 0) return [];

  const rows = await db.scheduledClass.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      startTime: true,
      classType: true,
      studentId: true,
      leadId: true,
      sessionId: true,
      reportSentAt: true,
      reportSentTo: true,
      reportAttempts: true,
      reportLastError: true,
    },
  });
  const refs = await loadClassRefContext(rows);

  return rows.map((row) => ({
    id: row.id,
    studentName: refs.studentName(row),
    sessionTitle: refs.sessionTitle(row),
    classDate: row.startTime.toISOString(),
    parentPhone: refs.parentPhone(row),
    reportSentAt: row.reportSentAt ? row.reportSentAt.toISOString() : null,
    reportSentTo: row.reportSentTo,
    reportAttempts: row.reportAttempts,
    reportLastError: row.reportLastError,
  }));
}
