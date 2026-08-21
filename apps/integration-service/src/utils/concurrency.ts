import { logger } from '@futurespark/logger';

/**
 * Counting semaphore for bounding expensive background work.
 *
 * The recording pipeline fans out per class: when N classes end in the same
 * window the sync cron previously launched N Drive downloads, N ffmpeg
 * processes and N Groq jobs simultaneously with no ceiling. On a 1-to-1
 * platform N is the number of concurrent classes, so this scales with usage
 * and saturates network, CPU and disk together.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number, private readonly name: string) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    logger.info(`[Semaphore:${this.name}] at capacity (${this.limit}) — queueing (${this.waiters.length + 1} waiting)`);
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  get stats() {
    return { name: this.name, active: this.active, queued: this.waiters.length, limit: this.limit };
  }
}

/**
 * Coalesces concurrent calls for the same key onto a single in-flight promise.
 *
 * Without this, every poll of the transcript endpoint re-triggers a download for
 * a recording that is already downloading, so one slow 800 MB fetch can spawn
 * many duplicates writing to the same destination path.
 */
export function createInFlightMap<T>(name: string) {
  const inFlight = new Map<string, Promise<T>>();

  return {
    run(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key);
      if (existing) {
        logger.info(`[InFlight:${name}] joining existing job for ${key} (no duplicate started)`);
        return existing;
      }
      const p = fn().finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      return p;
    },
    get size() {
      return inFlight.size;
    },
  };
}

/**
 * ONE in-flight map for audio extraction, shared by every provider.
 *
 * Google and Zoom each had their own, and both write into the same
 * downloads/audio directory — so the two never saw each other and could run
 * ffmpeg against the same output file at the same time. They also used
 * different sample rates, which is how a file ended up holding 48 kHz frames
 * labelled 16 kHz: three times too long, unintelligible to the transcriber,
 * and reporting a 14,092-hour duration to the player.
 *
 * Keyed by recording id, which is unique across providers and is embedded in
 * the output filename — so two jobs that would write the same file always
 * share a key, and the second joins the first instead of racing it.
 */
export const audioExtractionsInFlight = createInFlightMap<string>('extract-audio');
