import { execFile, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../packages/core/src/security';
import { requireSecret } from '../packages/core/src/config';
import { sealedEnv } from './no-keyring';

const ROOT = resolve(__dirname, '..');
const VARLOCK = join(ROOT, 'node_modules/.bin/varlock');
const SCHEMA = readFileSync(join(ROOT, '.env.schema'), 'utf8');
const PROJECT_ID = '76b72f55-2f1e-424e-aca6-5ac48c441ac1';
const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
const CLIENT_SECRET = 'synthetic-client-secret-for-the-mock-store';
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');
const REQUIRED_WHEN_DEPLOYED = {
  '#web': ['DATABASE_URL', 'APP_URL', 'SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY'],
  '#worker': ['DATABASE_URL', 'TOKEN_ENCRYPTION_KEY'],
  '#db': ['DATABASE_URL'],
} as const;
const PLATFORM_VARIABLES = new Set(['HOSTNAME', 'NEXT_RUNTIME']);

type Run = { status: number; stdout: string; stderr: string };

/** A fake Infisical that answers Universal Auth and the raw secrets call. */
function mockStore(secrets: Record<string, string>, refuse = false) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.url!);
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (refuse) return reply(403, { message: 'refused' });
    if (req.url!.startsWith('/api/v1/auth/universal-auth/login')) return reply(200, { accessToken: 'synthetic-token', expiresIn: 3600, accessTokenMaxTTL: 3600, tokenType: 'Bearer' });
    if (req.headers.authorization !== 'Bearer synthetic-token') return reply(401, { message: 'unauthorized' });
    if (req.url!.startsWith('/api/v3/secrets/raw')) return reply(200, { secrets: Object.entries(secrets).map(([secretKey, secretValue]) => ({ secretKey, secretValue })), imports: [] });
    reply(404, { message: 'unexpected' });
  });
  const url = new Promise<string>(ready => server.listen(0, '127.0.0.1', () => ready(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  return { calls, url, close: () => new Promise(done => (server as Server).close(done)) };
}

describe('the environment contract', () => {
  let base: string, repo: string, home: string;
  const open: ReturnType<typeof mockStore>[] = [];
  const store = (secrets: Record<string, string> = {}, refuse = false) => { const s = mockStore(secrets, refuse); open.push(s); return s; };
  const profile = (text: string) => { mkdirSync(join(home, '.config/varlock'), { recursive: true }); writeFileSync(join(home, '.config/varlock/.env.infisical'), text); };
  const identity = () => profile(`INFISICAL_CLIENT_ID=${CLIENT_ID}\nINFISICAL_CLIENT_SECRET=${CLIENT_SECRET}\n`);
  const run = (args: string[], values: Record<string, string> = {}) => new Promise<Run>(done => {
    execFile(VARLOCK, args, { cwd: repo, env: sealedEnv(home, values), encoding: 'utf8', maxBuffer: 1 << 24 }, (error, stdout, stderr) => done({ status: error ? (error.code as number) ?? 1 : 0, stdout, stderr }));
  });
  /** Keys Varlock rejects. A failed load prints its report to stderr. */
  const invalid = async (values: Record<string, string>, args: string[] = []) => {
    const out = await run(['load', '--agent', '--format', 'json-full', ...args], values);
    if (out.status === 0) return [];
    return [...out.stderr.replace(/\x1b\[[0-9;]*m/g, '').matchAll(/^\S+ ([A-Z][A-Z0-9_]*)\*?(?:\s|$)/gmu)].map(match => match[1]).filter((key, index, all) => all.indexOf(key) === index);
  };
  const resolved = async (values: Record<string, string>, args: string[] = []) => {
    const out = await run(['load', '--format', 'json', ...args], values);
    expect(out.status, out.stderr).toBe(0);
    return JSON.parse(out.stdout) as Record<string, string | undefined>;
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'orbitdesk-env-contract-'));
    repo = join(base, 'repo');
    home = join(base, 'home');
    mkdirSync(repo);
    mkdirSync(home);
    for (const file of ['.env.schema', '.env.infisical']) copyFileSync(join(ROOT, file), join(repo, file));
    symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'));
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map(s => s.close()));
    rmSync(base, { recursive: true, force: true });
  });

  describe('profiles and required values', () => {
    it.each(Object.keys(REQUIRED_WHEN_DEPLOYED))('accepts a CI job with no values for %s', async filter => {
      expect(await invalid({ CI: 'true' }, ['--filter', filter])).toEqual([]);
    });
    it.each(Object.entries(REQUIRED_WHEN_DEPLOYED))('requires exactly the deployed set for %s', async (filter, required) => {
      const values = { ORBITDESK_ENV_PROFILE: 'deployed', ...(filter === '#worker' ? { APP_ROLE: 'worker' } : {}) };
      expect((await invalid(values, ['--filter', filter])).sort()).toEqual([...required].sort());
    });
    it('treats a Railway process as deployed without any other marker', async () => {
      expect((await invalid({ RAILWAY_ENVIRONMENT: 'production' }, ['--filter', '#db']))).toEqual(['DATABASE_URL']);
    });
    it('asks a build for no runtime value, even on Railway', async () => {
      expect(await invalid({ ORBITDESK_ENV_PROFILE: 'ci', RAILWAY_ENVIRONMENT: 'production' }, ['--filter', '#web'])).toEqual([]);
    });
    it('rejects an unknown profile', async () => {
      expect(await invalid({ ORBITDESK_ENV_PROFILE: 'staging' })).toContain('ORBITDESK_ENV_PROFILE');
    });
    it('treats next build on a laptop as a build, not as development', async () => {
      identity();
      const s = store();
      expect(await invalid({ NODE_ENV: 'production', INFISICAL_SITE_URL: await s.url }, ['--filter', '#web'])).toEqual([]);
      expect(s.calls).toEqual([]);
    });
    it('keeps the local workflow open when nothing is set', async () => {
      expect(await invalid({})).toEqual([]);
    });
    it('needs no worker secrets that the worker never reads', async () => {
      const values = { ORBITDESK_ENV_PROFILE: 'deployed', APP_ROLE: 'worker', DATABASE_URL: 'postgresql://u:p@db:5432/app', TOKEN_ENCRYPTION_KEY: VALID_KEY };
      expect(await invalid(values, ['--filter', '#worker'])).toEqual([]);
    });
  });

  describe('value checks', () => {
    it('rejects malformed values in every profile', async () => {
      const values = { DATABASE_URL: 'mysql://nope', APP_URL: 'not-a-url', SESSION_SECRET: 'short', TOKEN_ENCRYPTION_KEY: 'short', APP_ROLE: 'cron', PORT: '99999', ENABLE_DEMO: 'False', OPENROUTER_DATA_COLLECTION: 'maybe', MAX_TRIAGE_PER_DAY: 'abc', MAX_AUTO_DRAFTS_PER_DAY: '100abc', DEMO_RUNS_PER_DAY: '1.5', SYNC_INTERVAL_SECONDS: '-1' };
      for (const marker of [{}, { CI: 'true' }, { ORBITDESK_ENV_PROFILE: 'deployed' }]) {
        expect((await invalid({ ...values, ...marker })).sort()).toEqual(Object.keys(values).sort());
      }
    });
    it('accepts the shapes production uses', async () => {
      expect(await invalid({ ORBITDESK_ENV_PROFILE: 'deployed', DATABASE_URL: 'postgres://user:p%40ss@postgres.railway.internal:5432/railway?sslmode=require', APP_URL: 'https://web-production-cbebe.up.railway.app', SESSION_SECRET: 'x'.repeat(32), TOKEN_ENCRYPTION_KEY: VALID_KEY, ENABLE_DEMO: 'true', OPENROUTER_DATA_COLLECTION: 'deny', PORT: '3100', APP_ROLE: 'web' })).toEqual([]);
    });
    it('holds SESSION_SECRET to the same limit as the app', async () => {
      process.env.CONTRACT_SECRET = 'x'.repeat(31);
      expect(() => requireSecret('CONTRACT_SECRET')).toThrow();
      expect(await invalid({ SESSION_SECRET: process.env.CONTRACT_SECRET })).toEqual(['SESSION_SECRET']);
      process.env.CONTRACT_SECRET = 'x'.repeat(32);
      expect(requireSecret('CONTRACT_SECRET')).toHaveLength(32);
      expect(await invalid({ SESSION_SECRET: process.env.CONTRACT_SECRET })).toEqual([]);
      delete process.env.CONTRACT_SECRET;
    });
    it('accepts exactly the keys the credential format can use', async () => {
      const old = process.env.TOKEN_ENCRYPTION_KEY;
      const accepts = async (key: string) => { process.env.TOKEN_ENCRYPTION_KEY = key; return { app: (() => { try { encrypt('x'); return true; } catch { return false; } })(), schema: (await invalid({ TOKEN_ENCRYPTION_KEY: key })).length === 0 }; };
      try {
        for (const key of [VALID_KEY, VALID_KEY.replace(/=$/, ''), Buffer.alloc(32, 251).toString('base64url')]) expect(await accepts(key)).toEqual({ app: true, schema: true });
        for (const key of [Buffer.alloc(31, 7).toString('base64'), Buffer.alloc(33, 7).toString('base64')]) expect(await accepts(key)).toEqual({ app: false, schema: false });
      } finally {
        if (old === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = old;
      }
    });
    it('treats blank lines copied from .env.example as unset', async () => {
      writeFileSync(join(repo, '.env'), 'GOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=\nOPENROUTER_API_KEY=\nOPENROUTER_DATA_COLLECTION=\n');
      expect(await invalid({})).toEqual([]);
    });
    it('names a rejected secret without printing it', async () => {
      const secret = 'synthetic-rejected-secret';
      const out = await run(['load', '--format', 'json'], { SESSION_SECRET: secret, TOKEN_ENCRYPTION_KEY: secret });
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain('SESSION_SECRET');
      expect(out.stdout + out.stderr).not.toContain(secret);
    });
  });

  describe('the shared store', () => {
    it('serves development values from the store and reads the repo project', async () => {
      identity();
      const s = store({ OPENROUTER_API_KEY: 'synthetic-store-key', APP_URL: 'http://store.example' });
      const env = await resolved({ INFISICAL_SITE_URL: await s.url });
      expect(env.OPENROUTER_API_KEY).toBe('synthetic-store-key');
      expect(env.APP_URL).toBe('http://store.example');
      const secrets = s.calls.find(call => call.startsWith('/api/v3/secrets/raw'))!;
      expect(secrets).toContain(`workspaceId=${PROJECT_ID}`);
      expect(secrets).toContain('environment=dev');
    });
    it('keeps process env above .env.local above .env above the store', async () => {
      identity();
      const s = store({ AI_FAST_MODEL: 'store', AI_AGENT_MODEL: 'store', APP_URL: 'http://store.example', OPENROUTER_BASE_URL: 'http://store.example' });
      writeFileSync(join(repo, '.env'), 'AI_FAST_MODEL=dotenv\nAI_AGENT_MODEL=dotenv\nAPP_URL=http://dotenv.example\n');
      writeFileSync(join(repo, '.env.local'), 'AI_FAST_MODEL=local\nAI_AGENT_MODEL=local\n');
      const env = await resolved({ AI_FAST_MODEL: 'process', INFISICAL_SITE_URL: await s.url });
      expect(env).toMatchObject({ AI_FAST_MODEL: 'process', AI_AGENT_MODEL: 'local', APP_URL: 'http://dotenv.example', OPENROUTER_BASE_URL: 'http://store.example' });
    });
    it('does not let a blank .env line hide a store value', async () => {
      identity();
      const s = store({ OPENROUTER_API_KEY: 'synthetic-store-key' });
      writeFileSync(join(repo, '.env'), 'OPENROUTER_API_KEY=\n');
      expect((await resolved({ INFISICAL_SITE_URL: await s.url })).OPENROUTER_API_KEY).toBe('synthetic-store-key');
    });
    it('ignores store values the schema does not name', async () => {
      identity();
      const s = store({ NOT_IN_THE_SCHEMA: 'synthetic' });
      expect(await resolved({ INFISICAL_SITE_URL: await s.url })).not.toHaveProperty('NOT_IN_THE_SCHEMA');
    });
    it.each([
      ['CI', { CI: 'true' }],
      ['a production start', { ORBITDESK_ENV_PROFILE: 'deployed', DATABASE_URL: 'postgresql://u:p@db/app', APP_URL: 'https://app.example', SESSION_SECRET: 'x'.repeat(32), TOKEN_ENCRYPTION_KEY: VALID_KEY }],
      ['Railway', { RAILWAY_ENVIRONMENT: 'production', DATABASE_URL: 'postgresql://u:p@db/app', APP_URL: 'https://app.example', SESSION_SECRET: 'x'.repeat(32), TOKEN_ENCRYPTION_KEY: VALID_KEY }],
      ['the Docker build', { NODE_ENV: 'production', ORBITDESK_SHARED_SECRETS: 'off' }],
    ])('never reads the host profile or the store in %s', async (_, values) => {
      profile('INFISICAL_CLIENT_ID=not-a-valid-identity\nINFISICAL_CLIENT_SECRET=varlock("local:not-real-ciphertext")\n');
      const s = store({ OPENROUTER_API_KEY: 'synthetic-store-key' });
      const env = await resolved({ ...values, INFISICAL_SITE_URL: await s.url, INFISICAL_CLIENT_ID: CLIENT_ID, INFISICAL_CLIENT_SECRET: CLIENT_SECRET });
      expect(s.calls).toEqual([]);
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
    });
    it('does not depend on the store file in an image', async () => {
      rmSync(join(repo, '.env.infisical'));
      identity();
      expect(await invalid({ CI: 'true' })).toEqual([]);
    });
    it('falls back to local files when the machine has no profile', async () => {
      const s = store();
      writeFileSync(join(repo, '.env'), 'APP_URL=http://dotenv.example\n');
      expect((await resolved({ INFISICAL_SITE_URL: await s.url })).APP_URL).toBe('http://dotenv.example');
      expect(s.calls).toEqual([]);
    });
    it('treats an empty profile like a missing one', async () => {
      profile('');
      const s = store();
      expect(await invalid({ INFISICAL_SITE_URL: await s.url })).toEqual([]);
      expect(s.calls).toEqual([]);
    });
    it('stays on local values when asked to', async () => {
      identity();
      const s = store({ OPENROUTER_API_KEY: 'synthetic-store-key' });
      expect((await resolved({ ORBITDESK_SHARED_SECRETS: 'off', INFISICAL_SITE_URL: await s.url })).OPENROUTER_API_KEY).toBeUndefined();
      expect(s.calls).toEqual([]);
    });
    it('fails closed when the store refuses a configured identity', async () => {
      identity();
      const s = store({}, true);
      writeFileSync(join(repo, '.env'), 'APP_URL=http://dotenv.example\n');
      const out = await run(['load', '--format', 'json'], { INFISICAL_SITE_URL: await s.url });
      expect(s.calls.length).toBeGreaterThan(0);
      expect(out.status).not.toBe(0);
      expect(out.stdout).toBe('');
      expect(out.stderr).not.toContain(CLIENT_SECRET);
    });
    it('fails closed when the store cannot be reached', async () => {
      identity();
      const out = await run(['load', '--format', 'json'], { INFISICAL_SITE_URL: 'http://127.0.0.1:1' });
      expect(out.status).not.toBe(0);
      expect(out.stdout).toBe('');
      expect(out.stderr).not.toContain(CLIENT_SECRET);
    });
    it('fails closed when a profile has the identity but no secret', async () => {
      profile(`INFISICAL_CLIENT_ID=${CLIENT_ID}\n`);
      const s = store();
      const out = await run(['load', '--format', 'json'], { INFISICAL_SITE_URL: await s.url });
      expect(out.status).not.toBe(0);
      expect(out.stdout).toBe('');
      expect(s.calls.filter(call => call.includes('universal-auth'))).toEqual([]);
    });
    it('keeps the identity out of the processes it starts', async () => {
      identity();
      const s = store({ DATABASE_URL: 'postgresql://u:p@db/app', SESSION_SECRET: 'x'.repeat(32) });
      const out = await run(['run', '--filter', '#db', '--', process.execPath, '-p', 'JSON.stringify(Object.keys(process.env).filter(k=>/INFISICAL|SESSION_SECRET|DATABASE_URL/.test(k)))'], { INFISICAL_SITE_URL: await s.url });
      expect(out.stderr).toBe('');
      expect(JSON.parse(out.stdout)).toEqual(['DATABASE_URL']);
    });
  });

  describe('the local notice', () => {
    const notice = (values: Record<string, string> = {}) => new Promise<string>(done => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts/shared-secrets-notice.mjs')], { env: sealedEnv(home, values) });
      let text = '';
      child.stdout.on('data', chunk => { text += chunk; });
      child.stderr.on('data', chunk => { text += chunk; });
      child.on('close', status => { expect(status).toBe(0); done(text); });
    });
    it('says when only local files apply', async () => {
      expect(await notice()).toContain('only local env files apply');
      profile('');
      expect(await notice()).toContain('only local env files apply');
    });
    it('stays quiet when the machine is set up or opted out', async () => {
      expect(await notice({ ORBITDESK_SHARED_SECRETS: 'off' })).toBe('');
      identity();
      expect(await notice()).toBe('');
    });
    it('never prints the profile', async () => {
      identity();
      expect(await notice({ ORBITDESK_SHARED_SECRETS: 'off' })).not.toContain(CLIENT_SECRET);
    });
  });
});

