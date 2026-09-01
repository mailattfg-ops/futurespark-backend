import { AppError } from '@futurespark/middleware';
import {
  HTTP_STATUS,
  DEFAULT_REFLECTION_QUESTIONS as CONSTANTS_DEFAULT_REFLECTION_QUESTIONS,
  REFLECTION_QUESTION_COUNT,
  effectiveReflectionQuestions as constantsEffectiveReflectionQuestions,
  normalizeReflectionQuiz,
  normalizeSessionTopics,
  ReflectionQuestion,
  SessionTopic,
  effectiveSessionActivities,
  MAX_SESSION_ACTIVITIES,
  type SessionActivities,
} from '@futurespark/constants';

const FALLBACK_REFLECTION_QUESTIONS = [
  'What is the most important thing you learned in this session?',
  'Which part did you find most challenging, and why?',
  'How could you use what you learned today outside of class?',
  'What is one question you still have for your mentor?',
  'How confident do you feel about this topic now (1-5), and what would raise it?',
];

export const DEFAULT_REFLECTION_QUESTIONS = CONSTANTS_DEFAULT_REFLECTION_QUESTIONS || FALLBACK_REFLECTION_QUESTIONS;
export { REFLECTION_QUESTION_COUNT };

export const effectiveReflectionQuestions = (stored: string[] | null | undefined): string[] => {
  if (typeof constantsEffectiveReflectionQuestions === 'function') {
    return constantsEffectiveReflectionQuestions(stored);
  }
  return stored && stored.length > 0 ? stored : DEFAULT_REFLECTION_QUESTIONS;
};

// ── Program ───────────────────────────────────────────────────

export interface CreateProgramInput {
  title: string;
  description?: string;
  level?: string;
  levelColor?: string;
  image?: string;
}

export const validateCreateProgram = (data: any): CreateProgramInput => {
  const errors: string[] = [];
  if (!data.title || typeof data.title !== 'string') {
    errors.push('Program title is required and must be a string');
  }
  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);
  return {
    title: data.title.trim(),
    description: data.description?.trim() || undefined,
    level: data.level?.trim() || 'Beginner',
    levelColor: data.levelColor?.trim() || 'purple',
    image: data.image?.trim() || undefined,
  };
};

// ── PaymentPlan ───────────────────────────────────────────────

export type PlanType = 'FULL' | 'INSTALLMENT';

export interface UpsertPaymentPlanInput {
  type: PlanType;
  price: number;
  description?: string;
  installments?: {
    name: string;
    amount: number;
    order: number;
    sessionIds?: string[];
  }[];
}

