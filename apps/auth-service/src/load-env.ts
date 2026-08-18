import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

/**
 * Side-effect module: loads environment variables.
 *
 * MUST stay the first import in server.ts. TypeScript emits CommonJS `require`
 * calls in import order, so calling dotenv.config() in the body of server.ts
 * runs *after* `./app` and its whole module graph have already loaded — any
 * module-scope `process.env.X` read would see undefined.
 *
 * There is exactly ONE .env, at the repo root, and it is resolved from
 * __dirname rather than process.cwd(). npm workspaces run each service with
 * cwd set to its own directory, so a bare dotenv.config() would read
 * apps/<service>/.env — which is how a stale per-service file came to shadow
 * the real one and leave the gateway running on dev secrets. Those files are
 * deleted; this path is the only source. __dirname sits the same distance from
 * the root in src/ (ts-node) and dist/ (built), so one path covers both.
 */
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

/**
 * Warn if a per-service .env reappears.
 *
 * Nothing reads it any more, so an edit made there would take no effect and
 * give no clue why. Historically apps/gateway/.env shadowed the root file and
 * ran the gateway on dev secrets for months. Say so loudly rather than let it
 * happen twice.
 */
const stray = path.resolve(__dirname, '../.env');
if (fs.existsSync(stray)) {
  console.warn(
    '[env] ' + stray + ' exists but is NOT loaded. All configuration lives in ' +
    'the repo-root .env. Move any keys you need there and delete this file.'
  );
}
