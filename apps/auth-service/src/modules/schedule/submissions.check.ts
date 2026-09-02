/**
 * Self-check for class-submission gating. Run:
 *   npx ts-node --transpile-only apps/auth-service/src/modules/schedule/submissions.check.ts
 * Stubs the datasource; touches no database.
 *
 * Who may file a child's work is an access-control decision, so it gets the
 * same treatment as the identity middleware: every refusal asserted.
 */
import assert from 'assert';
import Module from 'module';

const CLS = {
  id: 'cls-1',
  status: 'SCHEDULED',
  studentId: 'stu-1',
  mentorId: 'men-1',
  student: { parentAccountId: 'par-1' },
};
let cls: any = { ...CLS };
let count = 0;
const created: any[] = [];
let stored: any = null;
const updates: any[] = [];
const creditBumps: number[] = [];

/* ONE stub instance, returned for every require. A factory here would hand the
 * service and the test two different objects, and assertions against ours
 * would see none of the service's calls. */
const stub = {
  db: {
    scheduledClass: { findUnique: () => Promise.resolve(cls), findMany: () => Promise.resolve([]) },
    classSubmission: {
      count: () => Promise.resolve(count),
      create: (args: any) => { created.push(args.data); return Promise.resolve({ id: 'sub-1', ...args.data }); },
      findUnique: () => Promise.resolve(stored),
      findMany: () => Promise.resolve([]),
      delete: () => Promise.resolve({}),
      update: (args: any) => { updates.push(args.data); return Promise.resolve({ id: 'sub-1', ...args.data }); },
    },
    student: {
      update: (args: any) => { creditBumps.push(args.data.credits.increment); return Promise.resolve({}); },
    },
  },
  withDbRetry: (fn: () => unknown) => fn(),
};
(stub.db as any).$transaction = (fn: (tx: unknown) => unknown) => fn(stub.db);

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.endsWith('database/datasource')) return stub;
  return originalLoad.call(this, request, parent, isMain);
};

const run = async () => {
  const { scheduleService } = await import('./schedule.service');
  const FILE = { fileUrl: 'https://s3/x.jpg', fileName: 'worksheet.jpg' };
  const throws = async (fn: () => Promise<unknown>, re: RegExp, label: string) => {
    try { await fn(); assert.fail(label + ': did not throw'); }
    catch (e: any) { assert.match(String(e.message), re, label + ` (got: ${e.message})`); }
  };

  // The family files; nobody else does. Deliberately NO points: credits come
  // from the quiz and the mentor's awards, never from uploading files.
  const own = await scheduleService.addSubmission('cls-1', FILE, 'stu-1', 'STUDENT');
  assert.strictEqual(own.studentId, 'stu-1', 'the student files their own work');
  assert.strictEqual((own as any).pointsAwarded, undefined, 'a hand-in mints nothing');
  assert.deepStrictEqual(creditBumps, [], 'no credit moved');
  await scheduleService.addSubmission('cls-1', FILE, 'par-1', 'PARENT');
  assert.strictEqual(created[1].uploaderRole, 'PARENT', 'the parent can file it too');
  await throws(() => scheduleService.addSubmission('cls-1', FILE, 'men-1', 'TEACHER'), /do not have access/, 'the mentor never files it');
  await throws(() => scheduleService.addSubmission('cls-1', FILE, 'stu-OTHER', 'STUDENT'), /do not have access/, 'another child never files it');
  await throws(() => scheduleService.addSubmission('cls-1', FILE, 'par-OTHER', 'PARENT'), /do not have access/, 'another family never files it');

  // Broken inputs and broken targets refuse.
  await throws(() => scheduleService.addSubmission('cls-1', { fileUrl: '', fileName: 'x' }, 'stu-1', 'STUDENT'), /required/, 'no url, no filing');
  cls = { ...CLS, status: 'CANCELLED' };
  await throws(() => scheduleService.addSubmission('cls-1', FILE, 'stu-1', 'STUDENT'), /cancelled/, 'no filing on a cancelled class');
  cls = { ...CLS, studentId: null };
  await throws(() => scheduleService.addSubmission('cls-1', FILE, 'stu-1', 'STUDENT'), /no enrolled student/, 'a demo class has nobody to file for');
  cls = { ...CLS };
  count = 12;
  await throws(() => scheduleService.addSubmission('cls-1', FILE, 'stu-1', 'STUDENT'), /maximum/, 'the per-class cap holds');
  count = 0;

  // Withdrawal: the uploader or an admin, nobody else.
  stored = { id: 'sub-1', classId: 'cls-1', uploaderId: 'stu-1' };
  assert.deepStrictEqual(await scheduleService.deleteSubmission('cls-1', 'sub-1', 'stu-1', 'STUDENT'), { deleted: true }, 'uploader withdraws');
  await throws(() => scheduleService.deleteSubmission('cls-1', 'sub-1', 'par-1', 'PARENT'), /Only the uploader/, 'even the parent cannot remove the child\'s upload');
  assert.deepStrictEqual(await scheduleService.deleteSubmission('cls-1', 'sub-1', 'admin-1', 'ADMIN'), { deleted: true }, 'admin tidies a mis-filing');
  stored = { id: 'sub-1', classId: 'cls-OTHER', uploaderId: 'stu-1' };
  await throws(() => scheduleService.deleteSubmission('cls-1', 'sub-1', 'stu-1', 'STUDENT'), /not found/, 'a submission is deleted only via its own class');

  // Feedback: the mentor who taught it (or admin) — never the family, never
  // another mentor. Empty clears.
  cls = { ...CLS };
  stored = { id: 'sub-1', classId: 'cls-1', uploaderId: 'stu-1' };

  await scheduleService.commentOnSubmission('cls-1', 'sub-1', '  Great work on the slip!  ', 'men-1', 'TEACHER');
  assert.strictEqual(updates[0].mentorComment, 'Great work on the slip!', 'the class mentor comments, trimmed');
  await scheduleService.commentOnSubmission('cls-1', 'sub-1', 'noted', 'admin-1', 'ADMIN');
  assert.strictEqual(updates[1].mentorComment, 'noted', 'admin may comment');
  await scheduleService.commentOnSubmission('cls-1', 'sub-1', '   ', 'men-1', 'TEACHER');
  assert.strictEqual(updates[2].mentorComment, null, 'blank clears the feedback');
  await throws(() => scheduleService.commentOnSubmission('cls-1', 'sub-1', 'x', 'men-OTHER', 'TEACHER'), /Only the mentor/, 'another mentor refused');
  await throws(() => scheduleService.commentOnSubmission('cls-1', 'sub-1', 'x', 'stu-1', 'STUDENT'), /Only the mentor/, 'the student cannot self-review');
  await throws(() => scheduleService.commentOnSubmission('cls-1', 'sub-1', 'x', 'par-1', 'PARENT'), /Only the mentor/, 'the parent cannot either');

  console.log('submissions: 21/21 checks passed');
};

run()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => { (Module as any)._load = originalLoad; });
