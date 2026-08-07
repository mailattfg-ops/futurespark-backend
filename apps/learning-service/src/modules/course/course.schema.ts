import { AppError } from '@futurespark/middleware';
import {
  HTTP_STATUS,
  DEFAULT_REFLECTION_QUESTIONS as CONSTANTS_DEFAULT_REFLECTION_QUESTIONS,
  REFLECTION_QUESTION_COUNT,
  effectiveReflectionQuestions as constantsEffectiveReflectionQuestions,
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

export interface CreateSessionInput {
  title: string;
  order: number;
  durationMin?: number;
  slidesUrl?: string | null;
  guideUrl?: string | null;
  worksheetUrl?: string | null;
  programId?: string | null;
  credits?: number;
  reflectionQuestions?: string[];
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
    programId: data.programId?.trim() || null,
    credits: typeof data.credits === 'number' ? data.credits : undefined,
    reflectionQuestions:
      data.reflectionQuestions === undefined ? undefined : normalizeReflectionQuestions(data.reflectionQuestions),
  };
};

/**
 * Whitelisted partial update. Only keys actually present in the body are
 * returned, so a caller editing just the resources cannot blank out the title.
 */
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
  if (data.programId !== undefined) {
    out.programId = typeof data.programId === 'string' ? data.programId.trim() || null : null;
  }

  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  // Throws on its own if malformed, so it stays outside the errors array.
  if (data.reflectionQuestions !== undefined) {
    out.reflectionQuestions = normalizeReflectionQuestions(data.reflectionQuestions);
  }
  return out;
};
