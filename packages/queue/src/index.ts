import { Queue, Worker, JobsOptions, Processor, ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Background jobs on BullMQ, over the same Redis the cache package uses.
 *
 * ── Why a separate connection and not @futurespark/cache's client ──────────
 * The cache client is deliberately fail-fast: `maxRetriesPerRequest: 0` and
 * `enableOfflineQueue: false`, so a page read degrades instead of hanging when
 * Redis is down. BullMQ holds BLOCKING connections and REQUIRES
 * `maxRetriesPerRequest: null`; handing it the cache client makes it throw and
 * drop jobs. Same server, same REDIS_URL — different client options, on
 * purpose.
 */
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let connection: Redis | null = null;

const getConnection = (): Redis => {
  if (connection) return connection;
  connection = new Redis(REDIS_URL, {
    // Required by BullMQ — its blocking commands must not be retry-capped.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  let lastLog = 0;
  connection.on('error', (err: any) => {
    const now = Date.now();
    if (now - lastLog > 30_000) {
      console.warn('[Queue] Redis unavailable:', err?.code || err?.message);
      lastLog = now;
    }
  });
  return connection;
};

const queues = new Map<string, Queue>();

/** A named queue, created once per process. */
export const getQueue = (name: string): Queue => {
  const existing = queues.get(name);
  if (existing) return existing;
  const queue = new Queue(name, {
    connection: getConnection() as unknown as ConnectionOptions,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      // Keep a short history for debugging without growing Redis forever.
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  queue.on('error', (err: any) => console.warn(`[Queue:${name}] ${err?.message ?? err}`));
  queues.set(name, queue);
  return queue;
};

/**
 * Enqueue a job. NEVER throws — a queue that is down must not fail the request
 * that scheduled the work (a lead form submission must still succeed).
 * Returns whether the job was accepted, so callers can log honestly.
 */
export const enqueue = async (
  queueName: string,
  jobName: string,
  data: unknown,
  opts?: JobsOptions
): Promise<boolean> => {
  try {
    await getQueue(queueName).add(jobName, data, opts);
    return true;
  } catch (err: any) {
    console.error(`[Queue:${queueName}] Could not enqueue ${jobName}: ${err?.message ?? err}`);
    return false;
  }
};

/** Start a worker for a queue. Returns it so the caller can close it on shutdown. */
export const startWorker = (
  queueName: string,
  processor: Processor,
  concurrency = 5
): Worker => {
  const worker = new Worker(queueName, processor, {
    connection: getConnection() as unknown as ConnectionOptions,
    concurrency,
  });
  worker.on('failed', (job, err) =>
    console.error(`[Queue:${queueName}] Job ${job?.id} failed: ${err?.message ?? err}`)
  );
  worker.on('error', (err: any) => console.warn(`[Queue:${queueName}] ${err?.message ?? err}`));
  console.log(`[Queue:${queueName}] Worker started (concurrency ${concurrency}).`);
  return worker;
};

export { Queue, Worker };
export type { JobsOptions, Processor };
