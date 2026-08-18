import winston from 'winston';
import path from 'path';
import fs from 'fs';

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

winston.addColors(colors);

/**
 * Which service is logging. Under npm workspaces every service starts as
 * `npm run start -w @futurespark/<name>`, so npm_package_name identifies the
 * process; the cwd basename covers anything started another way.
 */
const serviceName = (process.env.npm_package_name || path.basename(process.cwd()))
  .replace(/^@futurespark\//, '')
  .replace(/[^a-z0-9-]/gi, '-');

// Console keeps the colourised format the terminals have always shown.
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => `[${info.timestamp}] [${info.level}]: ${info.message}`
  )
);

/**
 * File format is the same line WITHOUT ANSI colour codes and with a clean
 * millisecond timestamp, so the /logs viewer (and grep) can parse it:
 *   [2026-08-18 19:02:11.348] [info]: message
 */
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.printf(
    (info) => `[${info.timestamp}] [${info.level}]: ${info.message}`
  )
);

const transports: winston.transport[] = [
  new winston.transports.Console({ format: consoleFormat }),
];

/* ── Per-service log files ──────────────────────────────────────────────────
 * One rotating file per service under <repo-root>/logs/, so the admin's /logs
 * page can show every service's output in one place — including locally,
 * where nothing like pm2 captures stdout. __dirname is packages/logger/dist,
 * three levels below the repo root, identical in dev (ts-node resolves the
 * same tree) and in the build. LOG_TO_FILE=false turns it off; a failure to
 * create the directory silently degrades to console-only, because logging
 * must never be the thing that takes a service down.
 * ────────────────────────────────────────────────────────────────────────── */
if (process.env.LOG_TO_FILE !== 'false') {
  try {
    const logDir = path.resolve(__dirname, '../../../logs');
    fs.mkdirSync(logDir, { recursive: true });
    transports.push(
      new winston.transports.File({
        filename: path.join(logDir, `${serviceName}.log`),
        format: fileFormat,
        maxsize: 5 * 1024 * 1024, // rotate at 5 MB…
        maxFiles: 2,              // …keeping one previous generation
        tailable: true,
      })
    );
  } catch {
    /* console-only */
  }
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  levels,
  // No logger-level format: colorize() MUTATES info.level/info.message with
  // ANSI codes, and a logger-level format runs before every transport's — so
  // the colour codes were ending up inside the log files. Each transport owns
  // its whole chain instead.
  transports,
});

export default logger;
