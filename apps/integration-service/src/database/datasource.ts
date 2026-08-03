import { PrismaClient } from '../../prisma/client';
import { logger } from '@futurespark/logger';

export const db = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
});

export async function withDbRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 200): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (err.message && (err.message.includes('10054') || err.message.includes('TLS') || err.message.includes('Can\'t reach database'))) {
        logger.warn(`[DbRetry] Transient DB connection issue. Retrying query ${i + 1}/${retries}...`);
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

export default db;
