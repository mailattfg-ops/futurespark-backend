import { db } from '../../database/datasource';
import { CreateProgramInput, UpsertPaymentPlanInput, CreateSessionInput, PlanType } from './course.schema';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export const courseService = {
  // ── Program Operations ───────────────────────────────────────

  async createProgram(input: CreateProgramInput) {
    return db.program.create({ data: input });
  },

  async getAllPrograms() {
    return db.program.findMany({
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
  },

  async getAllSessions() {
    return db.session.findMany({
      include: {
        program: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  async getProgramById(id: string) {
    const program = await db.program.findUnique({
      where: { id },
      include: {
        sessions: { orderBy: { order: 'asc' } },
        paymentPlans: {
          include: {
            installments: { orderBy: { order: 'asc' } },
          },
        },
      },
    });
    if (!program) throw new AppError('Program not found', HTTP_STATUS.NOT_FOUND);
    return program;
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
          await tx.installment.createMany({
            data: input.installments.map(inst => ({
              name: inst.name,
              amount: inst.amount,
              order: inst.order,
              paymentPlanId: plan.id,
            })),
          });
        }
      }

      return tx.paymentPlan.findUnique({
        where: { id: plan.id },
        include: {
          installments: { orderBy: { order: 'asc' } },
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
    return db.session.create({
      data: {
        title: input.title,
        order: input.order,
        durationMin: input.durationMin ?? 60,
        slidesUrl: input.slidesUrl ?? null,
        guideUrl: input.guideUrl ?? null,
        worksheetUrl: input.worksheetUrl ?? null,
        programId: resolvedProgramId ?? null,
      },
    });
  },

  async updateSession(id: string, input: Partial<CreateSessionInput>) {
    const session = await db.session.findUnique({ where: { id } });
    if (!session) throw new AppError('Session not found', HTTP_STATUS.NOT_FOUND);
    return db.session.update({ where: { id }, data: input });
  },

  async deleteSession(id: string) {
    const session = await db.session.findUnique({ where: { id } });
    if (!session) throw new AppError('Session not found', HTTP_STATUS.NOT_FOUND);
    return db.session.delete({ where: { id } });
  },
};
