import crypto from 'crypto';

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
};

export const ERROR_CODES = {
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_MISSING_TOKEN: 'AUTH_MISSING_TOKEN',
  ACCESS_DENIED: 'ACCESS_DENIED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

// ── Post-class reflection ─────────────────────────────────────
// Shared because two services need the same list: learning-service serves them
// to the admin editor and student portal, and auth-service snapshots them onto
// the ScheduledClass when a student submits.

/**
 * Prompts every curriculum session starts with. A Session whose
 * `reflectionQuestions` array is empty has never been customised by an admin,
 * and readers substitute these — so no backfill migration is needed and a
 * brand-new session is answerable immediately.
 */
export const DEFAULT_REFLECTION_QUESTIONS: string[] = [
  'What is the most important thing you learned in this session?',
  'Which part did you find most challenging, and why?',
  'How could you use what you learned today outside of class?',
  'What is one question you still have for your mentor?',
  'How confident do you feel about this topic now (1-5), and what would raise it?',
];

/** How many prompts a session starts with, and how many the legacy editor renders. */
export const REFLECTION_QUESTION_COUNT = 5;

/** Upper bound on a custom quiz — enough room to build one, small enough to finish. */
export const MAX_REFLECTION_QUESTIONS = 10;

/** Upper bound on choices per multiple-choice question. */
export const MAX_REFLECTION_OPTIONS = 6;

const MAX_PROMPT_LEN = 500;
const MAX_OPTION_LEN = 200;

/** Effective prompts for a session row — its custom set if any, defaults otherwise. */
export const effectiveReflectionQuestions = (stored: string[] | null | undefined): string[] =>
  stored && stored.length > 0 ? stored : DEFAULT_REFLECTION_QUESTIONS;

// ── Reflection as a quiz ──────────────────────────────────────
// The reflection started life as five free-text prompts stored in
// `Session.reflectionQuestions` (String[]). It is now a typed quiz stored in
// `Session.reflectionQuiz` (Json). The old column is still read: a session that
// has never had a quiz built falls back to its text prompts, and a session with
// neither falls back to the platform defaults. So nothing needed backfilling and
// every session is answerable the moment it exists.

export type ReflectionQuestionType = 'TEXT' | 'MCQ' | 'IMAGE_CHOICE' | 'SCALE';

export const REFLECTION_QUESTION_TYPES: ReflectionQuestionType[] = ['TEXT', 'MCQ', 'IMAGE_CHOICE', 'SCALE'];

/** One selectable choice. `imageUrl` is what makes an IMAGE_CHOICE tile a picture. */
export interface ReflectionOption {
  id: string;
  label: string;
  imageUrl?: string | null;
}

export interface ReflectionQuestion {
  id: string;
  type: ReflectionQuestionType;
  prompt: string;
  /** Optional picture shown above the prompt — valid on every question type. */
  imageUrl?: string | null;
  /** Present for MCQ and IMAGE_CHOICE. */
  options?: ReflectionOption[];
  /**
   * Set only when the question has a right answer. Leaving it null turns the
   * question into an opinion poll: any choice scores full points.
   */
  correctOptionId?: string | null;
  points: number;
}

/** One answered question, snapshotted at submit time. */
export interface ReflectionAnswerEntry {
  questionId: string;
  question: string;
  type: ReflectionQuestionType;
  /** Free text for TEXT, the chosen option's label for the rest. */
  answer: string;
  selectedOptionId?: string | null;
  /** true/false for graded questions, null when there is no right answer. */
  correct: boolean | null;
  pointsEarned: number;
  pointsPossible: number;
}

export interface ReflectionBadge {
  id: 'GOLD' | 'SILVER' | 'BRONZE';
  label: string;
  emoji: string;
  /** Lowest score percentage that still earns this badge. */
  minPercent: number;
  blurb: string;
}

/** Ordered best-first, so the first tier a score clears is the one awarded. */
export const REFLECTION_BADGES: ReflectionBadge[] = [
  { id: 'GOLD', label: 'Gold Medal', emoji: '🥇', minPercent: 100, blurb: 'Perfect run — every answer on point.' },
  { id: 'SILVER', label: 'Silver Medal', emoji: '🥈', minPercent: 70, blurb: 'Strong work — nearly everything right.' },
  { id: 'BRONZE', label: 'Bronze Medal', emoji: '🥉', minPercent: 1, blurb: 'Quiz complete — keep the streak going.' },
];

export const DEFAULT_REFLECTION_POINTS = 10;

export const badgeForScore = (score: number, maxScore: number): ReflectionBadge | null => {
  if (maxScore <= 0 || score <= 0) return null;
  const percent = (score / maxScore) * 100;
  return REFLECTION_BADGES.find((b) => percent >= b.minPercent) ?? null;
};

/** Stable-ish id for questions and options built outside a request context. */
const makeId = (prefix: string): string => {
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
};

/** Wraps plain prompt strings as free-text quiz questions. */
export const questionsToQuiz = (questions: string[]): ReflectionQuestion[] =>
  questions.map((prompt, i) => ({
    id: `q${i + 1}`,
    type: 'TEXT' as const,
    prompt,
    imageUrl: null,
    points: DEFAULT_REFLECTION_POINTS,
  }));

/** The quiz every session starts with, until an admin builds its own. */
export const defaultReflectionQuiz = (): ReflectionQuestion[] => questionsToQuiz(DEFAULT_REFLECTION_QUESTIONS);

/**
 * The quiz a student actually answers, resolved in priority order:
 * custom quiz → the session's legacy text prompts → the platform defaults.
 */
export const effectiveReflectionQuiz = (
  quiz: unknown,
  legacyQuestions?: string[] | null
): ReflectionQuestion[] => {
  if (Array.isArray(quiz) && quiz.length > 0) {
    try {
      const parsed = normalizeReflectionQuiz(quiz);
      if (parsed.length > 0) return parsed;
    } catch {
      // A malformed stored quiz must not lock a student out of their
      // reflection — fall through to the text prompts instead.
    }
  }
  if (legacyQuestions && legacyQuestions.length > 0) return questionsToQuiz(legacyQuestions);
  return defaultReflectionQuiz();
};

const asTrimmedString = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/**
 * Validates and canonicalises an admin-submitted quiz. Throws a plain Error the
 * caller wraps in its own HTTP error type — this package stays framework-free.
 *
 * Returns `[]` for "no custom quiz", which readers treat as "use the fallback",
 * so clearing the builder resets the session rather than leaving the student
 * with nothing to answer.
 */
export const normalizeReflectionQuiz = (value: unknown): ReflectionQuestion[] => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('reflectionQuiz must be an array of questions');
  if (value.length > MAX_REFLECTION_QUESTIONS) {
    throw new Error(`A reflection quiz can hold at most ${MAX_REFLECTION_QUESTIONS} questions`);
  }

  const out: ReflectionQuestion[] = [];

  value.forEach((raw: any, index: number) => {
    const prompt = asTrimmedString(raw?.prompt, MAX_PROMPT_LEN);
    const imageUrl = asTrimmedString(raw?.imageUrl, 1000) || null;

    // A row with neither text nor picture is an empty builder slot, not an error.
    if (!prompt && !imageUrl) return;

    const type: ReflectionQuestionType = REFLECTION_QUESTION_TYPES.includes(raw?.type) ? raw.type : 'TEXT';
    if (!prompt) throw new Error(`Question ${index + 1} needs a prompt`);

    const points = Number.isFinite(Number(raw?.points))
      ? Math.max(0, Math.min(100, Math.round(Number(raw.points))))
      : DEFAULT_REFLECTION_POINTS;

    const question: ReflectionQuestion = {
      id: asTrimmedString(raw?.id, 64) || makeId('q'),
      type,
      prompt,
      imageUrl,
      points,
    };

    if (type === 'MCQ' || type === 'IMAGE_CHOICE') {
      const rawOptions = Array.isArray(raw?.options) ? raw.options : [];
      const options: ReflectionOption[] = [];

      rawOptions.forEach((opt: any) => {
        const label = asTrimmedString(opt?.label, MAX_OPTION_LEN);
        const optImage = asTrimmedString(opt?.imageUrl, 1000) || null;
        if (!label && !optImage) return;
        options.push({
          id: asTrimmedString(opt?.id, 64) || makeId('o'),
          // An image tile still needs a label for screen readers and for the
          // answer snapshot, which stores the label rather than the picture.
          label: label || `Option ${options.length + 1}`,
          imageUrl: optImage,
        });
      });

      if (options.length < 2) {
        throw new Error(`Question ${index + 1} is multiple choice and needs at least 2 options`);
      }
      if (options.length > MAX_REFLECTION_OPTIONS) {
        throw new Error(`Question ${index + 1} can have at most ${MAX_REFLECTION_OPTIONS} options`);
      }

      question.options = options;

      const correctId = asTrimmedString(raw?.correctOptionId, 64);
      // Silently dropping an id that no longer matches any option is deliberate:
      // deleting the correct choice should downgrade the question to an opinion
      // poll, not make the whole quiz unsaveable.
      question.correctOptionId = correctId && options.some((o) => o.id === correctId) ? correctId : null;
    }

    out.push(question);
  });

  return out;
};

