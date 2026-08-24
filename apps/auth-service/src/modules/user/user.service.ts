import { hashPassword } from '@futurespark/authentication';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';
import { db } from '../../database/datasource';
import { userRepository } from './user.repository';
import { CreateUserInput, UpdateUserInput, ListUsersQuery } from './user.schema';
import { logger } from '@futurespark/logger';
import { UserWithoutPassword, PublicUser } from './user.model';
import type { PaginatedResponse } from '@futurespark/types';
import { sendNotification } from '../notification-helper';

/**
 * FIXED       — bookable only in the weekly slots the mentor has published.
 * FLEXIBLE    — open to any slot; the weekly grid becomes a preference, not a limit.
 * UNAVAILABLE — not taking new classes (leave, notice period, etc).
 */
export const MENTOR_AVAILABILITY_MODES = ['FIXED', 'FLEXIBLE', 'UNAVAILABLE'];

/**
 * Mentors now edit their own weekly slots from the teacher portal, so a TEACHER
 * caller is confined to their own rows. Staff callers are left alone — they
 * have always managed everyone's grid from the admin scheduler.
 */
const assertOwnSlotIfTeacher = (mentorId: string, caller?: { id?: string; role?: string }) => {
  if (caller?.role !== 'TEACHER') return;
  if (!caller.id) throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
  if (caller.id !== mentorId) {
    throw new AppError('You can only change your own availability slots', HTTP_STATUS.FORBIDDEN);
  }
};

/**
 * Default length of one weekly availability slot, in minutes.
 *
 * 70 = one hour ten: the class itself plus the few minutes either side that a
 * mentor actually spends settling a child in and wrapping up. It is only the
 * value the end time is PREFILLED with — every caller may send its own
 * `endTime` instead, so a mentor who is free for a three-hour block says so in
 * one slot rather than three.
 */
export const SLOT_DURATION_MINUTES = 70;

/** "HH:MM" (24-hr) → minutes past midnight, or null when unparseable. */
const parseHHMM = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
};

/** Minutes past midnight → "HH:MM", zero-padded. */
const formatHHMM = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const sanitize = (user: any): UserWithoutPassword => {
  const { passwordHash, ...rest } = user;
  return rest;
};

const sanitizePublic = (user: any): PublicUser => {
  let rating: number | undefined;
  let ratingCount: number | undefined;
  let warnings: string[] | undefined;
  let feedbacks: any[] | undefined;

  let completedRegular: number | undefined;
  let completedDemo: number | undefined;

  if (user.role?.name === 'TEACHER' && user.scheduledClasses) {
    const completedClasses = user.scheduledClasses.filter((c: any) => c.status === 'COMPLETED');

    /* Kept as two figures because they are paid as two figures. Demo and
     * regular classes sit on different payroll rates, and the person running
     * payroll should read the split off the mentor row — not tally class cards
     * by hand. A class converted to a demo counts as a demo here, because
     * classType is what the conversion rewrites. */
    const demoCount = completedClasses.filter(
      (c: any) => c.classType === 'DEMO' || (!c.studentId && !!c.leadId)
    ).length;
    completedDemo = demoCount;
    completedRegular = completedClasses.length - demoCount;
    const ratedClasses = completedClasses.filter((c: any) => c.studentRating !== null && c.studentRating !== undefined);
    
    // Base rating defaults to 5.0 if no student rating exists yet
    const baseRating = ratedClasses.length > 0
      ? ratedClasses.reduce((acc: number, c: any) => acc + c.studentRating, 0) / ratedClasses.length
      : 5.0;

    // QA Audit & Report deductions
    const qaFailures = user.scheduledClasses.filter((c: any) => c.qaStatus === 'FAILED').length;
    const qaFlags = user.scheduledClasses.filter((c: any) => c.qaStatus === 'FLAGGED').length;
    const totalReports = user.scheduledClasses.reduce((acc: number, c: any) => acc + (c.reports?.length || 0), 0);

    const deduction = (qaFailures * 0.5) + (qaFlags * 0.25) + (totalReports * 0.2);
    
    // Clamp rating between 1.0 and 5.0
    rating = Math.max(1.0, Math.min(5.0, Number((baseRating - deduction).toFixed(2))));
    ratingCount = ratedClasses.length;

    warnings = user.warnings || [];
    feedbacks = user.scheduledClasses
      .filter((c: any) => 
        (c.studentRating !== null && c.studentRating !== undefined) || 
        c.qaStatus === 'FAILED' || 
        c.qaStatus === 'FLAGGED' || 
        (c.reports && c.reports.length > 0)
      )
      .map((c: any) => ({
        classId: c.id,
        startTime: c.startTime,
        studentRating: c.studentRating,
        studentFeedback: c.studentFeedback,
        qaStatus: c.qaStatus,
        qaFeedback: c.qaFeedback,
        reports: c.reports?.map((r: any) => ({
          id: r.id,
          reporterName: r.reporterName,
          reporterRole: r.reporterRole,
          issueType: r.issueType,
          description: r.description,
          createdAt: r.createdAt
        })) || []
      }));
  }

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role?.name || null,
    isActive: user.isActive,
    completedRegular,
    completedDemo,
    qualifiedPrograms: user.qualifiedPrograms || [],
    mentorTypes: user.mentorTypes || [],
    qualifications: user.qualifications || null,
    experience: user.experience || null,
    state: user.state || null,
    country: user.country || null,
    timezone: user.timezone || 'Asia/Kolkata',
    createdAt: user.createdAt,
    rating,
    ratingCount,
    warnings,
    feedbacks,
  };
};

