import db from '../../database/datasource';

/**
 * System Health feed over the AI pipeline: what the window cost, what it
 * produced, and how often it failed. The gateway dashboard polls this, so
 * everything is an aggregate (groupBy/count/aggregate) — the usage ledger can
 * grow without this endpoint growing with it. The one row fetch (error
 * timestamps for the hour histogram) is select-limited and take-guarded.
 *
 * Convention: a value that could not be computed (no rows) is null, never a
 * fabricated 0 — a real 0 must mean "measured and it was zero".
 */

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Answers are held for a minute.
 *
 * The database URL pins connection_limit=1, so these queries queue rather than
 * overlap and each is a round trip to a hosted Postgres — the dashboard polling
 * every 60s should not pay that twice.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<number, { at: number; data: any }>();

export const getAiMetrics = async (daysRaw?: unknown, refresh = false) => {
  // Only two window sizes exist; anything else silently becomes the default
  // so a typo'd query string can never trigger an unbounded scan.
  const windowDays = Number(daysRaw) === 30 ? 30 : 7;
  const hit = cache.get(windowDays);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const now = new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  // Month figures are calendar months (server time), NOT the days window.
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [byStage, byModel, classes, unattributed, thisMonth, lastMonth, errorCount, errorsByKind, errorTimes] =
    await Promise.all([
      // One pass over the window covers spend, calls, tokens, audio and
      // processing time per stage.
      db.aiUsage.groupBy({
        by: ['stage'],
        where: { createdAt: { gte: since } },
        _sum: { costUsd: true, audioSeconds: true, inputTokens: true, outputTokens: true },
        _count: { _all: true },
        _avg: { processingMs: true },
      }),
      db.aiUsage.groupBy({
        by: ['model', 'stage'],
        where: { createdAt: { gte: since } },
        _sum: { costUsd: true },
        _count: { _all: true },
        orderBy: { _sum: { costUsd: 'desc' } },
      }),
      // "Classes analysed" mirrors getUsage in ai-admin: distinct attributed
      // classIds, plus distinct recordings that never got a class attribution
      // (one recording ≈ one class) — rows written before the pre-run
      // attribution fix have only a recordingId.
      db.aiUsage.findMany({
        where: { createdAt: { gte: since }, classId: { not: null } },
        distinct: ['classId'],
        select: { classId: true },
      }),
      db.aiUsage.findMany({
        where: { createdAt: { gte: since }, classId: null, recordingId: { not: null } },
        distinct: ['recordingId'],
        select: { recordingId: true },
      }),
      db.aiUsage.aggregate({
        where: { createdAt: { gte: monthStart } },
        _sum: { costUsd: true },
      }),
      db.aiUsage.aggregate({
        where: { createdAt: { gte: lastMonthStart, lt: monthStart } },
        _sum: { costUsd: true },
      }),
      db.errorLog.count({ where: { occurredAt: { gte: since } } }),
      db.errorLog.groupBy({
        by: ['kind'],
        where: { occurredAt: { gte: since } },
        _count: { _all: true },
      }),
      // Timestamps only, take-guarded: enough for an hour histogram without
      // ever loading unbounded rows. Newest first so a truncated window drops
      // the stalest failures.
      db.errorLog.findMany({
        where: { occurredAt: { gte: since } },
        select: { occurredAt: true },
        orderBy: { occurredAt: 'desc' },
        take: 5000,
      }),
    ]);

  const stageOf = (stage: string) => byStage.find((s) => s.stage === stage);
  const transcription = stageOf('transcription');
  const analysis = stageOf('analysis');

  const calls = byStage.reduce((sum, s) => sum + s._count._all, 0);
  const sumOver = (pick: (s: (typeof byStage)[number]) => number | null): number | null =>
    byStage.length === 0 ? null : byStage.reduce((sum, s) => sum + (pick(s) ?? 0), 0);

  const totalUsd = sumOver((s) => s._sum.costUsd);
  const inputTokens = sumOver((s) => s._sum.inputTokens);
  const outputTokens = sumOver((s) => s._sum.outputTokens);
  const audioSeconds = sumOver((s) => s._sum.audioSeconds);

  const classesAnalysed = classes.length + unattributed.length;

  const stageSpend = (s: (typeof byStage)[number] | undefined) => ({
    usd: s ? round4(s._sum.costUsd ?? 0) : null,
    calls: s ? s._count._all : 0,
  });
  const stageAvgSeconds = (s: (typeof byStage)[number] | undefined): number | null =>
    s && s._avg.processingMs !== null ? round1(s._avg.processingMs / 1000) : null;

  // Null kinds fold into OTHER, so the fold has to re-sort in JS rather than
  // trusting a groupBy orderBy.
  const kindCounts = new Map<string, number>();
  for (const row of errorsByKind) {
    const kind = row.kind ?? 'OTHER';
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + row._count._all);
  }
  const byKind = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);

  // Hour-of-day in IST: shift the instant by +5:30 and read the UTC hour, so
  // the histogram matches the operators' clock wherever the server runs.
  const failuresByHour = new Array<number>(24).fill(0);
  for (const row of errorTimes) {
    failuresByHour[new Date(row.occurredAt.getTime() + 5.5 * 3600 * 1000).getUTCHours()]++;
  }

  const payload = {
    windowDays,
    spend: {
      totalUsd: totalUsd !== null ? round4(totalUsd) : null,
      classesAnalysed,
      perClassUsd:
        totalUsd !== null && classesAnalysed > 0 ? round4(totalUsd / classesAnalysed) : null,
      byStage: {
        transcription: stageSpend(transcription),
        analysis: stageSpend(analysis),
      },
      byModel: byModel.map((row) => ({
        model: row.model ?? 'unknown',
        stage: row.stage,
        usd: round4(row._sum.costUsd ?? 0),
        calls: row._count._all,
      })),
      thisMonthUsd: thisMonth._sum.costUsd !== null ? round4(thisMonth._sum.costUsd) : null,
      lastMonthUsd: lastMonth._sum.costUsd !== null ? round4(lastMonth._sum.costUsd) : null,
    },
    tokens: { input: inputTokens, output: outputTokens },
    audioMinutes: audioSeconds !== null ? round1(audioSeconds / 60) : null,
    avgProcessing: {
      transcriptionSeconds: stageAvgSeconds(transcription),
      analysisSeconds: stageAvgSeconds(analysis),
    },
    reliability: {
      calls,
      errors: errorCount,
      failureRatePercent:
        calls + errorCount > 0 ? Math.round((errorCount / (calls + errorCount)) * 100) : null,
      byKind,
      failuresByHour,
    },
  };

  cache.set(windowDays, { at: Date.now(), data: payload });
  return payload;
};