/**
 * Removes the answer key before a quiz is sent to anyone who is going to sit it.
 *
 * `correctOptionId` is the whole answer key: a student who opens devtools on the
 * session list would otherwise see which option scores the points before
 * choosing one. `graded` is kept so the UI can still say a question has a right
 * answer without saying which.
 *
 * Grading is unaffected — the server reads the key from its own copy of the
 * session, never from what it sent the client.
 */
export const stripAnswerKey = (quiz: ReflectionQuestion[]): (ReflectionQuestion & { graded: boolean })[] =>
  quiz.map(({ correctOptionId, ...rest }) => ({ ...rest, graded: Boolean(correctOptionId) }));

/** Roles allowed to see which option is correct. */
const ANSWER_KEY_ROLES = new Set(['ADMIN', 'INSTRUCTOR']);

export const canSeeAnswerKey = (role: string | undefined): boolean => ANSWER_KEY_ROLES.has(role ?? '');

/** The scale a SCALE question offers. Kept here so grader and UI cannot drift. */
export const REFLECTION_SCALE_MIN = 1;
export const REFLECTION_SCALE_MAX = 5;

/** What a client sends back per question. */
export interface ReflectionResponse {
  questionId: string;
  answer?: string;
  selectedOptionId?: string | null;
}

export interface GradedReflection {
  entries: ReflectionAnswerEntry[];
  score: number;
  maxScore: number;
  answeredCount: number;
  badge: ReflectionBadge | null;
}