export const userService = {
  async createUser(input: CreateUserInput): Promise<UserWithoutPassword> {
    const existing = await userRepository.findByEmail(input.email);
    if (existing) throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);

    const passwordHash = hashPassword(input.password);
    const user = await userRepository.create({ ...input, passwordHash, requiresFtlReset: true });
    return sanitize(user);
  },

  async getUserById(id: string): Promise<UserWithoutPassword> {
    const user = await userRepository.findById(id);
    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);
    return sanitize(user);
  },

  async updateUser(id: string, input: UpdateUserInput): Promise<UserWithoutPassword> {
    const user = await userRepository.findById(id);
    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);

    if (input.email && input.email !== user.email) {
      const existing = await userRepository.findByEmail(input.email);
      if (existing) throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);
    }

    const updated = await userRepository.update(id, input);
    return sanitize(updated);
  },

  async deleteUser(id: string): Promise<UserWithoutPassword> {
    const user = await userRepository.findById(id);
    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);
    const deleted = await userRepository.delete(id);
    return sanitize(deleted);
  },

  async listUsers(query: ListUsersQuery): Promise<PaginatedResponse<PublicUser>> {
    const { users, total } = await userRepository.findAll(query.page, query.limit, {
      role: query.role,
      isNotRole: query.isNotRole,
    });
    return {
      data: users.map(sanitizePublic),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  },

  async resetUserPassword(id: string, password: string): Promise<UserWithoutPassword> {
    const user = await userRepository.findById(id);
    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);

    const passwordHash = hashPassword(password);
    const updated = await userRepository.resetPassword(id, passwordHash);
    return sanitize(updated);
  },

  async listCustomers() {
    const customers = await db.parentAccount.findMany({
      include: {
        profiles: true,
        // Enrolments travel with the student so the admin can see which child is
        // on which programme without a request per row.
        students: { include: { enrollments: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return customers;
  },

  /**
   * Every programme a child is signed up to, with the payment state that
   * actually governs them.
   *
   * Enrolment wins where one exists. Where it does not, this falls back to the
   * old one-programme-per-family columns, so a household created before
   * enrolments existed keeps exactly the access it had. The fallback is
   * deliberate: a reader that silently resolved to "unpaid" would lock a child
   * out of classes their family has already paid for, which is the failure this
   * whole model change exists to stop.
   *
   * The fallback can be dropped once every parent with a `programId` has been
   * backfilled and no new writes touch the old columns.
   */
  async effectiveEnrollments(studentId: string) {
    const student = await db.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        paymentApproved: true,
        parentAccountId: true,
        parentAccount: {
          select: {
            programId: true,
            paymentApproved: true,
            selectedPlanType: true,
            paidInstallmentIds: true,
          },
        },
        enrollments: {
          select: {
            id: true,
            programId: true,
            paymentApproved: true,
            selectedPlanType: true,
            paidInstallmentIds: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!student) return [];

    if (student.enrollments.length > 0) {
      return student.enrollments.map((e) => ({ ...e, source: 'ENROLLMENT' as const }));
    }

    const legacyProgramId = student.parentAccount?.programId;
    if (!legacyProgramId) return [];

    /* The legacy columns describe ONE child, so only one may inherit them.
     *
     * `ParentAccount.programId` and `.paymentApproved` were written when a
     * family could hold exactly one programme, which by definition was the
     * child who was enrolled at the time — the eldest record. Letting every
     * sibling fall back to them meant a second child added to a paying family
     * appeared enrolled AND paid the moment they were created, with nobody
     * having chosen a programme or taken any money for them.
     *
     * The eldest keeps the access the family paid for; a later sibling gets
     * nothing until someone enrols them explicitly. */
    const eldest = await db.student.findFirst({
      where: { parentAccountId: student.parentAccountId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (eldest && eldest.id !== student.id) return [];

    return [
      {
        id: `legacy:${student.id}:${legacyProgramId}`,
        programId: legacyProgramId,
        // Either tier could hold the approval before enrolments: the parent on a
        // FULL plan, the student individually on instalments.
        paymentApproved: Boolean(student.parentAccount?.paymentApproved || student.paymentApproved),
        selectedPlanType: student.parentAccount?.selectedPlanType ?? null,
        paidInstallmentIds: student.parentAccount?.paidInstallmentIds ?? [],
        createdAt: new Date(0),
        source: 'LEGACY' as const,
      },
    ];
  },

  /**
   * Sign a child up to another programme.
   *
   * Idempotent by the `(studentId, programId)` unique constraint — a
   * double-submit returns the existing enrolment rather than a duplicate or a
   * 500. New enrolments always start unpaid: money is Finance's decision, and
   * an enrolment that arrived pre-approved would let anyone with access to this
   * screen grant free classes.
   */
  async addEnrollment(parentId: string, input: { studentId: string; programId: string }) {
    const studentId = String(input?.studentId ?? '').trim();
    const programId = String(input?.programId ?? '').trim();
    if (!studentId || !programId) {
      throw new AppError('A student and a programme are both required', HTTP_STATUS.BAD_REQUEST);
    }

    // The child must belong to this parent. Without this a caller could enrol
    // any student on the platform by guessing an id.
    const student = await db.student.findFirst({
      where: { id: studentId, parentAccountId: parentId },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!student) {
      throw new AppError('That student does not belong to this parent account', HTTP_STATUS.NOT_FOUND);
    }

    const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, title: true } });
    if (!program) throw new AppError('Program not found', HTTP_STATUS.NOT_FOUND);

    const existing = await db.enrollment.findUnique({
      where: { studentId_programId: { studentId, programId } },
    });
    if (existing) return existing;

    return db.enrollment.create({
      data: { studentId, programId, paymentApproved: false },
    });
  },

  /**
   * Payment state for one enrolment. This is Finance's write.
   */
  async updateEnrollment(
    enrollmentId: string,
    input: { paymentApproved?: boolean; selectedPlanType?: string | null; paidInstallmentIds?: string[] }
  ) {
    const existing = await db.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!existing) throw new AppError('Enrollment not found', HTTP_STATUS.NOT_FOUND);

    return db.enrollment.update({
      where: { id: enrollmentId },
      data: {
        paymentApproved: input.paymentApproved !== undefined ? input.paymentApproved : undefined,
        selectedPlanType: input.selectedPlanType !== undefined ? input.selectedPlanType : undefined,
        paidInstallmentIds: input.paidInstallmentIds !== undefined ? input.paidInstallmentIds : undefined,
      },
    });
  },

  /**
   * Remove an enrolment.
   *
   * Refused once it has been paid for or has classes on the timetable — the
   * same reasoning as the programme lock on a parent account. Deleting it would
   * orphan scheduled classes against a programme the child is no longer on, and
   * silently discard a payment.
   */
  async removeEnrollment(enrollmentId: string) {
    const existing = await db.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!existing) throw new AppError('Enrollment not found', HTTP_STATUS.NOT_FOUND);

    if (existing.paymentApproved) {
      throw new AppError(
        'This programme has been paid for and cannot be removed. Withdraw the payment approval in Finance first.',
        HTTP_STATUS.CONFLICT
      );
    }

    const scheduled = await db.scheduledClass.count({
      where: { studentId: existing.studentId, programId: existing.programId, status: { not: 'CANCELLED' } },
    });
    if (scheduled > 0) {
      throw new AppError(
        `This programme already has ${scheduled} class${scheduled === 1 ? '' : 'es'} scheduled. Cancel them before removing it.`,
        HTTP_STATUS.CONFLICT
      );
    }

    await db.enrollment.delete({ where: { id: enrollmentId } });
    return { id: enrollmentId };
  },

  async getCustomerById(id: string) {
    const parent = await db.parentAccount.findUnique({
      where: { id },
      include: {
        profiles: true,
        students: true,
      },
    });
    if (!parent) throw new AppError('Customer not found', HTTP_STATUS.NOT_FOUND);
    return parent;
  },

  async createCustomer(input: any) {
    const existing = await db.user.findUnique({ where: { email: input.email } });
    if (existing) throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);

    const existingParent = await db.parentAccount.findUnique({
      where: { email: input.email },
      include: {
        profiles: true,
        students: true,
      },
    });
    if (existingParent) return existingParent;

    const existingStudent = await db.student.findUnique({ where: { email: input.email } });
    if (existingStudent) throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);

    const passwordHash = hashPassword(input.password);
    const parentAccount = await db.parentAccount.create({
      data: {
        email: input.email,
        passwordHash,
        programId: input.programId || null,
        requiresFtlReset: true,
        profiles: {
          createMany: {
            data: input.profiles || [],
          },
        },
      },
      include: {
        profiles: true,
        students: true,
      },
    });
    return parentAccount;
  },

  async deleteCustomer(id: string) {
    const parent = await db.parentAccount.findUnique({ where: { id } });
    if (!parent) throw new AppError('Customer not found', HTTP_STATUS.NOT_FOUND);

    await db.parentAccount.delete({ where: { id } });
    return { id };
  },

  async createStudentForParent(parentId: string, input: any) {
    const parent = await db.parentAccount.findUnique({ where: { id: parentId } });
    if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);

    const existing = await db.user.findUnique({
      where: { email: input.email },
      include: { role: true },
    });
    if (existing) {
      if (existing.role && existing.role.name === 'STUDENT') {
        // Delete legacy student user profile from the User table to avoid duplicate keys conflict
        await db.user.delete({ where: { id: existing.id } });
      } else {
        throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);
      }
    }

    const existingParent = await db.parentAccount.findUnique({ where: { email: input.email } });
    if (existingParent) throw new AppError('Email already in use', HTTP_STATUS.CONFLICT);

    const existingStudent = await db.student.findUnique({ where: { email: input.email } });
    if (existingStudent) {
      return existingStudent;
    }

    const passwordHash = hashPassword(input.password);
    const normalizedEmail = input.email.toLowerCase().trim();

    // Check if this is the first student profile for this parent
    const studentCount = await db.student.count({
      where: { parentAccountId: parentId }
    });

    const isFirstStudent = studentCount === 0;
    const isParentPaid = !!parent.paymentApproved;

    // Generate unique 4-digit student code (e.g. STU-0001)
    const totalCount = await db.student.count();
    let nextNum = totalCount + 1;
    let studentCode = `STU-${String(nextNum).padStart(4, '0')}`;
    while (await db.student.findUnique({ where: { studentCode } })) {
      nextNum++;
      studentCode = `STU-${String(nextNum).padStart(4, '0')}`;
    }

    const student = await db.student.create({
      data: {
        parentAccountId: parentId,
        studentCode,
        email: normalizedEmail,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        // Only the first child can inherit the family's legacy approval — the
        // old columns describe one enrolment. A sibling starts unpaid and is
        // approved per programme in Finance.
        paymentApproved: isParentPaid && isFirstStudent,
        requiresFtlReset: true,
      },
    });

    /* Programme chosen on the Add Student form.
     *
     * Written as a real Enrollment, always UNPAID: enrolling a child and
     * paying for them are two decisions, and money is Finance's to record.
     * Creating it here (rather than leaving the child with none) is also what
     * keeps them off the legacy fallback — a child with no enrolment row used
     * to read the parent's programme and paid flag and appear to be enrolled
     * in something nobody bought for them. */
    const programId = typeof input.programId === 'string' ? input.programId.trim() : '';
    if (programId) {
      const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, title: true } });
      if (!program) throw new AppError('Program not found', HTTP_STATUS.NOT_FOUND);

      await db.enrollment.create({
        data: { studentId: student.id, programId, paymentApproved: false },
      });
      logger.info(
        `[Student] ${normalizedEmail} enrolled in "${program.title}" as UNPAID — awaiting approval in Finance.`
      );
    }

    return student;
  },

  async listAllStudents() {
    let students = await db.student.findMany({
      include: {
        parentAccount: {
          select: {
            id: true,
            email: true,
            programId: true,
            paymentApproved: true,
            selectedPlanType: true,
            paidInstallmentIds: true,
            profiles: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phone: true,
                relationship: true,
              },
            },
          },
        },
        // Payment is per programme now, so the portal needs all of them to know
        // which classes to unlock. The parent fields above stay for households
        // that predate enrolments.
        enrollments: {
          select: {
            id: true,
            programId: true,
            paymentApproved: true,
            selectedPlanType: true,
            paidInstallmentIds: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Auto-assign studentCode to existing students who don't have one yet
    for (let i = 0; i < students.length; i++) {
      if (!students[i].studentCode) {
        const assignedCode = `STU-${String(i + 1).padStart(4, '0')}`;
        try {
          const updated = await db.student.update({
            where: { id: students[i].id },
            data: { studentCode: assignedCode },
          });
          students[i].studentCode = updated.studentCode;
        } catch {
          // If collision occurs, find next available number
          let num = i + 1;
          let candidate = `STU-${String(num).padStart(4, '0')}`;
          while (await db.student.findUnique({ where: { studentCode: candidate } })) {
            num++;
            candidate = `STU-${String(num).padStart(4, '0')}`;
          }
          const updated = await db.student.update({
            where: { id: students[i].id },
            data: { studentCode: candidate },
          });
          students[i].studentCode = updated.studentCode;
        }
      }
    }

    // Sort descending by createdAt for display
    return students.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  async deleteStudent(id: string) {
    const student = await db.student.findUnique({ where: { id } });
    if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);

    await db.student.delete({ where: { id } });
    return { id };
  },

  async createParentProfile(parentId: string, input: any) {
    const parent = await db.parentAccount.findUnique({
      where: { id: parentId },
      include: { profiles: true }
    });
    if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);

    if (parent.profiles.length >= 2) {
      throw new AppError('Parent account already has 2 profiles maximum', HTTP_STATUS.BAD_REQUEST);
    }

    const profile = await db.parentProfile.create({
      data: {
        parentAccountId: parentId,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone || null,
        relationship: input.relationship
      }
    });
    return profile;
  },

  async resetParentPassword(parentId: string, passwordHashRaw: string) {
    const parent = await db.parentAccount.findUnique({ where: { id: parentId } });
    if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);

    const passwordHash = hashPassword(passwordHashRaw);
    return await db.parentAccount.update({
      where: { id: parentId },
      data: { passwordHash }
    });
  },

  async updateParentAccount(parentId: string, input: any) {
    const parent = await db.parentAccount.findUnique({ where: { id: parentId } });
    if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);

    if (input.email && input.email !== parent.email) {
      const existing = await db.parentAccount.findUnique({ where: { email: input.email } });
      if (existing) throw new AppError('Email already in use by another parent account', HTTP_STATUS.CONFLICT);
    }

    // A paid programme cannot be swapped for a different one.
    //
    // The old behaviour silently reset `paymentApproved` to false on a programme
    // change, which stranded the family: their classes were already scheduled
    // against the programme they had paid for, and the student portal went to
    // "Sessions locked — no payment approved" with nothing they could do about
    // it. The edit looked harmless and revoked access to something already
    // bought.
    //
    // The programme is what was purchased. Moving to another one is a refund and
    // re-enrolment decision, not a field edit — so it is refused here rather
    // than quietly voiding the payment. An admin who genuinely needs to switch a
    // family withdraws the payment approval first, which makes that the
    // deliberate act it should be.
    const programChanging =
      input.programId !== undefined && (input.programId || null) !== (parent.programId || null);

    if (programChanging) {
      // Either tier can hold the approval: the parent pays for a FULL plan, but a
      // student can be approved individually on an instalment plan.
      const paidStudents = await db.student.count({
        where: { parentAccountId: parentId, paymentApproved: true },
      });

      if (parent.paymentApproved || paidStudents > 0) {
        throw new AppError(
          'This family has already paid for their current programme, so it cannot be changed. ' +
            'Withdraw the payment approval first if they are genuinely moving to another programme.',
          HTTP_STATUS.CONFLICT
        );
      }
    }

    const dataToUpdate: any = {
      email: input.email || undefined,
      isActive: input.isActive !== undefined ? input.isActive : undefined,
      programId: input.programId !== undefined ? input.programId : undefined,
      paymentApproved: input.paymentApproved !== undefined ? input.paymentApproved : undefined,
      selectedPlanType: input.selectedPlanType !== undefined ? input.selectedPlanType : undefined,
      paidInstallmentIds: input.paidInstallmentIds !== undefined ? input.paidInstallmentIds : undefined,
      // Empty string clears the photo; undefined leaves it untouched.
      avatarUrl: input.avatarUrl !== undefined ? input.avatarUrl || null : undefined,
    };

    // Unpaid families can still be moved — nothing has been bought yet — but the
    // approval flag is cleared so the new programme starts from a clean state.
    if (programChanging && input.paymentApproved === undefined) {
      dataToUpdate.paymentApproved = false;
    }

    return await db.parentAccount.update({
      where: { id: parentId },
      data: dataToUpdate
    });
  },

  async updateParentProfile(profileId: string, input: any) {
    const profile = await db.parentProfile.findUnique({ where: { id: profileId } });
    if (!profile) throw new AppError('Parent profile not found', HTTP_STATUS.NOT_FOUND);

    return await db.parentProfile.update({
      where: { id: profileId },
      data: {
        firstName: input.firstName || undefined,
        lastName: input.lastName || undefined,
        phone: input.phone !== undefined ? input.phone : undefined,
        relationship: input.relationship || undefined
      }
    });
  },

  async resetStudentPassword(studentId: string, passwordHashRaw: string) {
    const student = await db.student.findUnique({ where: { id: studentId } });
    if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);

    const passwordHash = hashPassword(passwordHashRaw);
    return await db.student.update({
      where: { id: studentId },
      data: { passwordHash }
    });
  },

  /**
   * Look up a single student by id.
   *
   * Students live in their own table, not in `User`, so `GET /users/:id` 404s for
   * a studentId. Callers that only had that route silently fell back to whatever
   * default they carried — which is how the placeholder name "Zoha" ended up
   * printed in real AI class summaries.
   */
  async getStudentById(studentId: string) {
    const student = await db.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        studentCode: true,
        firstName: true,
        lastName: true,
        email: true,
        avatarUrl: true,
        isActive: true,
        timezone: true,
        credits: true,
      },
    });
    if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);
    return student;
  },

  async updateStudent(studentId: string, input: any) {
    const student = await db.student.findUnique({ where: { id: studentId } });
    if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);

    /* Only these three mean anything. An unrecognised value would otherwise
     * be stored and then silently match no dashboard bucket, which is how a
     * child disappears from every count at once. */
    const ALLOWED_STATUS = ['ACTIVE', 'DROPPED', 'COMPLETED'];
    const nextStatus =
      input.status !== undefined && input.status !== null
        ? String(input.status).toUpperCase()
        : null;
    if (nextStatus && !ALLOWED_STATUS.includes(nextStatus)) {
      throw new AppError(
        `"${input.status}" is not a student status. Use one of: ${ALLOWED_STATUS.join(', ')}.`,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    if (input.email && input.email !== student.email) {
      const existing = await db.student.findUnique({ where: { email: input.email } });
      if (existing) throw new AppError('Email already in use by another student account', HTTP_STATUS.CONFLICT);
    }

    return await db.student.update({
      where: { id: studentId },
      data: {
        firstName: input.firstName || undefined,
        lastName: input.lastName || undefined,
        email: input.email || undefined,
        isActive: input.isActive !== undefined ? input.isActive : undefined,
        paymentApproved: input.paymentApproved !== undefined ? input.paymentApproved : undefined,
        credits: input.credits !== undefined ? Number(input.credits) : undefined,
        timezone: input.timezone || undefined,
        // Empty string clears the photo; undefined leaves it untouched.
        avatarUrl: input.avatarUrl !== undefined ? input.avatarUrl || null : undefined,

        /* Enrolment state, and the note that explains it.
         *
         * Deliberately separate from `isActive`: a child who leaves the
         * programme keeps their login, their class history and the reports
         * their family already received. Disabling the account instead would
         * take all of that away to record a fact about attendance.
         *
         * `statusChangedAt` is only moved when the status actually changes,
         * so it answers "when did they drop" rather than "when was this row
         * last saved". */
        ...(nextStatus
          ? {
              status: nextStatus,
              ...(nextStatus !== student.status ? { statusChangedAt: new Date() } : {}),
            }
          : {}),
        statusNote: input.statusNote !== undefined ? input.statusNote || null : undefined,
      }
    });
  },

  // ── Mentor Schedule ────────────────────────────────────────────────────────

  async getMentorSchedules(mentorId: string) {
    const mentor = await db.user.findUnique({ where: { id: mentorId } });
    if (!mentor) throw new AppError('Mentor not found', HTTP_STATUS.NOT_FOUND);

    return db.mentorSchedule.findMany({
      where: { mentorId },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });
  },

  /**
   * Add one weekly availability slot.
   *
   * `endTime` is a SUGGESTION, not a rule. The caller may send its own — the
   * UI prefills start + SLOT_DURATION_MINUTES and lets the mentor change it,
   * because a slot is a declaration of when someone is free, and real
   * availability does not come in one fixed length.
   *
   * A conflict is likewise a warning rather than a wall: `allowConflict` lets
   * the caller commit an overlapping slot on purpose. Overlaps are legitimate
   * — the same hour can be offered as both a REGULAR and a DEMO slot, and only
   * one of them will ever be booked. Refusing outright meant the mentor had no
   * way to say so.
   */
  async addMentorSchedule(
    mentorId: string,
    input: {
      weekday: number;
      startTime: string;
      /** Optional override. Omitted → start + SLOT_DURATION_MINUTES. */
      endTime?: string;
      scheduleType?: string;
      /** Commit the slot even though it overlaps an existing one. */
      allowConflict?: boolean;
    },
    caller?: { id?: string; role?: string }
  ) {
    assertOwnSlotIfTeacher(mentorId, caller);

    const mentor = await db.user.findUnique({ where: { id: mentorId } });
    if (!mentor) throw new AppError('Mentor not found', HTTP_STATUS.NOT_FOUND);

    const { weekday, startTime, scheduleType = 'REGULAR', allowConflict = false } = input;
    if (!['REGULAR', 'DEMO'].includes(scheduleType)) {
      throw new AppError('Invalid scheduleType. Must be REGULAR or DEMO', HTTP_STATUS.BAD_REQUEST);
    }

    const startMinutes = parseHHMM(startTime);
    if (startMinutes === null) {
      throw new AppError('Invalid startTime format. Use HH:MM (24-hr)', HTTP_STATUS.BAD_REQUEST);
    }

    // The default length; the caller overrides it by sending endTime.
    let endMinutes = startMinutes + SLOT_DURATION_MINUTES;

    if (input.endTime !== undefined && String(input.endTime).trim() !== '') {
      const parsed = parseHHMM(String(input.endTime));
      if (parsed === null) {
        throw new AppError('Invalid endTime format. Use HH:MM (24-hr)', HTTP_STATUS.BAD_REQUEST);
      }
      if (parsed <= startMinutes) {
        throw new AppError('End time must be later than the start time', HTTP_STATUS.BAD_REQUEST);
      }
      endMinutes = parsed;
    }

    if (endMinutes > 24 * 60) {
      throw new AppError('Time slot exceeds midnight — choose an earlier start time', HTTP_STATUS.BAD_REQUEST);
    }

    const endTime = formatHHMM(endMinutes);

    // Conflict check: any existing slot on same weekday that overlaps [startMinutes, endMinutes)
    const existingSlots = await db.mentorSchedule.findMany({ where: { mentorId, weekday } });

    for (const slot of existingSlots) {
      const existStart = parseHHMM(slot.startTime);
      const existEnd = parseHHMM(slot.endTime);
      if (existStart === null || existEnd === null) continue;

      // Overlap if new start < existEnd AND new end > existStart
      if (startMinutes < existEnd && endMinutes > existStart) {
        const typeStr = slot.scheduleType.toLowerCase();
        const detail = `overlaps existing ${typeStr} slot ${slot.startTime}–${slot.endTime} on this day`;

        if (!allowConflict) {
          // 409 is the frontend's cue to show the warning plus its
          // "add anyway" button, which retries with allowConflict.
          throw new AppError(`Conflict: ${detail}`, HTTP_STATUS.CONFLICT);
        }

        logger.warn(
          `[Mentor Schedule] Overlapping slot accepted on purpose for mentor ${mentorId}: ` +
            `${startTime}–${endTime} ${detail}.`
        );
        break;
      }
    }

    return db.mentorSchedule.create({
      data: { mentorId, weekday, startTime, endTime, scheduleType },
    });
  },

  async deleteMentorSchedule(scheduleId: string, caller?: { id?: string; role?: string }) {
    const slot = await db.mentorSchedule.findUnique({ where: { id: scheduleId } });
    if (!slot) throw new AppError('Schedule slot not found', HTTP_STATUS.NOT_FOUND);
    assertOwnSlotIfTeacher(slot.mentorId, caller);
    await db.mentorSchedule.delete({ where: { id: scheduleId } });
    return { id: scheduleId };
  },

  // ── Mentor Availability ────────────────────────────────────────────────────
  // A mentor declares *how* they are available; the weekly MentorSchedule rows
  // say *when*. FLEXIBLE means "book me any slot" and makes the weekly grid
  // advisory rather than binding, which is why the two are stored separately.

  async getMentorAvailability(mentorId: string) {
    const mentor = await db.user.findUnique({
      where: { id: mentorId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        timezone: true,
        availabilityMode: true,
        availabilityNote: true,
        availabilityUpdatedAt: true,
      },
    });
    if (!mentor) throw new AppError('Mentor not found', HTTP_STATUS.NOT_FOUND);

    const slots = await db.mentorSchedule.findMany({
      where: { mentorId },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });

    return { ...mentor, slots };
  },

  async updateMentorAvailability(
    mentorId: string,
    input: { availabilityMode?: string; availabilityNote?: string | null },
    caller: { id?: string; role?: string }
  ) {
    // A mentor edits only their own availability; staff may edit anyone's.
    const isStaff = caller.role === 'ADMIN' || caller.role === 'SCHEDULER';
    if (!isStaff) {
      if (!caller.id) throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      if (caller.id !== mentorId) {
        throw new AppError('You can only update your own availability', HTTP_STATUS.FORBIDDEN);
      }
    }

    const mentor = await db.user.findUnique({ where: { id: mentorId }, select: { id: true } });
    if (!mentor) throw new AppError('Mentor not found', HTTP_STATUS.NOT_FOUND);

    const data: any = { availabilityUpdatedAt: new Date() };

    if (input.availabilityMode !== undefined) {
      if (!MENTOR_AVAILABILITY_MODES.includes(input.availabilityMode)) {
        throw new AppError(
          `availabilityMode must be one of: ${MENTOR_AVAILABILITY_MODES.join(', ')}`,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      data.availabilityMode = input.availabilityMode;
    }

    if (input.availabilityNote !== undefined) {
      const note = typeof input.availabilityNote === 'string' ? input.availabilityNote.trim() : '';
      if (note.length > 500) {
        throw new AppError('Availability note must be 500 characters or fewer', HTTP_STATUS.BAD_REQUEST);
      }
      data.availabilityNote = note || null;
    }

    await db.user.update({ where: { id: mentorId }, data });
    return this.getMentorAvailability(mentorId);
  },

  async warnUser(targetId: string, targetRole: string, reason: string) {
    const logEntry = `[Warning] ${new Date().toISOString()}: ${reason}`;
    await sendNotification(targetId, 'Formal Disciplinary Warning', `A formal warning has been logged against your account: "${reason}"`, 'HIGH');

    if (targetRole === 'TEACHER' || targetRole === 'ADMIN' || targetRole === 'MENTOR') {
      const user = await db.user.findUnique({ where: { id: targetId } });
      if (!user) throw new AppError('Mentor/User not found', HTTP_STATUS.NOT_FOUND);
      return db.user.update({
        where: { id: targetId },
        data: {
          warningCount: { increment: 1 },
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'PARENT') {
      const parent = await db.parentAccount.findUnique({ where: { id: targetId } });
      if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);
      return db.parentAccount.update({
        where: { id: targetId },
        data: {
          warningCount: { increment: 1 },
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'STUDENT') {
      const student = await db.student.findUnique({ where: { id: targetId } });
      if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);
      return db.student.update({
        where: { id: targetId },
        data: {
          warningCount: { increment: 1 },
          warnings: { push: logEntry },
        },
      });
    } else {
      throw new AppError('Invalid target role', HTTP_STATUS.BAD_REQUEST);
    }
  },

  async blacklistUser(targetId: string, targetRole: string, reason: string) {
    const logEntry = `[Blacklisted] ${new Date().toISOString()}: ${reason}`;
    await sendNotification(targetId, 'Account Deactivated', `Your account has been deactivated: "${reason}"`, 'HIGH');

    if (targetRole === 'TEACHER' || targetRole === 'ADMIN' || targetRole === 'MENTOR') {
      const user = await db.user.findUnique({ where: { id: targetId } });
      if (!user) throw new AppError('Mentor/User not found', HTTP_STATUS.NOT_FOUND);
      
      // Revoke refresh tokens
      await db.refreshToken.deleteMany({ where: { userId: targetId } });
      
      return db.user.update({
        where: { id: targetId },
        data: {
          isActive: false,
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'PARENT') {
      const parent = await db.parentAccount.findUnique({ where: { id: targetId } });
      if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);
      
      // Revoke refresh tokens
      await db.refreshToken.deleteMany({ where: { parentAccountId: targetId } });
      
      return db.parentAccount.update({
        where: { id: targetId },
        data: {
          isActive: false,
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'STUDENT') {
      const student = await db.student.findUnique({ where: { id: targetId } });
      if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);
      
      // Revoke refresh tokens
      await db.refreshToken.deleteMany({ where: { studentId: targetId } });
      
      return db.student.update({
        where: { id: targetId },
        data: {
          isActive: false,
          warnings: { push: logEntry },
        },
      });
    } else {
      throw new AppError('Invalid target role', HTTP_STATUS.BAD_REQUEST);
    }
  },

  async unblacklistUser(targetId: string, targetRole: string) {
    const logEntry = `[Unblacklisted] ${new Date().toISOString()}`;
    await sendNotification(targetId, 'Account Reactivated', 'Your account access has been fully reinstated by the QA Auditor.', 'HIGH');

    if (targetRole === 'TEACHER' || targetRole === 'ADMIN' || targetRole === 'MENTOR') {
      const user = await db.user.findUnique({ where: { id: targetId } });
      if (!user) throw new AppError('Mentor/User not found', HTTP_STATUS.NOT_FOUND);
      return db.user.update({
        where: { id: targetId },
        data: {
          isActive: true,
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'PARENT') {
      const parent = await db.parentAccount.findUnique({ where: { id: targetId } });
      if (!parent) throw new AppError('Parent account not found', HTTP_STATUS.NOT_FOUND);
      return db.parentAccount.update({
        where: { id: targetId },
        data: {
          isActive: true,
          warnings: { push: logEntry },
        },
      });
    } else if (targetRole === 'STUDENT') {
      const student = await db.student.findUnique({ where: { id: targetId } });
      if (!student) throw new AppError('Student not found', HTTP_STATUS.NOT_FOUND);
      return db.student.update({
        where: { id: targetId },
        data: {
          isActive: true,
          warnings: { push: logEntry },
        },
      });
    } else {
      throw new AppError('Invalid target role', HTTP_STATUS.BAD_REQUEST);
    }
  },

  async getUserQAInfo(targetId: string, targetRole: string) {
    if (targetRole === 'TEACHER' || targetRole === 'ADMIN' || targetRole === 'MENTOR') {
      const user = await db.user.findUnique({ where: { id: targetId } });
      if (!user) return null;
      return {
        id: user.id,
        isActive: user.isActive,
        warningCount: user.warningCount,
        warnings: user.warnings,
      };
    } else if (targetRole === 'PARENT') {
      const parent = await db.parentAccount.findUnique({
        where: { id: targetId },
        include: { profiles: true }
      });
      if (!parent) return null;
      const name = parent.profiles[0] 
        ? `${parent.profiles[0].firstName} ${parent.profiles[0].lastName}` 
        : parent.email;
      return {
        id: parent.id,
        isActive: parent.isActive,
        warningCount: parent.warningCount,
        warnings: parent.warnings,
        name,
      };
    } else if (targetRole === 'STUDENT') {
      const student = await db.student.findUnique({ where: { id: targetId } });
      if (!student) return null;
      return {
        id: student.id,
        isActive: student.isActive,
        warningCount: student.warningCount,
        warnings: student.warnings,
      };
    }
    return null;
  },
};