import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

const varlock = 'node_modules/.bin/varlock';
const snapshot = process.argv[2];
// Every package points Varlock at the root schema, so one load covers them. These files are
// read around it: core takes .env from the package it runs in, and Prisma also takes prisma/.env.
const packageEnvFiles = ['apps/web/.env', 'apps/worker/.env', 'packages/core/.env', 'packages/core/prisma/.env'];

const directory = mkdtempSync(join(dirname(snapshot), 'scan-schema.'));
const schema = join(directory, '.env.schema');
// An inherited graph or filter must not shape the fresh load below.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^__?VARLOCK_/.test(key))),
  VARLOCK_TELEMETRY_DISABLED: 'true',
};

function scanStaged() {
  // A proxy child holds placeholders, so its scan matches nothing. It must not recover real values.
  if (Object.keys(process.env).some(key => /^__?VARLOCK_PROXY_/.test(key))) return 1;
  if (!/^[A-Z][A-Z0-9_]*=/m.test(readFileSync('.env.schema', 'utf8'))) return 1;

  // Cleared markers still leave the process tree. This schema has no private source to sign in to.
  writeFileSync(schema, '# @defaultRequired=false\n# ---\n# @sensitive=false @type=string\nSCAN_CONTEXT=1\n', { mode: 0o600 });
  const check = spawnSync(varlock, ['load', '--agent', '--format', 'json-full', '--path', schema, '--skip-cache'], {
    encoding: 'utf8',
    env: { ...env, SCAN_CONTEXT: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const context = JSON.parse(check.stdout);
  if (check.status !== 0 || !context.config?.SCAN_CONTEXT || context.runtime?.proxy?.active) return 1;

  const load = spawnSync(varlock, ['load', '--format', 'json-full', '--filter', '*', '--include-internal', '--skip-cache'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const graph = JSON.parse(load.stdout);
  if (load.status !== 0 || Object.keys(graph.config ?? {}).length === 0 || graph.runtime?.proxy?.active) return 1;

  const values = new Set(Object.values(graph.config).filter(item => item.isSensitive && typeof item.value === 'string' && item.value !== '').map(item => item.value));
  for (const file of packageEnvFiles.filter(path => existsSync(path))) {
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
      if (value !== '' && graph.config[key]?.isSensitive !== false) values.add(value);
    }
  }

  // Scan takes this exact set, so it never reads the store a second time. The file names the
  // variables and only the scanner's env holds the values.
  const scanEnv = { ...env };
  const declarations = [...values].map((value, index) => {
    const key = `SCAN_VALUE_${index}`;
    scanEnv[key] = value;
    return `# @sensitive @type=string\n${key}=`;
  });
  writeFileSync(schema, `# @defaultRequired=false\n# ---\n\n${declarations.join('\n\n')}\n`, { mode: 0o600 });
  return spawnSync(varlock, ['scan', snapshot, '--path', schema], { env: scanEnv, stdio: 'ignore' }).status === 0 ? 0 : 1;
}

try {
  process.exitCode = scanStaged();
} catch {
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
