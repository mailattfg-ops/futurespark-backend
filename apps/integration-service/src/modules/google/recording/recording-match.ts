/**
 * Matching a Drive recording to the meeting it belongs to.
 *
 * The old approach searched Drive for `name contains <title> OR name contains
 * <meetCode>` within ±24 hours of the meeting and took the newest video. Two
 * classes for the same student and program share a title, so a 09:42 recording
 * would happily attach itself to the 12:10 session. Same-day collisions were
 * guaranteed, not unlucky.
 *
 * Google Meet names its recordings with the meeting's own start time:
 *
 *   "finance test Session with shihad new - 2026/08/06 09:42 IST - Recording"
 *   "iwo-jdzf-gzy (2026-08-05 16:01 GMT+5:30)"          ← ad-hoc, no calendar event
 *
 * That timestamp is the decisive signal. We parse it and require it to line up
 * with the scheduled start; a mismatch is a hard reject no matter how well the
 * title matches. When nothing lines up we attach nothing and stay PENDING,
 * because a missing recording is recoverable and a wrong one is not.
 */

export interface DriveCandidate {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdTime: string;
}

export interface MatchTarget {
  meetCode: string | null;
  title: string;
  startTime: Date | string;
  endTime?: Date | string | null;
  /** IANA zone the calendar event was created in — the zone Meet names files in. */
  timezone?: string | null;
}

export interface MatchResult {
  file: DriveCandidate | null;
  score: number;
  reasons: string[];
  rejected: Array<{ name: string; reason: string }>;
}

/** Wall-clock fields pulled out of a recording filename. */
interface NameStamp {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** Minutes east of UTC when the name carries an explicit GMT±HH:MM. */
  utcOffsetMinutes: number | null;
}

// "2026/08/06 09:42 IST"  ·  "2026-08-06 09:42"
const SLASH_OR_DASH_DATE = /(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})/;
// "GMT+5:30" · "GMT-04:00" · "GMT+9"
const GMT_OFFSET = /GMT([+-])(\d{1,2})(?::(\d{2}))?/;

export function parseRecordingStamp(fileName: string): NameStamp | null {
  const m = SLASH_OR_DASH_DATE.exec(fileName);
  if (!m) return null;

  let utcOffsetMinutes: number | null = null;
  const off = GMT_OFFSET.exec(fileName);
  if (off) {
    const sign = off[1] === '+' ? 1 : -1;
    utcOffsetMinutes = sign * (parseInt(off[2], 10) * 60 + parseInt(off[3] || '0', 10));
  }

  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    utcOffsetMinutes,
  };
}

/** The meeting's start expressed as wall-clock fields in a given IANA zone. */
function wallClockInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
  };
}

/**
 * Absolute minutes between the timestamp in the filename and the meeting start.
 * Returns null when the name carries no timestamp.
 */
export function stampDriftMinutes(fileName: string, target: MatchTarget): number | null {
  const stamp = parseRecordingStamp(fileName);
  if (!stamp) return null;

  const start = new Date(target.startTime);
  if (Number.isNaN(start.getTime())) return null;

  // Explicit offset in the name → compare absolute instants.
  if (stamp.utcOffsetMinutes !== null) {
    const asUtc = Date.UTC(stamp.year, stamp.month - 1, stamp.day, stamp.hour, stamp.minute);
    const instant = asUtc - stamp.utcOffsetMinutes * 60_000;
    return Math.abs(instant - start.getTime()) / 60_000;
  }

  // Only a zone abbreviation (e.g. "IST") — compare wall-clock in the meeting's
  // own zone, which is the zone Meet rendered the name in.
  const zone = target.timezone || 'Asia/Kolkata';
  let local;
  try {
    local = wallClockInZone(start, zone);
  } catch {
    local = wallClockInZone(start, 'Asia/Kolkata');
  }

  const a = Date.UTC(stamp.year, stamp.month - 1, stamp.day, stamp.hour, stamp.minute);
  const b = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return Math.abs(a - b) / 60_000;
}

// A recording whose embedded start time is more than this far from the scheduled
// start belongs to a different session. Covers a mentor starting a few minutes
// early or late without letting a neighbouring slot through.
export const MAX_STAMP_DRIFT_MIN = 20;
// Recordings are written after the call, never before it begins. Small allowance
// for clock skew between Google and us.
export const MAX_CREATED_BEFORE_START_MIN = 10;

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Pick the Drive file that genuinely belongs to this meeting, or nothing.
 */
export function pickBestRecording(files: DriveCandidate[], target: MatchTarget): MatchResult {
  const rejected: Array<{ name: string; reason: string }> = [];
  const start = new Date(target.startTime).getTime();
  const code = target.meetCode ? target.meetCode.toLowerCase() : null;
  const codeNoHyphen = code ? code.replace(/-/g, '') : null;
  const titleWords = normalise(target.title || '')
    .split(' ')
    .filter((w) => w.length > 3);

  let best: { file: DriveCandidate; score: number; reasons: string[] } | null = null;

  for (const f of files) {
    const reasons: string[] = [];
    let score = 0;

    if (!f.mimeType?.startsWith('video/')) {
      rejected.push({ name: f.name, reason: 'not a video file' });
      continue;
    }

    const lower = f.name.toLowerCase();
    const hasCode = Boolean(
      code && (lower.includes(code) || (codeNoHyphen && lower.includes(codeNoHyphen)))
    );

    // Hard gate: an embedded start time that disagrees means a different session.
    const drift = stampDriftMinutes(f.name, target);
    if (drift !== null && drift > MAX_STAMP_DRIFT_MIN) {
      rejected.push({
        name: f.name,
        reason: `filename start time is ${Math.round(drift)} min from the scheduled start (max ${MAX_STAMP_DRIFT_MIN})`,
      });
      continue;
    }

    // Hard gate: a file created before the meeting began cannot be its recording.
    const created = new Date(f.createdTime).getTime();
    if (Number.isFinite(created) && Number.isFinite(start)) {
      const beforeStartMin = (start - created) / 60_000;
      if (beforeStartMin > MAX_CREATED_BEFORE_START_MIN) {
        rejected.push({
          name: f.name,
          reason: `created ${Math.round(beforeStartMin)} min before the meeting started`,
        });
        continue;
      }
    }

    if (hasCode) {
      score += 100;
      reasons.push('meet code in filename');
    }
    if (drift !== null) {
      if (drift <= 2) {
        score += 80;
        reasons.push('start time matches exactly');
      } else if (drift <= 10) {
        score += 50;
        reasons.push(`start time within ${Math.round(drift)} min`);
      } else {
        score += 20;
        reasons.push(`start time within ${Math.round(drift)} min`);
      }
    }
    if (titleWords.length) {
      const nameWords = normalise(f.name);
      const hits = titleWords.filter((w) => nameWords.includes(w)).length;
      if (hits) {
        // Deliberately weak: titles repeat across every session of a program.
        score += Math.min(15, hits * 5);
        reasons.push(`${hits} title word(s) matched`);
      }
    }

    // Nothing but a title match is not enough to attach a recording.
    if (!hasCode && drift === null) {
      rejected.push({ name: f.name, reason: 'no meet code and no parsable start time — title alone is not sufficient' });
      continue;
    }

    if (!best || score > best.score) best = { file: f, score, reasons };
  }

  return best
    ? { file: best.file, score: best.score, reasons: best.reasons, rejected }
    : { file: null, score: 0, reasons: [], rejected };
}