describe('the schema file', () => {
  const declared = new Set([...SCHEMA.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]));
  function sources(path: string): string[] {
    if (statSync(path).isFile()) return [path];
    return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? entry.name === 'node_modules' ? [] : sources(join(path, entry.name)) : ['.ts', '.tsx', '.prisma'].includes(extname(entry.name)) ? [join(path, entry.name)] : []);
  }
  function read(paths: string[]) {
    const names = new Set<string>();
    for (const file of paths.flatMap(path => sources(join(ROOT, path)))) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of [/process\.env\.([A-Z][A-Z0-9_]+)/g, /process\.env\['([A-Z][A-Z0-9_]+)'\]/g, /requireSecret\('([A-Z][A-Z0-9_]+)'\)/g, /cap\('([A-Z][A-Z0-9_]+)'/g, /env\("([A-Z][A-Z0-9_]+)"\)/g]) {
        for (const match of text.matchAll(pattern)) names.add(match[1]);
      }
    }
    return [...names].filter(name => !PLATFORM_VARIABLES.has(name));
  }
  const tagged = (tag: string) => {
    const names = new Set<string>();
    for (const [, block, name] of SCHEMA.matchAll(/((?:^#.*\n)+)^([A-Z][A-Z0-9_]*)=/gm)) if (new RegExp(`@tag\\([^)]*\\b${tag}\\b`).test(block)) names.add(name);
    return names;
  };

  it('declares every variable the runtimes read', () => {
    expect(read(['apps/web/src', 'apps/web/next.config.ts', 'apps/worker/src', 'packages/core/src', 'packages/core/prisma']).filter(name => !declared.has(name))).toEqual([]);
  });
  it('declares every variable in .env.example', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    expect([...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]).filter(name => !declared.has(name))).toEqual([]);
  });
  it('gives the worker what it can reach through the shared core', () => {
    const webOnly = ['BETA_EMAILS', 'ENABLE_DEMO', 'SESSION_SECRET'];
    const worker = tagged('worker');
    expect(read(['packages/core/src', 'packages/core/prisma']).filter(name => !worker.has(name) && !webOnly.includes(name))).toEqual([]);
  });
  it('gives the web app what it can reach through the shared core', () => {
    const web = tagged('web');
    expect(read(['packages/core/src', 'packages/core/prisma']).filter(name => !web.has(name) && name !== 'SYNC_INTERVAL_SECONDS')).toEqual([]);
  });
  it('holds no value beyond the profile rule', () => {
    expect([...SCHEMA.matchAll(/^([A-Z][A-Z0-9_]*)=(.+)$/gm)].map(match => match[1])).toEqual(['ORBITDESK_ENV_PROFILE']);
  });
  it('declares nothing the browser build would inline', () => {
    expect([...declared].filter(name => name.startsWith('NEXT_PUBLIC_'))).toEqual([]);
  });
  it('keeps user-visible values out of the sensitive set', () => {
    for (const name of ['BETA_EMAILS', 'GOOGLE_CLIENT_ID', 'APP_URL']) expect(SCHEMA).toMatch(new RegExp(`@sensitive=false[^\\n]*\\n${name}=|@sensitive=false[^\\n]*\\n#[^\\n]*\\n${name}=`));
  });
  it('points the store at the Orbitdesk project and holds no identity', () => {
    const store = readFileSync(join(ROOT, '.env.infisical'), 'utf8');
    expect(store).toContain(`INFISICAL_PROJECT_ID=${PROJECT_ID}`);
    expect(store).toContain('INFISICAL_SITE_URL=https://eu.infisical.com');
    expect(store).toContain('INFISICAL_ENVIRONMENT=dev');
    expect(store).toMatch(/^INFISICAL_CLIENT_ID=$/m);
    expect(store).toMatch(/^INFISICAL_CLIENT_SECRET=$/m);
    expect(store).toContain('@import(~/.config/varlock/.env.infisical, enabled=forEnv(development), allowMissing=true)');
  });
});

