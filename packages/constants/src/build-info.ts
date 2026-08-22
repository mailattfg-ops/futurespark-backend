import fs from 'fs';
import path from 'path';

/**
 * What is actually running, right now, in this process.
 *
 * "Did the fix deploy?" has been answered three times in a row by guessing, and
 * guessing was wrong at least once. A timestamp is not enough either: an
 * incremental build can leave the entry file untouched, and a stale `dist`
 * served by a process nobody restarted looks identical to a fresh one.
 *
 * So the honest signal is a list of CAPABILITY NAMES compiled into the code.
 * Each name is added in the same commit as the behaviour it describes, which
 * means the name cannot appear unless that code is the code being executed. A
 * missing name is proof the build predates the fix — not a hint, proof.
 */

export interface BuildInfo {
  service: string;
  /** When this process started — a restart resets it. */
  startedAt: string;
  uptimeSeconds: number;
  /** Newest file in the running build. Null when it cannot be read. */
  builtAt: string | null;
  /** Behaviours present in THIS build. Absence is meaningful. */
  capabilities: string[];
}

/** Walk the running build once and take the newest mtime. */
const newestBuildTime = (): string | null => {
  try {
    const entry = process.argv[1];
    if (!entry) return null;
    const root = fs.existsSync(entry) && fs.statSync(entry).isDirectory() ? entry : path.dirname(entry);

    let newest = 0;
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) walk(full, depth + 1);
        else if (name.endsWith('.js') && stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    };
    walk(root, 0);
    return newest > 0 ? new Date(newest).toISOString() : null;
  } catch {
    return null;
  }
};

// Computed once: the build cannot change under a running process, and walking
// the tree on every health poll would be pointless work.
const BUILT_AT = newestBuildTime();
const STARTED_AT = new Date().toISOString();

export const buildInfo = (service: string, capabilities: string[]): BuildInfo => ({
  service,
  startedAt: STARTED_AT,
  uptimeSeconds: Math.round(process.uptime()),
  builtAt: BUILT_AT,
  capabilities,
});
