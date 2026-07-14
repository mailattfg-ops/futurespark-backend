import Redis from 'ioredis';

let redisClient: Redis | null = null;

/**
 * Creates and returns a singleton Redis client instance.
 * Uses REDIS_URL environment variable or defaults to localhost:6379.
 */
export const createRedisClient = (url?: string): Redis => {
  if (redisClient) return redisClient;

  const connectionUrl = url || process.env.REDIS_URL || 'redis://localhost:6379';
  redisClient = new Redis(connectionUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 2000);
      return delay;
    },
    enableReadyCheck: true,
    lazyConnect: false,
  });

  redisClient.on('error', (err) => {
    console.error('[Redis] Connection error:', err.message);
  });

  redisClient.on('connect', () => {
    console.log('[Redis] Connected successfully');
  });

  return redisClient;
};

/**
 * Returns the existing Redis client or creates a new one.
 */
export const getRedisClient = (): Redis => {
  if (!redisClient) {
    return createRedisClient();
  }
  return redisClient;
};

/**
 * Gracefully disconnects the Redis client.
 */
export const disconnectRedis = async (): Promise<void> => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
};

// ── Typed Helpers ──────────────────────────────────────────────

/**
 * Set a key with an optional TTL (in seconds).
 */
export const cacheSet = async (key: string, value: string, ttlSeconds?: number): Promise<void> => {
  const client = getRedisClient();
  if (ttlSeconds) {
    await client.set(key, value, 'EX', ttlSeconds);
  } else {
    await client.set(key, value);
  }
};

/**
 * Get a value by key. Returns null if not found.
 */
export const cacheGet = async (key: string): Promise<string | null> => {
  const client = getRedisClient();
  return client.get(key);
};

/**
 * Delete a key.
 */
export const cacheDel = async (key: string): Promise<void> => {
  const client = getRedisClient();
  await client.del(key);
};

/**
 * Check if a key exists. Returns true if the key is present.
 */
export const cacheExists = async (key: string): Promise<boolean> => {
  const client = getRedisClient();
  const result = await client.exists(key);
  return result === 1;
};

/**
 * Set a key only if it does not exist (NX). Returns true if the lock was acquired.
 * Used for distributed idempotency locks.
 */
export const cacheSetnx = async (key: string, value: string, ttlSeconds: number): Promise<boolean> => {
  const client = getRedisClient();
  const result = await client.set(key, value, 'EX', ttlSeconds, 'NX');
  return result === 'OK';
};

export { Redis };