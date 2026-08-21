import { db, withDbRetry } from '../../database/datasource';
import { logger } from '@futurespark/logger';

/** Same shape every service emits — see auth-service/modules/metrics/feed.service.ts. */
export interface FeedEvent {
  type: 'video' | 'audio';
  at: string;
  title: string;
  subtitle?: string | null;
  status?: 'ok' | 'warn' | 'fail' | 'info';
  detail?: string | null;
}

const minutesBetween = (from: Date | null | undefined, to: Date | null | undefined): number | null => {
  if (!from || !to) return null;
  const m = (to.getTime() - from.getTime()) / 60_000;
  return m >= 0 && m < 48 * 60 ? Math.round(m) : null;
};

export const getIntegrationFeed = async (since: Date | null, limit: number): Promise<FeedEvent[]> => {
  const window = since ? { gte: since } : undefined;
  const events: FeedEvent[] = [];

  const [videosResult, audiosResult] = await Promise.allSettled([
    // VIDEO — the recording appearing is the event.
    withDbRetry(() =>
      db.meetingRecording.findMany({
        where: window ? { createdAt: window } : {},
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          createdAt: true, duration: true, downloadStatus: true,
          meeting: { select: { title: true, provider: true, classCompletedAt: true } },
        },
      })
    ),
    // AUDIO — extraction finishing is a separate event, and it is the one that
    // unblocks transcription.
    withDbRetry(() =>
      db.meetingRecording.findMany({
        where: { audioExtractedAt: since ? window : { not: null } },
        orderBy: { audioExtractedAt: 'desc' },
        take: limit,
        select: {
          createdAt: true, audioExtractedAt: true, transcriptionStatus: true,
          meeting: { select: { title: true } },
        },
      })
    ),
  ]);

  /* A query that failed yields no events of ITS kind and says why in the log
   * — rather than emptying the other kind with it. Promise.all would fail the
   * whole call, so an environment whose audioExtractedAt migration has not
   * been applied lost its VIDEO events too: two blank cards for one missing
   * column, and no clue which. */
  const videos = videosResult.status === 'fulfilled' ? videosResult.value : [];
  const audios = audiosResult.status === 'fulfilled' ? audiosResult.value : [];

  if (videosResult.status === 'rejected') {
    logger.error(
      `[Feed] Video events unavailable: ${videosResult.reason?.message ?? videosResult.reason}`
    );
  }
  if (audiosResult.status === 'rejected') {
    logger.error(
      `[Feed] Audio events unavailable: ${audiosResult.reason?.message ?? audiosResult.reason}. ` +
        'If this names audioExtractedAt, this database has not had prisma db push run since that column was added.'
    );
  }

  for (const v of videos) {
    const lag = minutesBetween(v.meeting?.classCompletedAt, v.createdAt);
    events.push({
      type: 'video',
      at: v.createdAt.toISOString(),
      title: v.meeting?.title ?? 'Recording',
      subtitle: [
        v.meeting?.provider === 'ZOOM' ? 'Zoom' : 'Google Meet',
        v.duration ? `${Math.round(v.duration / 60)} min` : null,
        lag !== null ? `+${lag} min after class` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      status: v.downloadStatus === 'COMPLETED' ? 'ok' : v.downloadStatus === 'FAILED' ? 'fail' : 'warn',
      detail: v.downloadStatus === 'COMPLETED' ? null : v.downloadStatus,
    });
  }

  for (const a of audios) {
    if (!a.audioExtractedAt) continue;
    const lag = minutesBetween(a.createdAt, a.audioExtractedAt);
    events.push({
      type: 'audio',
      at: a.audioExtractedAt.toISOString(),
      title: a.meeting?.title ?? 'Audio track',
      subtitle: [
        'extracted and verified',
        lag !== null ? `+${lag} min after video` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      status: a.transcriptionStatus === 'FAILED' ? 'fail' : a.transcriptionStatus === 'COMPLETED' ? 'ok' : 'info',
      detail: a.transcriptionStatus === 'COMPLETED' ? 'transcribed' : a.transcriptionStatus?.toLowerCase() ?? null,
    });
  }

  return events;
};