export const validateUpsertPaymentPlan = (data: any): UpsertPaymentPlanInput => {
  const errors: string[] = [];
  if (!data.type || !['FULL', 'INSTALLMENT'].includes(data.type)) {
    errors.push('Payment plan type must be FULL or INSTALLMENT');
  }
  if (data.price === undefined || typeof data.price !== 'number' || data.price < 0) {
    errors.push('Price must be a non-negative number');
  }
  if (data.installments !== undefined && !Array.isArray(data.installments)) {
    errors.push('Installments must be an array');
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  const installmentsParsed = data.installments
    ? data.installments.map((inst: any, idx: number) => {
        if (!inst.name || typeof inst.name !== 'string') {
          throw new AppError('Each installment must have a name', HTTP_STATUS.BAD_REQUEST);
        }
        if (inst.amount === undefined || typeof inst.amount !== 'number' || inst.amount < 0) {
          throw new AppError('Each installment must have a non-negative amount', HTTP_STATUS.BAD_REQUEST);
        }
        return {
          name: inst.name.trim(),
          amount: inst.amount,
          order: typeof inst.order === 'number' ? inst.order : idx + 1,
          sessionIds: Array.isArray(inst.sessionIds) ? inst.sessionIds : [],
        };
      })
    : undefined;

  return {
    type: data.type as PlanType,
    price: data.price,
    description: data.description?.trim() || undefined,
    installments: installmentsParsed,
  };
};

// ── Session ───────────────────────────────────────────────────

const MAX_REFLECTION_QUESTION_LEN = 500;

/**
 * Trims, drops blanks, and caps the list. Returns `[]` for "no custom set",
 * which the read path reads as "use the defaults" — so clearing every box in
 * the admin form resets the session to the defaults rather than leaving the
 * student with nothing to answer.
 */
export const normalizeReflectionQuestions = (value: any): string[] => {
  if (!Array.isArray(value)) {
    throw new AppError('reflectionQuestions must be an array of strings', HTTP_STATUS.BAD_REQUEST);
  }
  const cleaned = value
    .map((q) => (typeof q === 'string' ? q.trim() : ''))
    .filter((q) => q.length > 0);

  const tooLong = cleaned.find((q) => q.length > MAX_REFLECTION_QUESTION_LEN);
  if (tooLong) {
    throw new AppError(
      `Each reflection question must be ${MAX_REFLECTION_QUESTION_LEN} characters or fewer`,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return cleaned.slice(0, REFLECTION_QUESTION_COUNT);
};

/**
 * The shared normalisers throw plain Errors so `@futurespark/constants` stays
 * framework-free. Everything they reject is a client mistake, so they surface
 * as 400s rather than escaping as 500s.
 */
const asBadRequest = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (err: any) {
    throw new AppError(err?.message || 'Invalid request body', HTTP_STATUS.BAD_REQUEST);
  }
};

/**
 * Ceiling on stored presentation text.
 *
 * A full session deck runs to roughly 10-15k characters; 200k leaves generous
 * room while still refusing a pasted PDF binary or a runaway paste loop. The
 * summariser truncates to GROQ_SLIDE_CONTENT_CHARS separately, so this is a
 * storage guard rather than a prompt-budget one.
 */
export const SLIDE_CONTENT_MAX = 200_000;

export interface CreateSessionInput {
  title: string;
  order: number;
  durationMin?: number;
  slidesUrl?: string | null;
  guideUrl?: string | null;
  worksheetUrl?: string | null;
  slideContent?: string | null;
  programId?: string | null;
  credits?: number;
  reflectionQuestions?: string[];
  reflectionQuiz?: ReflectionQuestion[];
  topics?: SessionTopic[];
  learningOutcomes?: string[];
  activities?: SessionActivities;
}

export const validateCreateSession = (data: any): CreateSessionInput => {
  const errors: string[] = [];
  if (!data.title || typeof data.title !== 'string') {
    errors.push('Session title is required and must be a string');
  }
  if (data.order === undefined || typeof data.order !== 'number') {
    errors.push('Session order is required and must be a number');
  }
  if (data.durationMin !== undefined && typeof data.durationMin !== 'number') {
    errors.push('Duration must be a number');
  }
  if (data.credits !== undefined && typeof data.credits !== 'number') {
    errors.push('Credits must be a number');
  }
  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);
  return {
    title: data.title.trim(),
    order: data.order,
    durationMin: data.durationMin,
    slidesUrl: data.slidesUrl?.trim() || null,
    guideUrl: data.guideUrl?.trim() || null,
    worksheetUrl: data.worksheetUrl?.trim() || null,
    slideContent: typeof data.slideContent === 'string' ? data.slideContent.trim().slice(0, SLIDE_CONTENT_MAX) || null : null,
    programId: data.programId?.trim() || null,
    credits: typeof data.credits === 'number' ? data.credits : undefined,
    reflectionQuestions:
      data.reflectionQuestions === undefined ? undefined : normalizeReflectionQuestions(data.reflectionQuestions),
    reflectionQuiz:
      data.reflectionQuiz === undefined ? undefined : asBadRequest(() => normalizeReflectionQuiz(data.reflectionQuiz)),
    topics: data.topics === undefined ? undefined : asBadRequest(() => normalizeSessionTopics(data.topics)),
  };
};

/**
 * Whitelisted partial update. Only keys actually present in the body are
 * returned, so a caller editing just the resources cannot blank out the title.
 */
/**
 * The outcomes this session teaches, as the report prints them.
 *
 * Capped at eight because that is what the report's layout holds — accepting a
 * ninth here would mean silently dropping it at render time, which is worse
 * than telling the author now.
 */
const MAX_LEARNING_OUTCOMES = 8;
const OUTCOME_MAX_LEN = 160;

const normalizeLearningOutcomes = (raw: any): string[] => {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new AppError('Learning outcomes must be a list', HTTP_STATUS.BAD_REQUEST);
  const out = raw
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0)
    .map((v) => v.slice(0, OUTCOME_MAX_LEN));
  if (out.length > MAX_LEARNING_OUTCOMES) {
    throw new AppError(
      `A session can have at most ${MAX_LEARNING_OUTCOMES} learning outcomes.`,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return out;
};

const normalizeActivitiesInput = (raw: any): SessionActivities => {
  if (raw === null || raw === undefined) return { inSession: [], takeHome: [] };
  if (typeof raw !== 'object') {
    throw new AppError('Activities must be an object with inSession and takeHome', HTTP_STATUS.BAD_REQUEST);
  }
  const cleaned = effectiveSessionActivities(raw);
  for (const [key, list] of [['in-session', cleaned.inSession], ['take-home', cleaned.takeHome]] as const) {
    if (list.length > MAX_SESSION_ACTIVITIES) {
      throw new AppError(
        `A session can have at most ${MAX_SESSION_ACTIVITIES} ${key} activities.`,
        HTTP_STATUS.BAD_REQUEST
      );
    }
  }
  return cleaned;
};

export const validateUpdateSession = (data: any): Partial<CreateSessionInput> => {
  const out: Partial<CreateSessionInput> = {};
  const errors: string[] = [];

  if (data.title !== undefined) {
    if (typeof data.title !== 'string' || !data.title.trim()) errors.push('Session title must be a non-empty string');
    else out.title = data.title.trim();
  }
  if (data.order !== undefined) {
    if (typeof data.order !== 'number') errors.push('Session order must be a number');
    else out.order = data.order;
  }
  if (data.durationMin !== undefined) {
    if (typeof data.durationMin !== 'number') errors.push('Duration must be a number');
    else out.durationMin = data.durationMin;
  }
  if (data.credits !== undefined) {
    if (typeof data.credits !== 'number') errors.push('Credits must be a number');
    else out.credits = data.credits;
  }
  for (const key of ['slidesUrl', 'guideUrl', 'worksheetUrl'] as const) {
    if (data[key] !== undefined) out[key] = typeof data[key] === 'string' ? data[key].trim() || null : null;
  }
  // The presentation text. Deliberately NOT trimmed to a short field: this is a
  // whole deck's worth of slides, key terms and speaker notes, and it is what
  // lets the post-class summariser name concepts correctly and report which
  // planned topics the class actually reached.
  if (data.slideContent !== undefined) {
    if (data.slideContent !== null && typeof data.slideContent !== 'string') {
      errors.push('Session material must be text');
    } else {
      const value = typeof data.slideContent === 'string' ? data.slideContent.trim() : '';
      if (value.length > SLIDE_CONTENT_MAX) {
        errors.push(`Session material is too long (${value.length} characters; the limit is ${SLIDE_CONTENT_MAX})`);
      } else {
        out.slideContent = value.length > 0 ? value : null;
      }
    }
  }
  if (data.programId !== undefined) {
    out.programId = typeof data.programId === 'string' ? data.programId.trim() || null : null;
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  // These throw on their own if malformed, so they stay outside the errors array.
  if (data.reflectionQuestions !== undefined) {
    out.reflectionQuestions = normalizeReflectionQuestions(data.reflectionQuestions);
  }
  if (data.reflectionQuiz !== undefined) {
    out.reflectionQuiz = asBadRequest(() => normalizeReflectionQuiz(data.reflectionQuiz));
  }
  if (data.topics !== undefined) {
    out.topics = asBadRequest(() => normalizeSessionTopics(data.topics));
  }
  if (data.learningOutcomes !== undefined) {
    out.learningOutcomes = normalizeLearningOutcomes(data.learningOutcomes);
  }
  if (data.activities !== undefined) {
    out.activities = normalizeActivitiesInput(data.activities);
  }
  return out;
};
