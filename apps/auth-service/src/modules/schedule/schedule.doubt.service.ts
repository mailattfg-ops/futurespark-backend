/**
 * schedule.doubt.service.ts
 *
 * Doubt (Q&A) and work-submission methods extracted from schedule.service.ts.
 * Exported as `doubtService` so controllers can reach them independently.
 */

import { db } from '../../database/datasource';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';
import { logger } from '@futurespark/logger';
import { sendNotification } from '../notification-helper';
import {
  isMentorRole,
  assertClassAccess,
  DOUBT_QUESTION_MAX,
  DOUBT_ANSWER_MAX,
} from './schedule.helpers';

export const doubtService = {
  async createDoubt(classId: string, question: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: { id: true, studentId: true, mentorId: true, sessionId: true, status: true },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // Deliberately no ADMIN bypass, unlike the other gates in this file: the row
    // is stored and shown to the mentor as the student's own words, so nobody —
    // not the parent, not the mentor, not support — may author one for them.
    if (!callerId) {
      throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
    }
    if (callerRole !== 'STUDENT' || scheduledClass.studentId !== callerId) {
      throw new AppError('You can only ask a question about your own class', HTTP_STATUS.FORBIDDEN);
    }

    if (scheduledClass.status === 'CANCELLED') {
      throw new AppError('This class was cancelled', HTTP_STATUS.BAD_REQUEST);
    }

    const text = typeof question === 'string' ? question.trim() : '';
    if (!text) {
      throw new AppError('Type your question before sending it', HTTP_STATUS.BAD_REQUEST);
    }
    if (text.length > DOUBT_QUESTION_MAX) {
      throw new AppError(`A question can be at most ${DOUBT_QUESTION_MAX} characters`, HTTP_STATUS.BAD_REQUEST);
    }

    const doubt = await db.classDoubt.create({
      data: { classId, studentId: callerId, question: text },
    });

    if (scheduledClass.mentorId) {
      const session = scheduledClass.sessionId
        ? await db.session.findUnique({ where: { id: scheduledClass.sessionId }, select: { title: true } })
        : null;
      await sendNotification(
        scheduledClass.mentorId,
        'New question from a student',
        `A student asked a question about "${session?.title || 'their class'}". It is waiting in your doubts inbox.`,
        'MEDIUM'
      );
    }

    logger.info(`[Doubt] Student ${callerId} raised a doubt on class ${classId}`);
    return doubt;
  },

  /** Every question raised against one class, newest first. */
  /* ── Class submissions ────────────────────────────────────────────────────
   * The child's own work — a photographed worksheet, a finished activity —
   * attached to the class it was done for. Reading is the same circle as
   * doubts: the student, their parent, the mentor who taught it, and staff.
   * WRITING is narrower: the mentor does not upload the child's work, and a
   * submission on a cancelled class is a filing error waiting to happen. */

  async listSubmissions(classId: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        studentId: true,
        mentorId: true,
        student: { select: { parentAccountId: true } },
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }
    assertClassAccess(scheduledClass, callerId, callerRole);

    return db.classSubmission.findMany({
      where: { classId },
      orderBy: { createdAt: 'asc' },
    });
  },

  async addSubmission(
    classId: string,
    input: { fileUrl?: unknown; fileName?: unknown; note?: unknown },
    callerId?: string,
    callerRole?: string
  ) {
    const fileUrl = typeof input.fileUrl === 'string' ? input.fileUrl.trim() : '';
    const fileName = typeof input.fileName === 'string' ? input.fileName.trim().slice(0, 200) : '';
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : null;
    if (!fileUrl || !fileName) {
      throw new AppError('A file URL and file name are required', HTTP_STATUS.BAD_REQUEST);
    }

    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        status: true,
        studentId: true,
        student: { select: { parentAccountId: true } },
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }
    if (scheduledClass.status === 'CANCELLED') {
      throw new AppError('This class was cancelled', HTTP_STATUS.BAD_REQUEST);
    }
    if (!scheduledClass.studentId) {
      // A demo class has a lead, not a student — there is nobody whose work
      // this could be filed under.
      throw new AppError('This class has no enrolled student to submit work for', HTTP_STATUS.BAD_REQUEST);
    }
    if (!callerId) {
      throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
    }

    // The child, their parent, or an admin fixing a filing mistake. Never the
    // mentor: the work is the family's to hand in.
    const permitted =
      callerRole === 'ADMIN' ||
      (callerRole === 'STUDENT' && callerId === scheduledClass.studentId) ||
      (callerRole === 'PARENT' && callerId === scheduledClass.student?.parentAccountId);
    if (!permitted) {
      throw new AppError('You do not have access to this class', HTTP_STATUS.FORBIDDEN);
    }

    // ponytail: flat cap, per-class. Enough for a worksheet photographed page
    // by page; stops a stuck retry loop filing five hundred copies.
    const existing = await db.classSubmission.count({ where: { classId } });
    if (existing >= 12) {
      throw new AppError('This class already has the maximum of 12 submissions', HTTP_STATUS.BAD_REQUEST);
    }

    // No points here, by decision: credits come from the quiz and the mentor's
    // awards only. Handing in a file must never become a farming loop.
    return db.classSubmission.create({
      data: {
        classId,
        studentId: scheduledClass.studentId,
        uploaderId: callerId,
        uploaderRole: callerRole ?? 'STUDENT',
        fileUrl,
        fileName,
        note,
      },
    });
  },

  /**
   * The mentor's feedback on one handed-in piece of work.
   *
   * One editable note, mirroring reflectionMentorNote — a comment thread on a
   * worksheet photo is ceremony a mentor will not fill in. Only the mentor who
   * taught the class (or an admin) writes it; the family reads it under the
   * file. An empty comment clears it.
   */
  async commentOnSubmission(
    classId: string,
    submissionId: string,
    comment: unknown,
    callerId?: string,
    callerRole?: string
  ) {
    const text = typeof comment === 'string' ? comment.trim().slice(0, 600) : '';

    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: { id: true, mentorId: true },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }
    if (!callerId) {
      throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
    }
    const permitted =
      callerRole === 'ADMIN' || (isMentorRole(callerRole) && scheduledClass.mentorId === callerId);
    if (!permitted) {
      throw new AppError('Only the mentor who taught this class can comment', HTTP_STATUS.FORBIDDEN);
    }

    const submission = await db.classSubmission.findUnique({ where: { id: submissionId } });
    if (!submission || submission.classId !== classId) {
      throw new AppError('Submission not found', HTTP_STATUS.NOT_FOUND);
    }

    return db.classSubmission.update({
      where: { id: submissionId },
      data: text
        ? { mentorComment: text, mentorCommentAt: new Date(), mentorCommentById: callerId }
        : { mentorComment: null, mentorCommentAt: null, mentorCommentById: null },
    });
  },

  async deleteSubmission(classId: string, submissionId: string, callerId?: string, callerRole?: string) {
    const submission = await db.classSubmission.findUnique({ where: { id: submissionId } });
    if (!submission || submission.classId !== classId) {
      throw new AppError('Submission not found', HTTP_STATUS.NOT_FOUND);
    }
    // Whoever uploaded it may withdraw it; an admin can tidy a mis-filing.
    if (callerRole !== 'ADMIN' && submission.uploaderId !== callerId) {
      throw new AppError('Only the uploader can remove this submission', HTTP_STATUS.FORBIDDEN);
    }
    await db.classSubmission.delete({ where: { id: submissionId } });
    return { deleted: true };
  },

  async listDoubts(classId: string, callerId?: string, callerRole?: string) {
    const scheduledClass = await db.scheduledClass.findUnique({
      where: { id: classId },
      select: {
        id: true,
        studentId: true,
        mentorId: true,
        student: { select: { parentAccountId: true } },
      },
    });
    if (!scheduledClass) {
      throw new AppError('Class session not found', HTTP_STATUS.NOT_FOUND);
    }

    // The same relationship test `getStudentOverview` runs, narrowed to a single
    // class: the student who sat it, their parent, the mentor who taught it.
    // Shared with `getReflection`, which gates on exactly the same thing.
    assertClassAccess(scheduledClass, callerId, callerRole);

    return db.classDoubt.findMany({
      where: { classId },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * The mentor's queue of unanswered questions across every class they teach.
   *
   * Each row carries its lesson and its student, because a question read out of
   * context cannot be answered — and a mentor working through a backlog should
   * not have to open a class page per question to find out what it is about.
   */
  async listDoubtInbox(callerId?: string, callerRole?: string) {
    const isAdmin = callerRole === 'ADMIN';
    if (!isAdmin) {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      if (!isMentorRole(callerRole)) {
        throw new AppError('Only mentors can read the doubts inbox', HTTP_STATUS.FORBIDDEN);
      }
    }

    const doubts = await db.classDoubt.findMany({
      // Scoped through the class's mentor rather than the doubt itself: a doubt
      // belongs to a lesson, and whoever taught that lesson owns answering it.
      // ADMIN sees the whole platform's backlog.
      where: {
        status: 'OPEN',
        ...(isAdmin ? {} : { class: { mentorId: callerId } }),
      },
      include: {
        class: {
          select: {
            id: true,
            startTime: true,
            endTime: true,
            status: true,
            classType: true,
            programId: true,
            sessionId: true,
            mentorId: true,
            meetingLink: true,
            reflectionSubmittedAt: true,
            student: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const sessionIds = [...new Set(doubts.map((d) => d.class.sessionId).filter(Boolean))] as string[];
    const sessions = sessionIds.length
      ? await db.session.findMany({
          where: { id: { in: sessionIds } },
          select: { id: true, title: true, order: true },
        })
      : [];
    const sessionById = new Map(sessions.map((s) => [s.id, s]));

    return doubts.map((d) => {
      const session = d.class.sessionId ? sessionById.get(d.class.sessionId) : undefined;
      return {
        id: d.id,
        classId: d.classId,
        studentId: d.studentId,
        question: d.question,
        status: d.status,
        answer: d.answer,
        answeredAt: d.answeredAt,
        answeredById: d.answeredById,
        answeredByName: d.answeredByName,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        // Safe to read the author off the class: `createDoubt` only ever lets the
        // owning student write one, so the two student ids cannot diverge.
        student: d.class.student,
        class: {
          id: d.class.id,
          startTime: d.class.startTime,
          endTime: d.class.endTime,
          status: d.class.status,
          classType: d.class.classType,
          programId: d.class.programId,
          sessionId: d.class.sessionId,
          sessionTitle: session?.title ?? null,
          sessionOrder: session?.order ?? null,
          mentorId: d.class.mentorId,
          meetingLink: d.class.meetingLink,
          reflectionSubmittedAt: d.class.reflectionSubmittedAt,
        },
      };
    });
  },

  /** The mentor's reply. Re-answering an answered doubt overwrites it. */
  async answerDoubt(doubtId: string, answer: string, callerId?: string, callerRole?: string) {
    const doubt = await db.classDoubt.findUnique({
      where: { id: doubtId },
      include: { class: { select: { id: true, mentorId: true, studentId: true, sessionId: true } } },
    });
    if (!doubt) {
      throw new AppError('Question not found', HTTP_STATUS.NOT_FOUND);
    }

    if (callerRole !== 'ADMIN') {
      if (!callerId) {
        throw new AppError('Unable to identify the caller', HTTP_STATUS.UNAUTHORIZED);
      }
      if (!isMentorRole(callerRole) || doubt.class.mentorId !== callerId) {
        throw new AppError('Only the mentor of this class can answer its questions', HTTP_STATUS.FORBIDDEN);
      }
    }

    const text = typeof answer === 'string' ? answer.trim() : '';
    if (!text) {
      throw new AppError('Type an answer before sending it', HTTP_STATUS.BAD_REQUEST);
    }
    if (text.length > DOUBT_ANSWER_MAX) {
      throw new AppError(`An answer can be at most ${DOUBT_ANSWER_MAX} characters`, HTTP_STATUS.BAD_REQUEST);
    }

    // Resolved server-side and never taken from the body: this name is shown to
    // the student as the person who replied, so a caller must not get to choose it.
    let answeredByName = 'Your mentor';
    if (callerId) {
      const user = await db.user.findUnique({
        where: { id: callerId },
        select: { firstName: true, lastName: true, email: true },
      });
      if (user) {
        answeredByName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
      }
    }

    const updated = await db.classDoubt.update({
      where: { id: doubtId },
      data: {
        answer: text,
        answeredAt: new Date(),
        answeredById: callerId ?? null,
        answeredByName,
        status: 'ANSWERED',
      },
    });

    await sendNotification(
      doubt.studentId,
      'Your question was answered',
      `${answeredByName} replied to the question you asked about your class.`,
      'MEDIUM'
    );

    logger.info(`[Doubt] Doubt ${doubtId} on class ${doubt.classId} answered by ${callerId ?? 'unknown caller'}`);
    return updated;
  },

  /**
   * Everything known about one student's journey on a programme: attendance per
   * class, reflection answers and scores, points, and progress against the
   * curriculum.
   *
   * Exists so a mentor can answer a parent's question without piecing it
   * together from three different screens. Deliberately spans *all* the
   * student's classes rather than only the caller's, since a substitute mentor
   * covering one week should still see the full picture.
   */
};

export type DoubtServiceType = typeof doubtService;