describe('the deployment surfaces', () => {
  const file = (path: string) => readFileSync(join(ROOT, path), 'utf8');
  const scripts = (path: string) => (JSON.parse(file(path)) as { scripts: Record<string, string> }).scripts;
  const lines = (path: string) => file(path).split('\n').map(line => line.trim());

  it('keeps the schema in the image and the store file out of it', () => {
    const ignore = lines('.dockerignore');
    expect(ignore.at(-2)).toBe('!.env.schema');
    expect(ignore).toContain('.env.*');
    expect(ignore).not.toContain('!.env.infisical');
  });
  it('turns the store and telemetry off across the image build and runtime', () => {
    const docker = file('Dockerfile');
    expect(docker.indexOf('ENV ORBITDESK_SHARED_SECRETS=off VARLOCK_TELEMETRY_DISABLED=true')).toBeGreaterThan(-1);
    expect(docker.indexOf('ENV ORBITDESK_SHARED_SECRETS=off')).toBeLessThan(docker.indexOf('pnpm install'));
    expect(docker).not.toContain('.env.infisical');
  });
  it('turns telemetry off in CI', () => {
    expect(file('.github/workflows/ci.yml')).toContain("VARLOCK_TELEMETRY_DISABLED: 'true'");
  });
  it('turns telemetry off in every script that reaches Varlock', () => {
    const all = [...Object.values(scripts('apps/web/package.json')), ...Object.values(scripts('apps/worker/package.json')), ...Object.values(scripts('packages/core/package.json')), ...Object.values(scripts('package.json'))];
    expect(all.filter(script => /\b(varlock|next) /.test(script) && !script.includes('pnpm --filter') && !script.includes('VARLOCK_TELEMETRY_DISABLED=true'))).toEqual([]);
  });
  it('commits the files the schema depends on', () => {
    const ignore = lines('.gitignore');
    expect(ignore).toContain('!.env.schema');
    expect(ignore).toContain('!.env.infisical');
    expect(ignore).toContain('.env');
    expect(ignore).toContain('.env.*');
  });
  it('validates each production process before it starts', () => {
    expect(scripts('apps/web/package.json').start).toContain('ORBITDESK_ENV_PROFILE=deployed');
    expect(scripts('apps/web/package.json').build).toContain('ORBITDESK_ENV_PROFILE=ci');
    expect(scripts('apps/worker/package.json').start).toMatch(/ORBITDESK_ENV_PROFILE=deployed.*varlock load --format json >\/dev\/null && exec tsx src\/index\.ts$/);
    expect(scripts('packages/core/package.json')['db:migrate']).toContain('varlock run --');
  });
  it('points each package at the one schema', () => {
    for (const [path, filter] of [['apps/web/package.json', '#web'], ['apps/worker/package.json', '#worker'], ['packages/core/package.json', '#db']] as const) {
      expect((JSON.parse(file(path)) as { varlock: unknown }).varlock).toEqual({ loadPath: '../../', filter });
      expect(resolve(ROOT, dirname(path), '../../')).toBe(ROOT);
    }
  });
  it('builds on every push unless a watch list names the schema', () => {
    const railway = file('railway.toml');
    if (railway.includes('watchPatterns')) expect(railway).toContain('.env.schema');
  });
  it('locks the Next env loader to the direct integration pin', () => {
    const lock = file('pnpm-lock.yaml');
    const pin = (JSON.parse(file('apps/web/package.json')) as { dependencies: Record<string, string> }).dependencies['@varlock/nextjs-integration'];
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock).toContain(`'@next/env': npm:@varlock/nextjs-integration@${pin}\n`);
    const loaders = [...lock.matchAll(/^ +'@next\/env': (\S+)/gm)].map(match => match[1]);
    expect(loaders.length).toBeGreaterThan(0);
    for (const loader of loaders.filter(value => !value.startsWith('npm:'))) expect(loader).toMatch(new RegExp(`^'?@varlock/nextjs-integration@${pin.replaceAll('.', '\\.')}\\(`));
    expect([...lock.matchAll(/^  '?@next\/env@/gm)]).toEqual([]);
  });
  it('keeps one Varlock version across the workspace', () => {
    const lock = file('pnpm-lock.yaml');
    expect([...new Set([...lock.matchAll(/^  varlock@([^:(]+):$/gm)].map(match => match[1]))]).toEqual(['1.24.0']);
    for (const path of ['package.json', 'apps/web/package.json', 'apps/worker/package.json', 'packages/core/package.json']) expect(file(path)).toContain('"varlock": "1.24.0"');
  });
});