/**
 * Grades a submission against the server's copy of the quiz.
 *
 * Question text is copied into each entry so a later admin edit can never
 * reword what a student was actually asked. Only questions with a
 * `correctOptionId` are marked right or wrong; everything else — free text,
 * scales, opinion polls — scores full points for being answered, because the
 * point of a reflection is that the student did it, not that they guessed the
 * answer the admin had in mind.
 */
export const gradeReflection = (
  questions: ReflectionQuestion[],
  responses: ReflectionResponse[]
): GradedReflection => {
  const byId = new Map(responses.map((r) => [r.questionId, r]));
  const entries: ReflectionAnswerEntry[] = [];
  let score = 0;
  let maxScore = 0;
  let answeredCount = 0;

  questions.forEach((q, index) => {
    // Positional fallback keeps older clients that post a bare answer list working.
    const response = byId.get(q.id) ?? responses[index];
    const points = q.points ?? DEFAULT_REFLECTION_POINTS;
    maxScore += points;

    let answer = '';
    let selectedOptionId: string | null = null;
    let correct: boolean | null = null;
    let pointsEarned = 0;

    if (q.type === 'MCQ' || q.type === 'IMAGE_CHOICE') {
      const chosen = q.options?.find((o) => o.id === response?.selectedOptionId) ?? null;
      selectedOptionId = chosen?.id ?? null;
      answer = chosen?.label ?? '';
      if (chosen) {
        answeredCount++;
        if (q.correctOptionId) {
          correct = chosen.id === q.correctOptionId;
          pointsEarned = correct ? points : 0;
        } else {
          pointsEarned = points;
        }
      } else if (q.correctOptionId) {
        correct = false;
      }
    } else {
      answer = typeof response?.answer === 'string' ? response.answer.trim().slice(0, 2000) : '';
      if (answer) {
        answeredCount++;
        pointsEarned = points;
      }
    }

    score += pointsEarned;
    entries.push({
      questionId: q.id,
      question: q.prompt,
      type: q.type,
      answer,
      selectedOptionId,
      correct,
      pointsEarned,
      pointsPossible: points,
    });
  });

  return { entries, score, maxScore, answeredCount, badge: badgeForScore(score, maxScore) };
};

