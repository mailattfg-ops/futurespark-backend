import { db } from '../../database/datasource';
import {
  CreateProgramInput,
  UpsertPaymentPlanInput,
  CreateSessionInput,
  PlanType,
  effectiveReflectionQuestions,
} from './course.schema';
import { AppError } from '@futurespark/middleware';
import {
  HTTP_STATUS,
  effectiveReflectionQuiz,
  effectiveSessionTopics,
} from '@futurespark/constants';

/**
 * Substitutes the platform defaults for any session that has not been
 * customised, so every consumer (admin editor, student portal, mentor tracker)
 * receives a ready-to-answer quiz without each re-implementing the fallback
 * chain. The `*Customised` flags preserve the distinction for the admin UI,
 * which shows whether a session is on defaults or overridden.
 */
const withReflectionQuestions = <
  T extends { reflectionQuestions?: string[] | null; reflectionQuiz?: unknown; topics?: unknown }
>(
  session: T
) => ({
  ...session,
  reflectionQuestions: effectiveReflectionQuestions(session.reflectionQuestions),
  reflectionQuestionsCustomised: Boolean(session.reflectionQuestions && session.reflectionQuestions.length > 0),
  reflectionQuiz: effectiveReflectionQuiz(session.reflectionQuiz, session.reflectionQuestions),
  reflectionQuizCustomised: Array.isArray(session.reflectionQuiz) && session.reflectionQuiz.length > 0,
  topics: effectiveSessionTopics(session.topics),
});

export const courseService = {
  // ── Program Operations ───────────────────────────────────────

  async createProgram(input: CreateProgramInput) {
    return db.program.create({ data: input });
  },

  async getAllPrograms() {
    const programs = await db.program.findMany({
      include: {
        sessions: { orderBy: { order: 'asc' } },
        paymentPlans: {
          include: {
            installments: { orderBy: { order: 'asc' } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return programs.map((p) => ({ ...p, sessions: p.sessions.map(withReflectionQuestions) }));
  },

  async getAllSessions() {
    const sessions = await db.session.findMany({
      include: {
        program: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map(withReflectionQuestions);
  },

  async getProgramById(id: string) {
    const program = await db.program.findUnique({
      where: { id },
      include: {
        sessions: { orderBy: { order: 'asc' } },
        paymentPlans: {
          include: {
            installments: {
              orderBy: { order: 'asc' },
              include: { sessions: true },
            },
          },
        },
      },
    });
    if (!program) throw new AppError('Program not found', HTTP_STATUS.NOT_FOUND);
    return { ...program, sessions: program.sessions.map(withReflectionQuestions) };
  },

  async updateProgram(id: string, input: Partial<CreateProgramInput>) {
    await this.getProgramById(id);
    return db.program.update({ where: { id }, data: input });
  },

  async deleteProgram(id: string) {
    await this.getProgramById(id);
    return db.program.delete({ where: { id } });
  },

  // ── PaymentPlan Operations (upsert by type) ───────────────────

  async upsertPaymentPlan(programId: string, input: UpsertPaymentPlanInput) {
    await this.getProgramById(programId);
    return db.$transaction(async (tx) => {
      const plan = await tx.paymentPlan.upsert({
        where: { programId_type: { programId, type: input.type } },
        create: {
          type: input.type,
          price: input.price,
          description: input.description,
          programId,
        },
        update: {
          price: input.price,
          description: input.description,
        },
      });

      if (input.installments) {
        await tx.installment.deleteMany({
          where: { paymentPlanId: plan.id },
        });

        if (input.installments.length > 0) {
          for (const inst of input.installments) {
            const created = await tx.installment.create({
              data: {
                name: inst.name,
                amount: inst.amount,
                order: inst.order,
                paymentPlanId: plan.id,
              },
            });

            if (inst.sessionIds && inst.sessionIds.length > 0) {
              await tx.session.updateMany({
                where: { id: { in: inst.sessionIds } },
                data: { installmentId: created.id },
              });
            }
          }
        }
      }

      return tx.paymentPlan.findUnique({
        where: { id: plan.id },
        include: {
          installments: {
            orderBy: { order: 'asc' },
            include: { sessions: true },
          },
        },
      });
    });
  },

  async deletePaymentPlan(programId: string, type: PlanType) {
    const plan = await db.paymentPlan.findUnique({
      where: { programId_type: { programId, type } },
    });
    if (!plan) throw new AppError('Payment plan not found', HTTP_STATUS.NOT_FOUND);
    return db.paymentPlan.delete({ where: { id: plan.id } });
  },

  // ── Session Operations ───────────────────────────────────────

  async createSession(programId: string | undefined, input: CreateSessionInput) {
    const resolvedProgramId = programId || input.programId;
    if (resolvedProgramId) {
      await this.getProgramById(resolvedProgramId);
    }
    const created = await db.session.create({
      data: {
        title: input.title,
        order: input.order,
        durationMin: input.durationMin ?? 60,
        slidesUrl: input.slidesUrl ?? null,
        guideUrl: input.guideUrl ?? null,
        worksheetUrl: input.worksheetUrl ?? null,
        slideContent: input.slideContent ?? null,
        programId: resolvedProgramId ?? null,
        credits: input.credits ?? 10,
        reflectionQuestions: input.reflectionQuestions ?? [],
        reflectionQuiz: (input.reflectionQuiz ?? []) as any,
        topics: (input.topics ?? []) as any,
      },
    });
    return withReflectionQuestions(created);
  },

  async updateSession(id: string, input: Partial<CreateSessionInput>) {
    const session = await db.session.findUnique({ where: { id } });
    if (!session) throw new AppError('Session not found', HTTP_STATUS.NOT_FOUND);
    // Json columns need an explicit cast: Prisma's InputJsonValue does not
    // accept our interface types, and passing the whole input through would
    // widen them to `never`.
    const { reflectionQuiz, topics, ...rest } = input;
    const updated = await db.session.update({
      where: { id },
      data: {
        ...rest,
        ...(reflectionQuiz !== undefined ? { reflectionQuiz: reflectionQuiz as any } : {}),
        ...(topics !== undefined ? { topics: topics as any } : {}),
      },
    });
    return withReflectionQuestions(updated);
  },

  async deleteSession(id: string) {
    const session = await db.session.findUnique({ where: { id } });
    if (!session) throw new AppError('Session not found', HTTP_STATUS.NOT_FOUND);
    return db.session.delete({ where: { id } });
  },
};
