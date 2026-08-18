import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';

/**
 * GET /api/logs — the merged tail of every service's log file, for the
 * admin's terminal-style /logs page.
 *
 * The shared logger writes one rotating plain-text file per service under
 * <repo-root>/logs/ (see packages/logger). This endpoint reads the tail of
 * each, parses the `[timestamp] [level]: message` lines (continuation lines —
 * stack traces — attach to the entry above them), merges across services by
 * timestamp and serves the newest window. Reading files rather than proxying
 * pm2 keeps it identical in dev and production.
 *
 * ADMIN-only: logs contain student names and provider errors.
 */

const LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[.:](\d{1,4})\] \[(\w+)\]:? ?(.*)$/;

/** How much of each file's tail to read. 400 KB ≈ several thousand lines. */
const TAIL_BYTES = 400 * 1024;

interface LogLine {
  ts: string;       // "2026-08-18 19:59:44.383"
  sortKey: number;  // ms epoch for merging
  service: string;
  level: string;
  message: string;
}

const readTail = (filePath: string): string => {
  const size = fs.statSync(filePath).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // Drop the first line when we started mid-file — it is almost surely cut.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
};

const parseFile = (filePath: string, service: string): LogLine[] => {
  const lines: LogLine[] = [];
  for (const raw of readTail(filePath).split('\n')) {
    if (raw.trim().length === 0) continue;
    const match = raw.match(LINE_RE);
    if (match) {
      const [, ts, ms, level, message] = match;
      lines.push({
        ts: `${ts}.${ms.padEnd(3, '0').slice(0, 3)}`,
        sortKey: new Date(`${ts.replace(' ', 'T')}.${ms.padEnd(3, '0').slice(0, 3)}`).getTime(),
        service,
        level: level.toLowerCase(),
        message,
      });
    } else if (lines.length > 0) {
      // Continuation (stack trace line) — belongs to the previous entry.
      lines[lines.length - 1].message += `\n${raw}`;
    }
  }
  return lines;
};

export const logsRouter = Router();

logsRouter.get('/', (req: Request, res: Response) => {
  if (String(req.headers['x-user-role'] ?? '').toUpperCase() !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Only an admin can read the service logs.' });
  }

  try {
    const logDir = path.resolve(__dirname, '../../../../logs');
    if (!fs.existsSync(logDir)) {
      return res.json({
        success: true,
        message: 'No log files yet.',
        data: { lines: [], services: [], note: 'Log files appear after the services log their first line under the new logger.' },
      });
    }

    // <service>.log plus winston's rotated <service>1.log generation.
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
    const services = [...new Set(files.map((f) => f.replace(/\d*\.log$/, '')))].sort();

    const wantService = typeof req.query.service === 'string' && req.query.service ? req.query.service : null;
    const wantLevel = typeof req.query.level === 'string' && req.query.level ? req.query.level.toLowerCase() : null;
    const query = typeof req.query.q === 'string' && req.query.q ? req.query.q.toLowerCase() : null;
    const limit = Math.min(2000, Math.max(20, Number(req.query.limit) || 300));

    let all: LogLine[] = [];
    for (const file of files) {
      const service = file.replace(/\d*\.log$/, '');
      if (wantService && service !== wantService) continue;
      try {
        all = all.concat(parseFile(path.join(logDir, file), service));
      } catch {
        /* a rotating file can vanish mid-read; skip it */
      }
    }

    if (wantLevel) all = all.filter((l) => l.level === wantLevel);
    if (query) all = all.filter((l) => l.message.toLowerCase().includes(query));

    // Chronological; serve the newest window.
    all.sort((a, b) => a.sortKey - b.sortKey);
    const lines = all.slice(-limit);

    res.json({ success: true, message: 'Logs loaded.', data: { lines, services, truncated: all.length > limit } });
  } catch (err: any) {
    res.status(500).json({ success: false, message: `Could not read the log files: ${err.message}` });
  }
});
