import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

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

export interface CreateSessionInput {
  title: string;
  order: number;
  durationMin?: number;
  slidesUrl?: string | null;
  guideUrl?: string | null;
  worksheetUrl?: string | null;
  programId?: string | null;
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
  if (errors.length > 0) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);
  return {
    title: data.title.trim(),
    order: data.order,
    durationMin: data.durationMin,
    slidesUrl: data.slidesUrl?.trim() || null,
    guideUrl: data.guideUrl?.trim() || null,
    worksheetUrl: data.worksheetUrl?.trim() || null,
    programId: data.programId?.trim() || null,
  };
};
