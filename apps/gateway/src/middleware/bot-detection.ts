import { Request, Response, NextFunction } from 'express';
import logger from '@futurespark/logger';

/**
 * Non-Intrusive Bot & Headless Browser Detection Middleware.
 *
 * CRITICAL SECURITY REQUIREMENT:
 * This middleware operates strictly in MONITOR-ONLY mode.
 * It analyzes incoming request headers for automation / bot signatures,
 * logs findings for security observability, and ALWAYS passes control to next().
 *
 * It NEVER blocks, challenges, CAPTCHA-tests, logs out, or rejects any request.
 */
export const botDetectionMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  try {
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    const automationHeader = req.headers['x-automation-tool'] || req.headers['x-headless'];
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    // Automation & Bot Signatures
    const knownBotKeywords = [
      'puppeteer',
      'playwright',
      'selenium',
      'headlesschrome',
      'phantomjs',
      'webdriver',
      'python-requests',
      'python-urllib',
      'curl',
      'wget',
      'scrapy',
      'httpclient',
      'postmanruntime',
      'go-http-client',
      'java/',
      'axios',
    ];

    const matchedKeyword = knownBotKeywords.find((keyword) => userAgent.includes(keyword));

    if (matchedKeyword || automationHeader) {
      const riskLevel =
        userAgent.includes('headless') || userAgent.includes('selenium') || userAgent.includes('puppeteer')
          ? 'HIGH'
          : 'MEDIUM';

      logger.warn(
        `[Security Monitor][BotDetector] Suspicious bot/automation signal detected. ` +
          `Risk: ${riskLevel} | IP: ${clientIp} | Keyword: "${matchedKeyword || automationHeader}" | ` +
          `UA: "${userAgent.slice(0, 100)}" | Route: ${req.method} ${req.originalUrl}`
      );
    }
  } catch (err: any) {
    // Fail-Safe: Security logging failure must NEVER disrupt user request processing
    logger.error(`[BotDetector] Error in bot detection monitor: ${err?.message}`);
  } finally {
    next();
  }
};
