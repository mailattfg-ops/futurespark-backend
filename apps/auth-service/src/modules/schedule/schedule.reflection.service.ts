/**
 * schedule.reflection.service.ts
 *
 * Post-class reflection, quiz, and raw-transcript methods extracted from
 * schedule.service.ts.  Exported as eflectionService so controllers can
 * continue to reach them under the same import pattern.
 */

import { db } from '../../database/datasource';
import { AppError } from '@futurespark/middleware';
import {
  HTTP_STATUS,
  effectiveReflectionQuestions,
  effectiveReflectionQuiz,
  effectiveSessionTopics,
  snapshotReflection,
  DEFAULT_REFLECTION_POINTS,
  applyMentorMarks,
  mentorAwardedTotal,
  deriveAttendance,
  owesReflection,
  canSeeAnswerKey,
  stripAnswerKey,
  ReflectionResponse,
  ReflectionMentorMark,
  ReflectionAnswerEntry,
} from '@futurespark/constants';
import { logger } from '@futurespark/logger';
import { sendNotification } from '../notification-helper';
import {
  isMentorRole,
  isClassAuditorRole,
  assertClassAccess,
  REPORT_CLASS_SELECT,
  type ReflectionEntry,
} from './schedule.helpers';

export const reflectionService = {
  // ── Post-class reflection ───────────────────────────────────────────────────

  /**
   * The mentor fires the quiz DURING the session. The student portal polls
   * quiz status and pops the quiz up when it sees the stamp, so mentor and
   * student can go through it together on the call. Relaunching restamps —
   * the student portal keys its popup on the timestamp, so a fresh stamp
   * pops the quiz again for a student who closed it.
   */
  async launchQuiz(classId: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: { id: true, mentorId: true, status: true, reflectionSubmittedAt: true },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // Only this class's mentor, or an admin — a launch makes a modal appear on
    // a child's screen, so it is not a thing any authenticated caller may do.
    const role = (callerRole ?? '').toUpperCase();
    if (!(role === 'ADMIN' || (isMentorRole(role) && scheduledClass.mentorId === callerId))) {
      throw new AppError('Only the class mentor or an admin can launch the quiz.', HTTP_STATUS.FORBIDDEN);
    }
    if (scheduledClass.reflectionSubmittedAt) {
      throw new AppError('The student has already submitted this quiz.', HTTP_STATUS.BAD_REQUEST);
    }
    if (scheduledClass.status === 'CANCELLED') {
      throw new AppError('This class was cancelled.', HTTP_STATUS.BAD_REQUEST);
    }

    const updated = await db.scheduledClass.update({
      where: { id: classId },
      data: { quizLaunchedAt: new Date() },
      select: { quizLaunchedAt: true },
    });
    return { launchedAt: updated.quizLaunchedAt };
  },

  /**
   * The RAW transcript the summary was generated from — for verifying what the
   * pipeline actually heard when a report looks wrong. Mentor-of-class or
   * admin only: it is a verbatim record of a child's session.
   */
  async getRawTranscript(classId: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: { id: true, mentorId: true, transcript: true, transcriptionStatus: true, updatedAt: true },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }
    const role = (callerRole ?? '').toUpperCase();
    if (!(role === 'ADMIN' || (isMentorRole(role) && scheduledClass.mentorId === callerId))) {
      throw new AppError('Only the class mentor or an admin can read the raw transcript.', HTTP_STATUS.FORBIDDEN);
    }
    return {
      transcript: scheduledClass.transcript ?? null,
      length: scheduledClass.transcript?.length ?? 0,
      transcriptionStatus: scheduledClass.transcriptionStatus,
    };
  },

  /**
   * Lightweight poll target: has the quiz been launched, and has the student
   * submitted? Polled every few seconds by the student portal during a live
   * class and by the mentor's panel after a launch, so it reads one row and
   * nothing else.
   */
  async getQuizStatus(classId: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        studentId: true,
        mentorId: true,
        quizLaunchedAt: true,
        reflectionSubmittedAt: true,
        reflectionScore: true,
        reflectionMaxScore: true,
        reflectionBadge: true,
        student: { select: { parentAccountId: true } },
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }
    assertClassAccess(scheduledClass as any, callerId, callerRole);

    return {
      launched: Boolean(scheduledClass.quizLaunchedAt),
      launchedAt: scheduledClass.quizLaunchedAt,
      submitted: Boolean(scheduledClass.reflectionSubmittedAt),
      submittedAt: scheduledClass.reflectionSubmittedAt,
      score: scheduledClass.reflectionScore,
      maxScore: scheduledClass.reflectionMaxScore,
      badge: scheduledClass.reflectionBadge,
    };
  },

  /**
   * The quiz a student must answer for a given class, plus whatever they have
   * already submitted. Questions come from the curriculum session; a session
   * with no custom quiz falls back to its text prompts, then to the platform
   * defaults, so there is always something to answer.
   */
  async getReflection(classId: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        studentId: true,
        mentorId: true,
        sessionId: true,
        status: true,
        startTime: true,
        endTime: true,
        reflectionAnswers: true,
        reflectionSubmittedAt: true,
        reflectionScore: true,
        reflectionMaxScore: true,
        reflectionBadge: true,
        reflectionReviewedAt: true,
        reflectionReviewedById: true,
        reflectionMentorNote: true,
        student: { select: { parentAccountId: true } },
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // The same three-way ownership test `listDoubts` runs. Two separate things
    // ride on it: `answers` holds the child's free text, and — for a caller who
    // clears `canSeeAnswerKey` below — the payload carries the marking scheme
    // for a quiz other children have not sat yet. It also carries the mentor's
    // per-answer points and remarks about this one child.
    assertClassAccess(scheduledClass, callerId, callerRole);

    const session = scheduledClass.sessionId
      ? await db.session.findUnique({
          where: { id: scheduledClass.sessionId },
          select: { title: true, order: true, reflectionQuestions: true, reflectionQuiz: true, topics: true },
        })
      : null;

    const quiz = effectiveReflectionQuiz(session?.reflectionQuiz, session?.reflectionQuestions);

    return {
      classId: scheduledClass.id,
      studentId: scheduledClass.studentId,
      sessionId: scheduledClass.sessionId,
      sessionTitle: session?.title ?? null,
      sessionOrder: session?.order ?? null,
      // `questions` keeps the plain-string shape older clients read; `quiz`
      // carries the typed version with images, options and points.
      //
      // The answer key used to be stripped unconditionally, on the grounds that
      // reviewers read the graded answers instead — but nothing is graded at
      // submit any more, so the mentor marking an MCQ has no other way to know
      // which option was intended and cannot mark it fairly. `canSeeAnswerKey`
      // is the shared rule: staff and mentors keep the key, the student sitting
      // the quiz and their parent still get it stripped. The ownership gate
      // above already refused everyone who was not in this room.
      questions: effectiveReflectionQuestions(session?.reflectionQuestions ?? null),
      quiz: canSeeAnswerKey(callerRole) ? quiz : stripAnswerKey(quiz),
      // Each entry carries the mentor's award and remark for that answer once
      // they have marked it, which is how the student is shown *why* they got
      // the points. Never the answer key — see `ReflectionAnswerEntry`.
      answers: (scheduledClass.reflectionAnswers as ReflectionEntry[] | null) ?? null,
      submittedAt: scheduledClass.reflectionSubmittedAt,
      // Null until a mentor marks the quiz. Submitting scores nothing, so
      // "submitted, waiting for your mentor" is submittedAt set with these null.
      score: scheduledClass.reflectionScore,
      maxScore: scheduledClass.reflectionMaxScore,
      badge: scheduledClass.reflectionBadge,
      awaitingReview: Boolean(scheduledClass.reflectionSubmittedAt && !scheduledClass.reflectionReviewedAt),
      // The mentor's sign-off, and the reply they wrote to what the student
      // said. `reviewReflection` has always stored these, but until now no
      // student-facing endpoint returned them, so the note was written and
      // never delivered — the notification promised a reply the student had
      // nowhere to read.
      reviewedAt: scheduledClass.reflectionReviewedAt,
      reviewedById: scheduledClass.reflectionReviewedById,
      mentorNote: scheduledClass.reflectionMentorNote,
    };
  },

  /**
   * Stores a student's reflection. It scores nothing.
   *
   * The snapshot is taken against the server's copy of the quiz — question text,
   * type and worth are copied in — so a client cannot invent prompts, inflate
   * what a question was worth, or have a later admin edit silently reword what
   * it was asked. What it deliberately does *not* do is mark any of it:
   * `reflectionScore`, `reflectionMaxScore` and `reflectionBadge` are left null
   * and every answer is stored unmarked, because the points are the mentor's
   * judgement and the badge follows their total. The student sees "submitted,
   * waiting for your mentor" until `reviewReflection` runs.
   */
  async submitReflection(
    classId: string,
    responses: ReflectionResponse[],
    callerId?: string,
    callerRole?: string
  ) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        studentId: true,
        sessionId: true,
        status: true,
        startTime: true,
        endTime: true,
        actualEndedAt: true,
        rescheduledCount: true,
        reflectionSubmittedAt: true,
        quizLaunchedAt: true,
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // One attempt per class.
    //
    // The lock predates mentor marking — a graded response used to hand back
    // `correct` per question, which made unlimited resubmission an answer
    // oracle. Nothing is graded at submit any more, so that particular loop is
    // closed either way, but the lock stays for a plainer reason: the mentor
    // marks these exact answers, and a student who could overwrite them after
    // the marking started would be revising work someone is part-way through
    // paying for. ADMIN can still overwrite to fix a genuine mistake.
    if (callerRole !== 'ADMIN' && scheduledClass.reflectionSubmittedAt) {
      throw new AppError(
        'You have already submitted this quiz — ask your mentor if you need it reopened',
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Only the student who attended may answer. ADMIN is allowed through for
    // support fixes; every other role is rejected outright.
    const isAdmin = callerRole === 'ADMIN';
    if (!isAdmin) {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      if (scheduledClass.studentId !== callerId) {
        throw new AppError('You can only submit a reflection for your own class', HTTP_STATUS.FORBIDDEN);
      }
    }

    // You can only reflect on a class you actually attended. Two things prove
    // that: the mentor marked it complete, or the Meet room was used and then
    // emptied. A slot whose clock simply ran out proves nothing — it is
    // indistinguishable from the student never turning up — so it is refused.
    // ADMIN bypasses for support fixes.
    if (callerRole !== 'ADMIN') {
      if (scheduledClass.status === 'CANCELLED') {
        throw new AppError('This class was cancelled', HTTP_STATUS.BAD_REQUEST);
      }
      // The quiz opens once the class has STARTED — or the mentor has launched
      // it live — and no longer waits for the mentor to mark the class
      // complete. The live-quiz flow depends on this: the mentor fires the
      // quiz mid-session, while the class is still SCHEDULED, and the student
      // answers it on the call.
      const started = scheduledClass.startTime.getTime() <= Date.now();
      if (!started && !scheduledClass.quizLaunchedAt) {
        throw new AppError('This class has not started yet', HTTP_STATUS.BAD_REQUEST);
      }
    }

    const session = scheduledClass.sessionId
      ? await db.session.findUnique({
          where: { id: scheduledClass.sessionId },
          select: { reflectionQuestions: true, reflectionQuiz: true },
        })
      : null;

    const quiz = effectiveReflectionQuiz(session?.reflectionQuiz, session?.reflectionQuestions);
    const snapshot = snapshotReflection(quiz, responses);

    if (snapshot.answeredCount === 0) {
      throw new AppError('Answer at least one question before submitting', HTTP_STATUS.BAD_REQUEST);
    }

    const updated = await db.$transaction(async (tx) => {
      // Only ADMIN reaches this with a submission already on the row, and
      // replacing the answers throws away the marks attached to them. Whatever
      // the mentor had already paid out for those answers is taken back with
      // them: leaving the credits behind while zeroing the record of them would
      // make the next evaluation award the full amount a second time, which is
      // the unbounded-minting bug this whole path is written to avoid.
      const current = await tx.scheduledClass.findUnique({
        where: { id: classId },
        select: { studentId: true, reflectionAnswers: true, reflectionSubmittedAt: true },
      });
      const clawback = mentorAwardedTotal(current?.reflectionAnswers as ReflectionAnswerEntry[] | null);

      /* Submitting the quiz pays instantly - the child sees their effort
       * counted the moment they press send, not whenever marking happens.
       * FIRST submission only, read inside the transaction: an admin
       * resubmitting over an existing attempt re-mints nothing, and the
       * "already submitted" lock above keeps students to one attempt. The
       * mentor's per-answer marks still arrive on top at review time. */
      const instantAward = !current?.reflectionSubmittedAt && current?.studentId ? DEFAULT_REFLECTION_POINTS : 0;

      const row = await tx.scheduledClass.update({
        where: { id: classId },
        data: {
          reflectionAnswers: snapshot.entries as any,
          reflectionSubmittedAt: new Date(),
          // Score, max and badge stay null on purpose. Writing 0 here would make
          // "not marked yet" indistinguishable from "marked and scored nothing" —
          // `getStudentOverview` counts any number as a marked quiz.
          reflectionScore: null,
          reflectionMaxScore: null,
          reflectionBadge: null,
          // A sign-off belongs to the answers it was given for. These are new
          // answers, so the class goes back into the marking queue.
          reflectionReviewedAt: null,
          reflectionReviewedById: null,
          reflectionMentorNote: null,
        },
        select: {
          id: true,
          reflectionAnswers: true,
          reflectionSubmittedAt: true,
          reflectionScore: true,
          reflectionMaxScore: true,
          reflectionBadge: true,
        },
      });

      if (clawback > 0 && current?.studentId) {
        await tx.student.update({
          where: { id: current.studentId },
          data: { credits: { decrement: clawback } },
        });
        logger.warn(
          `[Reflection] Class ${classId} resubmitted over a marked reflection — reclaimed ${clawback} credit points`
        );
      }

      if (instantAward > 0 && current?.studentId) {
        await tx.student.update({
          where: { id: current.studentId },
          data: { credits: { increment: instantAward } },
        });
        logger.info(`[Reflection] Class ${classId} — ${instantAward} points awarded instantly for submitting the quiz`);
      }

      return { row, instantAward };
    });

    logger.info(
      `[Reflection] Student ${scheduledClass.studentId} submitted reflection for class ${classId} ` +
      `— ${snapshot.answeredCount}/${snapshot.entries.length} answered, awaiting mentor marking`
    );
    // The score/max/badge keys are kept (null) so the client shape does not
    // change; `awaitingReview` is what it should actually be reading.
    return {
      ...updated.row,
      badge: null,
      answeredCount: snapshot.answeredCount,
      pointsAvailable: snapshot.maxScore,
      awaitingReview: true,
      pointsAwarded: updated.instantAward,
    };
  },

  /**
   * The mentor's evaluation of a submitted reflection: points per answer, an
   * optional remark on each, an optional overall note, and the sign-off.
   *
   * This is where a reflection is actually marked. Nothing scores the quiz at
   * submit, so the mentor's per-answer awards *are* the score: their sum is
   * `reflectionScore`, the sum of what the questions are worth is
   * `reflectionMaxScore`, and the badge follows from the two on the same
   * Gold/Silver/Bronze thresholds as before. The awarded total is then added to
   * the student's credit balance — the points are the reward, and completing a
   * class no longer pays anything on its own.
   *
   * `marks` is optional. Omitting it keeps the endpoint's original behaviour —
   * a sign-off and a note, no score and no credits — which is what an older
   * client posting only `{ note }` gets.
   *
   * Re-marking is expected: a mentor may fix a number they got wrong, or mark
   * the quiz in passes. So the credit movement is a *difference* against what
   * the entries were already carrying, never the whole total again.
   */
  async reviewReflection(
    classId: string,
    note?: string,
    marks?: ReflectionMentorMark[],
    callerId?: string,
    callerRole?: string
  ) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        studentId: true,
        mentorId: true,
        sessionId: true,
        reflectionSubmittedAt: true,
        student: { select: { firstName: true, parentAccountId: true } },
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // Only the mentor who taught this class may mark it. ADMIN is allowed
    // through for support fixes; every other role — including other mentors on
    // the platform — is rejected outright. Unchanged by the move to
    // mentor-awarded points: the same person who signs off is the one who pays.
    if (callerRole !== 'ADMIN') {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      if (!isMentorRole(callerRole) || scheduledClass.mentorId !== callerId) {
        throw new AppError('Only the mentor of this class can review its reflection', HTTP_STATUS.FORBIDDEN);
      }
    }

    // Marks have nothing to attach to before the student has answered.
    if (!scheduledClass.reflectionSubmittedAt) {
      throw new AppError('There is no submitted reflection to review yet', HTTP_STATUS.BAD_REQUEST);
    }

    const trimmedNote = typeof note === 'string' ? note.trim() : '';
    const evaluating = Array.isArray(marks) && marks.length > 0;
    const reviewedAt = new Date();

    const { updated, awarded, creditsDiff } = await db.$transaction(async (tx) => {
      // Read inside the transaction. The baseline for the credit difference has
      // to be the row as it is at the moment of the write — reading it before
      // the transaction and incrementing after is the race a double-clicked
      // Save wins, and it pays twice.
      const current = await tx.scheduledClass.findUnique({
        where: { id: classId },
        select: { studentId: true, reflectionAnswers: true, reflectionScore: true },
      });
      if (!current) {
        throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
      }

      const data: Record<string, unknown> = {
        reflectionReviewedAt: reviewedAt,
        reflectionReviewedById: callerId ?? null,
        // Reviewing with an empty note clears the old one: leaving a previous
        // reply attached to a fresh sign-off would misattribute it.
        reflectionMentorNote: trimmedNote || null,
      };

      let evaluated: ReturnType<typeof applyMentorMarks> | null = null;
      if (evaluating) {
        try {
          // Validation lives in the shared helper and reads the ceiling off the
          // *stored* entries, which the server wrote at submit. A ceiling taken
          // from the request would be a number the client chooses.
          evaluated = applyMentorMarks(
            current.reflectionAnswers as ReflectionAnswerEntry[] | null,
            marks as ReflectionMentorMark[],
            reviewedAt
          );
        } catch (err) {
          throw new AppError((err as Error).message, HTTP_STATUS.BAD_REQUEST);
        }
        data.reflectionAnswers = evaluated.entries as any;
        data.reflectionScore = evaluated.score;
        data.reflectionMaxScore = evaluated.maxScore;
        data.reflectionBadge = evaluated.badge?.id ?? null;
      }

      // Compare-and-set on the score this evaluation was computed against, so a
      // second concurrent save of the same marking finds the row already moved
      // and is refused rather than crediting on top of the first.
      const applied = await tx.scheduledClass.updateMany({
        where: { id: classId, reflectionScore: current.reflectionScore },
        data: data as any,
      });
      if (applied.count === 0) {
        throw new AppError(
          'This reflection was marked by someone else a moment ago — reload it and try again',
          HTTP_STATUS.CONFLICT
        );
      }

      const row = await tx.scheduledClass.findUnique({
        where: { id: classId },
        select: {
          id: true,
          reflectionAnswers: true,
          reflectionSubmittedAt: true,
          reflectionScore: true,
          reflectionMaxScore: true,
          reflectionBadge: true,
          reflectionReviewedAt: true,
          reflectionReviewedById: true,
          reflectionMentorNote: true,
        },
      });
      if (!row) {
        throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
      }

      // The difference, never the total. `previousScore` is what the stored
      // entries were already marked at, so re-saving an unchanged evaluation
      // moves 0, raising an answer from 3 to 5 moves +2, and lowering it moves
      // -2. Awarding `evaluated.score` here instead would mint the whole quiz
      // again on every edit — the same shape of bug the admin `creditsAwarded`
      // path was fixed for.
      const diff = evaluated ? evaluated.score - evaluated.previousScore : 0;
      if (diff !== 0 && current.studentId) {
        await tx.student.update({
          where: { id: current.studentId },
          data: { credits: { increment: diff } },
        });
      }

      return { updated: row, awarded: evaluated, creditsDiff: diff };
    });

    if (scheduledClass.studentId) {
      const scoreLine = awarded ? ` You scored ${awarded.score}/${awarded.maxScore}.` : '';
      const pointsLine =
        creditsDiff > 0
          ? ` +${creditsDiff} credit points have been added to your balance.`
          : creditsDiff < 0
            ? ` Your balance was corrected by ${creditsDiff} credit points.`
            : '';
      await sendNotification(
        scheduledClass.studentId,
        awarded ? 'Your mentor marked your quiz' : 'Your mentor reviewed your quiz',
        (trimmedNote
          ? `Your mentor left you a note: "${trimmedNote}"`
          : 'Your mentor has gone through your reflection answers.') + scoreLine + pointsLine,
        awarded ? 'MEDIUM' : 'LOW'
      );

      // The parent used to hear about points when the class was completed. That
      // notification was removed with the award, so this is where they hear now.
      if (awarded && creditsDiff !== 0 && scheduledClass.student?.parentAccountId) {
        await sendNotification(
          scheduledClass.student.parentAccountId,
          'Quiz Marked',
          `${scheduledClass.student.firstName ?? 'Your child'} scored ${awarded.score}/${awarded.maxScore} on their reflection quiz (${creditsDiff > 0 ? '+' : ''}${creditsDiff} credit points).`,
          'LOW'
        );
      }
    }

    logger.info(
      `[Reflection] Class ${classId} ${awarded ? 'marked' : 'signed off'} by ${callerId ?? 'unknown caller'}` +
        (awarded
          ? ` — ${awarded.score}/${awarded.maxScore}${awarded.badge ? ` (${awarded.badge.id})` : ''}, ` +
            `${awarded.markedCount}/${awarded.totalCount} answers marked, credits ${creditsDiff >= 0 ? '+' : ''}${creditsDiff}`
          : '')
    );

    // `creditsDelta`, not `creditsAwarded`: it is how far the balance moved this
    // time, which on a revision is the difference and can be negative. The
    // column of that name is the admin correction tool and means something else.
    return {
      ...updated,
      badge: awarded?.badge ?? null,
      creditsDelta: creditsDiff,
      markedCount: awarded?.markedCount ?? 0,
      totalCount: awarded?.totalCount ?? 0,
    };
  },

  // ── Class doubts ────────────────────────────────────────────────────────────

  /**
   * Records a question the student had after a class.
   *
   * Tied to a class on purpose: "I didn't follow that bit" is only answerable if
   * the mentor knows which lesson it came from.
   */
};

// Re-export as part of the main scheduleService interface for backwards compat
export type ReflectionServiceType = typeof reflectionService;