// ── Session mind map ──────────────────────────────────────────
// Topics an admin attaches to a curriculum session. Students and mentors open
// the same map; a topic can carry a longer explanation and, later, a video.

/** One short clip attached to a topic. */
export interface TopicVideo {
  id: string;
  title: string;
  url: string;
  /** Runtime in seconds, so the card can print "2:30". Optional. */
  durationSec?: number | null;
  /** Poster image. Falls back to a generated placeholder in the UI. */
  thumbnailUrl?: string | null;
}

export interface SessionTopic {
  id: string;
  title: string;
  /** One line shown on the node itself. */
  summary?: string | null;
  /** Longer explanation revealed when the node is opened. */
  details?: string | null;
  /**
   * Legacy single video. Kept so maps built before `videos` existed still play;
   * readers fold it into `videos` rather than rendering it separately.
   */
  videoUrl?: string | null;
  videos?: TopicVideo[];
  resourceUrl?: string | null;
  children?: SessionTopic[];
}

export const MAX_TOPIC_VIDEOS = 8;

export const MAX_SESSION_TOPICS = 12;
export const MAX_SESSION_SUBTOPICS = 8;
const MAX_TOPIC_TITLE_LEN = 160;
const MAX_TOPIC_SUMMARY_LEN = 300;
const MAX_TOPIC_DETAILS_LEN = 4000;

const normalizeTopicVideos = (raw: any, legacyUrl: string | null): TopicVideo[] => {
  const list: TopicVideo[] = [];

  (Array.isArray(raw) ? raw : []).slice(0, MAX_TOPIC_VIDEOS).forEach((v: any, i: number) => {
    const url = asTrimmedString(v?.url, 1000);
    if (!url) return;
    const duration = Number(v?.durationSec);
    list.push({
      id: asTrimmedString(v?.id, 64) || makeId('v'),
      title: asTrimmedString(v?.title, MAX_TOPIC_TITLE_LEN) || `Video ${i + 1}`,
      url,
      durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
      thumbnailUrl: asTrimmedString(v?.thumbnailUrl, 1000) || null,
    });
  });

  // Fold the pre-`videos` single URL in, unless it is already one of them, so an
  // older map keeps playing after the schema grew.
  if (legacyUrl && !list.some((v) => v.url === legacyUrl)) {
    list.unshift({ id: makeId('v'), title: 'Video', url: legacyUrl, durationSec: null, thumbnailUrl: null });
  }

  return list.slice(0, MAX_TOPIC_VIDEOS);
};

