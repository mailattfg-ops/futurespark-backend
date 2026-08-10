import { db } from '../../database/datasource';
import { AppError } from '@futurespark/middleware';
import { HTTP_STATUS } from '@futurespark/constants';

export const RESOURCE_KINDS = ['LINK', 'FILE', 'VIDEO', 'SLIDES', 'WORKSHEET', 'OTHER'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface CreateResourceInput {
  sessionId: string;
  title: string;
  description?: string | null;
  url: string;
  kind: ResourceKind;
  topic?: string | null;
}

const trim = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export const validateCreateResource = (data: any): CreateResourceInput => {
  const errors: string[] = [];

  const sessionId = trim(data?.sessionId, 64);
  const title = trim(data?.title, 200);
  const url = trim(data?.url, 2000);

  if (!sessionId) errors.push('sessionId is required');
  if (!title) errors.push('A title is required');
  if (!url) errors.push('A link or uploaded file is required');
  if (errors.length) throw new AppError(errors.join('; '), HTTP_STATUS.BAD_REQUEST);

  const rawKind = trim(data?.kind, 20).toUpperCase();
  return {
    sessionId,
    title,
    url,
    description: trim(data?.description, 1000) || null,
    kind: (RESOURCE_KINDS as readonly string[]).includes(rawKind) ? (rawKind as ResourceKind) : 'LINK',
    topic: trim(data?.topic, 160) || null,
  };
};

export const resourceService = {
  /**
   * Resources for one session, or the whole catalogue when no session is given.
   *
   * Readable by any signed-in role: a student opening their session materials and
   * a mentor preparing to teach it want the same list. Only writing is restricted.
   */
  async list(filters: { sessionId?: string; programId?: string }) {
    const where: any = {};
    if (filters.sessionId) where.sessionId = filters.sessionId;
    if (filters.programId) where.session = { programId: filters.programId };

    return db.sessionResource.findMany({
      where,
      include: {
        session: { select: { id: true, title: true, order: true, programId: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
    });
  },

  /**
   * Display name for the contributor, looked up rather than taken from the
   * request. A shared hub where anyone can post under someone else's name is
   * worse than one with no names at all.
   */
  async resolveAuthorName(userId: string, fallback: string): Promise<string> {
    try {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, email: true },
      });
      if (!user) return fallback;
      return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || fallback;
    } catch {
      // A name is cosmetic; never fail the write over it.
      return fallback;
    }
  },

  async create(input: CreateResourceInput, author: { id: string; role: string }) {
    const session = await db.session.findUnique({ where: { id: input.sessionId }, select: { id: true } });
    if (!session) throw new AppError('Session not found', HTTP_STATUS.NOT_FOUND);

    const addedByName = await this.resolveAuthorName(author.id, 'Academy staff');

    return db.sessionResource.create({
      data: {
        sessionId: input.sessionId,
        title: input.title,
        description: input.description,
        url: input.url,
        kind: input.kind,
        topic: input.topic,
        addedById: author.id,
        addedByName,
        addedByRole: author.role,
      },
      include: {
        session: { select: { id: true, title: true, order: true, programId: true } },
      },
    });
  },

  async update(id: string, data: any, caller: { id: string; role: string }) {
    const existing = await db.sessionResource.findUnique({ where: { id } });
    if (!existing) throw new AppError('Resource not found', HTTP_STATUS.NOT_FOUND);
    this.assertCanModify(existing, caller);

    const patch: any = {};
    if (data.title !== undefined) {
      const title = trim(data.title, 200);
      if (!title) throw new AppError('A title is required', HTTP_STATUS.BAD_REQUEST);
      patch.title = title;
    }
    if (data.url !== undefined) {
      const url = trim(data.url, 2000);
      if (!url) throw new AppError('A link or uploaded file is required', HTTP_STATUS.BAD_REQUEST);
      patch.url = url;
    }
    if (data.description !== undefined) patch.description = trim(data.description, 1000) || null;
    if (data.topic !== undefined) patch.topic = trim(data.topic, 160) || null;
    if (data.kind !== undefined) {
      const kind = trim(data.kind, 20).toUpperCase();
      patch.kind = (RESOURCE_KINDS as readonly string[]).includes(kind) ? kind : 'LINK';
    }

    return db.sessionResource.update({
      where: { id },
      data: patch,
      include: { session: { select: { id: true, title: true, order: true, programId: true } } },
    });
  },

  async remove(id: string, caller: { id: string; role: string }) {
    const existing = await db.sessionResource.findUnique({ where: { id } });
    if (!existing) throw new AppError('Resource not found', HTTP_STATUS.NOT_FOUND);
    this.assertCanModify(existing, caller);
    await db.sessionResource.delete({ where: { id } });
    return { id };
  },

  /**
   * Only the curriculum team edits published material. The route layer already
   * blocks everyone else, so this is the second line — reached if a role is ever
   * added to the route guard without being thought through here.
   */
  assertCanModify(_resource: { addedById: string }, caller: { id: string; role: string }) {
    if (caller.role === 'ADMIN' || caller.role === 'INSTRUCTOR') return;
    throw new AppError('Only the curriculum team can change published resources', HTTP_STATUS.FORBIDDEN);
  },
};
