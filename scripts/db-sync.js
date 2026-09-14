#!/usr/bin/env node
/**
 * Check, push, and generate Prisma clients for every service with a schema.
 *
 *   node scripts/db-sync.js                 # check → push → generate (all)
 *   node scripts/db-sync.js --check-only    # drift check only
 *   node scripts/db-sync.js --push-only      # db push only
 *   node scripts/db-sync.js --generate-only  # prisma generate only
 *   node scripts/db-sync.js --service auth-service
 *   node scripts/db-sync.js --accept-data-loss
 *
 * Loads env from repo root `.env`, then each service's `.env` if present.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const checkOnly = flag('--check-only') || flag('--dry-run');
const pushOnly = flag('--push-only');
const generateOnly = flag('--generate-only');
const acceptDataLoss = flag('--accept-data-loss');
const serviceFilter = flagValue('--service');

const runCheck = checkOnly || (!pushOnly && !generateOnly);
const runPush = pushOnly || (!checkOnly && !generateOnly);
const runGenerate = generateOnly || (!checkOnly && !generateOnly);

function loadEnvFiles(serviceDir) {
  require('dotenv').config({ path: path.join(REPO_ROOT, '.env') });
  const serviceEnv = path.join(serviceDir, '.env');
  if (fs.existsSync(serviceEnv)) {
    require('dotenv').config({ path: serviceEnv, override: true });
  }
}

function discoverServices() {
  if (!fs.existsSync(APPS_DIR)) return [];

  return fs
    .readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const cwd = path.join(APPS_DIR, entry.name);
      const schemaPath = path.join(cwd, 'prisma', 'schema.prisma');
      if (!fs.existsSync(schemaPath)) return null;
      return { name: entry.name, cwd, schemaPath };
    })
    .filter(Boolean)
    .filter((svc) => !serviceFilter || svc.name === serviceFilter)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readDatabaseEnvVar(schemaPath) {
  const content = fs.readFileSync(schemaPath, 'utf8');
  const match = content.match(/^\s*url\s*=\s*env\("([^"]+)"\)/m);
  return match ? match[1] : null;
}

function maskUrl(url) {
  if (!url) return '(missing)';
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${parsed.username.slice(0, 4)}…` : '';
    return `${parsed.protocol}//${user ? `${user}@` : ''}${parsed.host}${parsed.pathname}${parsed.search ? parsed.search.split('&schema=')[0] : ''}`;
  } catch {
    return '(invalid url)';
  }
}

function runPrisma(cwd, prismaArgs, env) {
  const result = spawnSync('npx', ['prisma', ...prismaArgs], {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: true,
  });
  return result.status ?? 1;
}

function header(title) {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

function discoverServicesOrExit() {
  const services = discoverServices();
  if (services.length === 0) {
    console.error(
      serviceFilter
        ? `No Prisma service found matching --service ${serviceFilter}`
        : 'No apps/*/prisma/schema.prisma files found.'
    );
    process.exit(1);
  }
  return services;
}

function main() {
  const services = discoverServicesOrExit();

  header('PRISMA DB SYNC');
  console.log(`Services : ${services.map((s) => s.name).join(', ')}`);
  console.log(`Steps    : ${[runCheck && 'check', runPush && 'push', runGenerate && 'generate'].filter(Boolean).join(' → ')}`);
  if (acceptDataLoss) console.log('Note     : --accept-data-loss is enabled for db push');

  const results = [];

  for (const service of services) {
    header(service.name);

    loadEnvFiles(service.cwd);

    const dbEnvVar = readDatabaseEnvVar(service.schemaPath);
    if (!dbEnvVar) {
      console.error(`Could not find url = env("…") in ${service.schemaPath}`);
      results.push({ service: service.name, ok: false, step: 'config' });
      continue;
    }

    const dbUrl = process.env[dbEnvVar];
    console.log(`Database : ${dbEnvVar} → ${maskUrl(dbUrl)}`);

    if (!dbUrl) {
      console.error(`Missing ${dbEnvVar}. Set it in .env or ${path.join(service.cwd, '.env')}.`);
      results.push({ service: service.name, ok: false, step: 'env' });
      continue;
    }

    const validateStatus = runPrisma(service.cwd, ['validate'], {});
    if (validateStatus !== 0) {
      results.push({ service: service.name, ok: false, step: 'validate' });
      continue;
    }

    if (runCheck) {
      console.log('\n[check] Comparing database to schema…');
      const diffArgs = [
        'migrate',
        'diff',
        '--exit-code',
        '--from-schema-datasource',
        'prisma/schema.prisma',
        '--to-schema-datamodel',
        'prisma/schema.prisma',
      ];
      const diffStatus = runPrisma(service.cwd, diffArgs, {});

      if (diffStatus === 2) {
        console.log('[check] Drift detected — schema is ahead of the database.');
        results.push({ service: service.name, ok: true, step: 'check', drift: true });
      } else if (diffStatus === 0) {
        console.log('[check] Database matches schema.');
        results.push({ service: service.name, ok: true, step: 'check', drift: false });
      } else {
        console.error('[check] Failed.');
        results.push({ service: service.name, ok: false, step: 'check' });
        continue;
      }
    }

    if (runPush) {
      console.log('\n[push] Applying schema to database…');
      const pushArgs = ['db', 'push'];
      if (acceptDataLoss) pushArgs.push('--accept-data-loss');
      const pushStatus = runPrisma(service.cwd, pushArgs, {});
      if (pushStatus !== 0) {
        results.push({ service: service.name, ok: false, step: 'push' });
        continue;
      }
    }

    if (runGenerate) {
      console.log('\n[generate] Regenerating Prisma client…');
      const generateStatus = runPrisma(service.cwd, ['generate'], {});
      if (generateStatus !== 0) {
        results.push({ service: service.name, ok: false, step: 'generate' });
        continue;
      }
    }

    results.push({ service: service.name, ok: true, step: 'done' });
  }

  header('SUMMARY');
  let failed = 0;
  for (const row of results) {
    if (!row.ok) {
      failed += 1;
      console.log(`  ✗ ${row.service} — failed at ${row.step}`);
    } else if (row.drift === true) {
      console.log(`  ~ ${row.service} — drift detected${runPush ? ' (pushed)' : ''}`);
    } else if (row.drift === false) {
      console.log(`  ✓ ${row.service} — in sync`);
    } else {
      console.log(`  ✓ ${row.service} — ok`);
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} service(s) failed.`);
    process.exit(1);
  }

  console.log('\nAll services completed successfully.');
}

main();