const normalizeTopicNode = (raw: any, allowChildren: boolean): SessionTopic | null => {
  const title = asTrimmedString(raw?.title, MAX_TOPIC_TITLE_LEN);
  if (!title) return null;

  const legacyUrl = asTrimmedString(raw?.videoUrl, 1000) || null;
  const node: SessionTopic = {
    id: asTrimmedString(raw?.id, 64) || makeId('t'),
    title,
    summary: asTrimmedString(raw?.summary, MAX_TOPIC_SUMMARY_LEN) || null,
    details: asTrimmedString(raw?.details, MAX_TOPIC_DETAILS_LEN) || null,
    videoUrl: legacyUrl,
    videos: normalizeTopicVideos(raw?.videos, legacyUrl),
    resourceUrl: asTrimmedString(raw?.resourceUrl, 1000) || null,
  };

  if (allowChildren && Array.isArray(raw?.children)) {
    const children = raw.children
      .slice(0, MAX_SESSION_SUBTOPICS)
      .map((c: any) => normalizeTopicNode(c, false))
      .filter(Boolean) as SessionTopic[];
    if (children.length > 0) node.children = children;
  }

  return node;
};

/**
 * Validates an admin-submitted mind map. Depth is capped at two levels on
 * purpose — a deeper tree is unreadable on a phone and impossible to lay out.
 */
export const normalizeSessionTopics = (value: unknown): SessionTopic[] => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('topics must be an array');
  if (value.length > MAX_SESSION_TOPICS) {
    throw new Error(`A session can have at most ${MAX_SESSION_TOPICS} topics`);
  }
  return value.map((t) => normalizeTopicNode(t, true)).filter(Boolean) as SessionTopic[];
};

/** Reads a stored map defensively — bad data renders as "no map", never a crash. */
export const effectiveSessionTopics = (value: unknown): SessionTopic[] => {
  try {
    return normalizeSessionTopics(value);
  } catch {
    return [];
  }
};

// ── Cross-service media grants ────────────────────────────────
// Recordings live in integration-service; who is allowed to watch a given class
// is known only to auth-service, which owns the student/parent/mentor graph.
//
// Rather than have integration-service call back to ask — or, worse, hand every
// portal the full recordings list and filter in the browser, which is how the
// admin scheduler works and is exactly what must not happen for parents —
// auth-service signs a short-lived grant naming one class, and
// integration-service verifies the signature. No cross-service round trip, and
// the authorisation decision stays in the service that can actually make it.

const GRANT_VERSION = 'v1';

const grantKey = (): Buffer =>
  crypto
    .createHmac('sha256', process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-in-production')
    .update(`finquo-class-media-grant-${GRANT_VERSION}`)
    .digest();

/** Long enough to browse a term's classes without re-fetching. */
export const CLASS_MEDIA_GRANT_TTL_SECONDS = 2 * 60 * 60;

export interface ClassMediaGrant {
  classId: string;
  /** Meet room code, so integration-service can match without a DB join. */
  meetCode: string;
}

const grantSig = (classId: string, meetCode: string, exp: number): string =>
  crypto.createHmac('sha256', grantKey()).update(`${classId}:${meetCode}:${exp}`).digest('hex');

export const createClassMediaGrant = (
  classId: string,
  meetCode: string,
  ttlSeconds: number = CLASS_MEDIA_GRANT_TTL_SECONDS
): string => {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${classId}.${meetCode}.${exp}.${grantSig(classId, meetCode, exp)}`;
};

/** Returns the grant's contents, or null for anything malformed, expired or forged. */
export const verifyClassMediaGrant = (token: unknown): ClassMediaGrant | null => {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;

  const [classId, meetCode, expRaw, sig] = parts;
  const exp = Number(expRaw);
  if (!classId || !meetCode || !Number.isFinite(exp)) return null;
  if (exp <= Math.floor(Date.now() / 1000)) return null;

  const expected = grantSig(classId, meetCode, exp);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  return { classId, meetCode };
};

/** Pull the 3-4-3 room code out of a Meet URL. Mirrors the frontend helper. */
export const extractMeetCode = (meetUrl: string | null | undefined): string | null => {
  if (!meetUrl) return null;
  const code = meetUrl.trim().split('?')[0].split('#')[0].split('/').pop() || '';
  return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code) ? code : null;
};

// ── Attendance ────────────────────────────────────────────────
// A class carries a workflow status (SCHEDULED / COMPLETED / CANCELLED /
// RESCHEDULE_REQUESTED), which is not the same thing as whether the student
// turned up. Attendance is derived from status, time and reschedule history so
// the student portal, the mentor portal and any report all agree.

export type AttendanceState = 'ATTENDED' | 'MISSED' | 'POSTPONED' | 'CANCELLED' | 'UPCOMING';

export interface AttendanceInput {
  status: string;
  startTime: string | Date;
  endTime?: string | Date | null;
  rescheduledCount?: number | null;
  /**
   * When the Meet room actually emptied after a real meeting. Independent
   * evidence the class took place, which `status` cannot provide on its own.
   */
  actualEndedAt?: string | Date | null;
}

export const ATTENDANCE_LABELS: Record<AttendanceState, string> = {
  ATTENDED: 'Attended',
  MISSED: 'Missed',
  POSTPONED: 'Postponed',
  CANCELLED: 'Cancelled',
  UPCOMING: 'Upcoming',
};

/**
 * Does this class still owe a reflection quiz?
 *
 * Only classes the student actually attended. A missed class has nothing to
 * reflect on, and answers about a lesson the student was not in would be
 * worthless to the mentor reading them.
 *
 * The practical consequence is that the quiz appears once the mentor marks the
 * class complete, not the moment the slot ends — until then nothing in the data
 * distinguishes "the student did not turn up" from "the mentor has not marked
 * it yet", and guessing wrong in that direction is the worse failure.
 */
export const owesReflection = (
  cls: AttendanceInput & { reflectionSubmittedAt?: Date | string | null },
  nowMs: number = Date.now()
): boolean => !cls.reflectionSubmittedAt && deriveAttendance(cls, nowMs) === 'ATTENDED';

export const deriveAttendance = (cls: AttendanceInput, nowMs: number = Date.now()): AttendanceState => {
  if (cls.status === 'CANCELLED') return 'CANCELLED';
  // A completed class counts as attended even if it had to be moved first.
  if (cls.status === 'COMPLETED') return 'ATTENDED';
  // The room was used and then emptied. That is direct evidence the class ran,
  // so it counts as attended without waiting for the mentor to click Complete —
  // which is what previously left a real class showing as MISSED for days.
  if (cls.actualEndedAt) return 'ATTENDED';

  const start = new Date(cls.startTime).getTime();
  const end = cls.endTime ? new Date(cls.endTime).getTime() : start + 90 * 60 * 1000;

  if (cls.status === 'RESCHEDULE_REQUESTED') return 'POSTPONED';
  // Past its slot with no sign anyone was ever in the room.
  if (end <= nowMs) return 'MISSED';
  if ((cls.rescheduledCount ?? 0) > 0) return 'POSTPONED';
  return 'UPCOMING';
};

/**
 * Is this class finished — by any evidence at all?
 *
 * Three independent signals, in order of confidence: the mentor marked it, the
 * Meet room emptied after a real meeting, or the allotted slot simply ran out.
 * Used to decide whether to keep offering a Join button.
 */
export const isClassOver = (cls: AttendanceInput, nowMs: number = Date.now()): boolean => {
  if (cls.status === 'COMPLETED' || cls.status === 'CANCELLED') return true;
  if (cls.actualEndedAt) return true;
  const start = new Date(cls.startTime).getTime();
  const end = cls.endTime ? new Date(cls.endTime).getTime() : start + 90 * 60 * 1000;
  return end <= nowMs;
};
