import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockStore } from './mock-store';
import { sealedEnv } from './no-keyring';

const ROOT = resolve(__dirname, '..');
const VARLOCK = join(ROOT, 'node_modules/.bin/varlock');
const SECRET = 'synthetic-session-secret-value-0123456789';
const OTHER_SECRET = 'synthetic-google-client-secret-9876543210';
const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
const CLIENT_SECRET = 'synthetic-client-secret-for-the-mock-store';
const CLEAN = 'echo clean\n';
const LEAK = `echo ${SECRET}\n`;
const COMMIT = ['commit', '--message', 'Add the deploy step'];
const NOTICE = 'Secret scan failed. Check staged files and secret-store access, and commit outside the credential proxy. See docs/SECRETS.md.';
const PACKAGE_ENV_FILES = [...['apps', 'packages'].flatMap(group => readdirSync(join(ROOT, group)).map(name => `${group}/${name}/.env`)), 'packages/core/prisma/.env'];

function repoFixture() {
  const base = mkdtempSync(join(tmpdir(), 'orbitdesk-pre-commit-'));
  const repo = join(base, 'repo'), home = join(base, 'home'), scratch = join(base, 'scratch[0]');
  for (const dir of [repo, home, scratch]) mkdirSync(dir);
  for (const path of ['.env.schema', '.env.infisical', '.githooks/pre-commit', 'scripts/scan-staged.mjs']) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(repo, path));
  }
  writeFileSync(join(repo, '.gitignore'), '.env\n.env.*\n!.env.schema\n!.env.infisical\nnode_modules\n');
  writeFileSync(join(repo, '.env'), `SESSION_SECRET=${SECRET}\n`);
  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'));
  const env = (values: Record<string, string> = {}) => sealedEnv(home, { TMPDIR: scratch, GIT_AUTHOR_NAME: 'Orbitdesk Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Orbitdesk Test', GIT_COMMITTER_EMAIL: 'test@example.com', ...values });
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: env() });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, stdout: result.stdout };
  };
  git('init', '--quiet', '--initial-branch=main');
  git('add', '.');
  git('commit', '--quiet', '--no-verify', '--message', 'Set up the fixture');
  git('config', 'core.hooksPath', '.githooks');
  return { base, repo, home, scratch, env, git };
}

describe('pre-commit secret scan', () => {
  let fixture: ReturnType<typeof repoFixture>;
  const file = (name: string) => join(fixture.repo, name);
  const headFiles = () => fixture.git('ls-tree', '--name-only', 'HEAD').stdout.split('\n');
  const snapshots = () => readdirSync('/tmp').filter(name => name.startsWith('orbitdesk-staged.'));
  const stage = (text: string, path = 'deploy.sh') => {
    writeFileSync(file(path), text);
    fixture.git('add', path);
  };
  const blocked = (commit: { status: number | null; output: string }, ...hidden: string[]) => {
    expect(commit.status).not.toBe(0);
    expect(commit.output).toContain('Secret scan failed.');
    for (const value of [SECRET, ...hidden]) expect(commit.output).not.toContain(value);
  };
  /** For a run that reaches the mock store: a synchronous spawn would block its event loop. */
  const run = (command: string, args: string[], values: Record<string, string> = {}) => new Promise<{ status: number | null; output: string }>(done => {
    const child = spawn(command, args, { cwd: fixture.repo, env: fixture.env(values) });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
    child.on('close', status => done({ status, output }));
  });
  /** A real proxy child: it must hold a placeholder, and it commits through the normal hook. */
  const commitFromProxy = (scrub: boolean, values: Record<string, string> = {}, prepare = '') => run(VARLOCK, ['proxy', 'run', '--', process.execPath, '-e', `
    const { spawnSync } = require('node:child_process');
    if (!process.env.__VARLOCK_PROXY_CHILD || process.env.SESSION_SECRET === ${JSON.stringify(SECRET)}) process.exit(99);
    ${prepare}
    if (${scrub}) for (const name of Object.keys(process.env)) if (/^__?VARLOCK_/.test(name)) delete process.env[name];
    process.exit(spawnSync('git', ${JSON.stringify(COMMIT)}, { stdio: 'inherit' }).status ?? 1);`], values);

  beforeEach(() => { fixture = repoFixture(); });
  afterEach(() => {
    rmSync(file('node_modules'), { recursive: true, force: true });
    rmSync(fixture.base, { recursive: true, force: true });
  });

  it('blocks a staged secret that only the working copy has dropped', () => {
    const before = snapshots();
    stage(LEAK);
    writeFileSync(file('deploy.sh'), CLEAN);
    blocked(fixture.git('commit', '--message', 'Add the deploy step'));
    expect(headFiles()).not.toContain('deploy.sh');
    expect(fixture.git('show', ':deploy.sh').stdout).toBe(LEAK);
    expect(readFileSync(file('deploy.sh'), 'utf8')).toBe(CLEAN);
    expect(snapshots()).toEqual(before);
    expect(readdirSync(fixture.scratch)).toEqual([]);
  });
  it('commits a clean staged version while the working copy holds a secret', () => {
    stage(CLEAN);
    writeFileSync(file('deploy.sh'), LEAK);
    expect(fixture.git('commit', '--message', 'Add the deploy step').status).toBe(0);
    expect(fixture.git('show', 'HEAD:deploy.sh').stdout).toBe(CLEAN);
    expect(readFileSync(file('deploy.sh'), 'utf8')).toBe(LEAK);
  });
  it('scans only the staged half of a partly staged file', () => {
    stage(`${CLEAN}${CLEAN}`);
    fixture.git('commit', '--no-verify', '--message', 'Add the deploy step');
    stage(`${LEAK}${CLEAN}`);
    writeFileSync(file('deploy.sh'), `${CLEAN}${CLEAN}`);
    blocked(fixture.git('commit', '--message', 'Change the deploy step'));
    stage(`${CLEAN}${CLEAN}`);
    writeFileSync(file('deploy.sh'), `${LEAK}${CLEAN}`);
    expect(fixture.git('commit', '--allow-empty', '--message', 'Change nothing staged').status).toBe(0);
  });
  it('checks the working copy when a path commit will take it', () => {
    stage(CLEAN);
    writeFileSync(file('deploy.sh'), LEAK);
    blocked(fixture.git('commit', '--message', 'Add the deploy step', '--', 'deploy.sh'));
  });
  it('follows a staged rename to the content in the index', () => {
    stage(CLEAN.repeat(4), 'old-name.sh');
    fixture.git('commit', '--no-verify', '--message', 'Add the old name');
    fixture.git('mv', 'old-name.sh', 'new-name.sh');
    stage(`${CLEAN.repeat(4)}${LEAK}`, 'new-name.sh');
    writeFileSync(file('new-name.sh'), CLEAN);
    blocked(fixture.git('commit', '--message', 'Rename the script'));
  });
  it('lets a commit delete a file that held a secret', () => {
    stage(LEAK, 'leaked.sh');
    fixture.git('commit', '--no-verify', '--message', 'Add the leak');
    fixture.git('rm', '--quiet', 'leaked.sh');
    stage(CLEAN, 'clean.sh');
    expect(fixture.git('commit', '--message', 'Remove the leak').status).toBe(0);
    expect(headFiles()).not.toContain('leaked.sh');
    expect(existsSync(file('leaked.sh'))).toBe(false);
  });
  it('reads nested paths, spaces and folders a directory walk would skip', () => {
    for (const path of ['deploy steps/first step.sh', 'dist/bundle.js', '.next/cache.js', 'vendor/lib.js', '.env.example']) {
      mkdirSync(dirname(file(path)), { recursive: true });
      writeFileSync(file(path), LEAK);
      fixture.git('add', '--force', path);
      writeFileSync(file(path), CLEAN);
      blocked(fixture.git('commit', '--message', 'Add a file'));
      fixture.git('rm', '--quiet', '--cached', path);
    }
  });
  it('scans a file that replaced a symlink, and commits a clean one', () => {
    symlinkSync('.gitignore', file('deploy.sh'));
    fixture.git('add', 'deploy.sh');
    fixture.git('commit', '--no-verify', '--message', 'Link the deploy step');
    unlinkSync(file('deploy.sh'));
    stage(LEAK);
    expect(fixture.git('diff', '--cached', '--name-status').stdout).toBe('T\tdeploy.sh\n');
    blocked(fixture.git(...COMMIT));
    stage(CLEAN);
    expect(fixture.git('diff', '--cached', '--name-status').stdout).toBe('T\tdeploy.sh\n');
    expect(fixture.git(...COMMIT).status).toBe(0);
    expect(fixture.git('show', 'HEAD:deploy.sh').stdout).toBe(CLEAN);
  });
  it('never prints either secret when both appear on one staged line', () => {
    writeFileSync(file('.env'), `SESSION_SECRET=${SECRET}\nGOOGLE_CLIENT_SECRET=${OTHER_SECRET}\n`);
    stage(`echo ${SECRET} ${OTHER_SECRET}\n`);
    blocked(fixture.git('commit', '--message', 'Add the deploy step'), OTHER_SECRET);
    expect(headFiles()).not.toContain('deploy.sh');
  });
  it('commits a clean file when no env file holds a value', () => {
    rmSync(file('.env'));
    stage(CLEAN);
    expect(fixture.git(...COMMIT).status).toBe(0);
  });
  it('still refuses a plaintext frozen env file when no env file holds a value', () => {
    rmSync(file('.env'));
    stage('{"config":{}}\n', '.varlock-frozen-env');
    blocked(fixture.git(...COMMIT));
  });
  it.each(['.env', '.env.local', '.env.development', '.env.development.local', ...PACKAGE_ENV_FILES])('blocks a staged value only %s holds', source => {
    rmSync(file('.env'));
    mkdirSync(dirname(file(source)), { recursive: true });
    writeFileSync(file(source), `OPENROUTER_API_KEY=${SECRET}\n`);
    stage(LEAK);
    blocked(fixture.git(...COMMIT));
    expect(headFiles()).not.toContain('deploy.sh');
  });
  it('leaves a value the schema calls public alone in a package .env', () => {
    mkdirSync(file('apps/web'), { recursive: true });
    writeFileSync(file('apps/web/.env'), 'APP_URL=http://localhost:3100\nOPENROUTER_API_KEY=\n');
    stage('echo http://localhost:3100\n');
    expect(fixture.git(...COMMIT).status).toBe(0);
  });
  it.each([['missing', null], ['empty', ''], ['without a declaration', '# No declarations\n']])('will not call a scan clean when .env.schema is %s', (_, text) => {
    if (text === null) rmSync(file('.env.schema'));
    else writeFileSync(file('.env.schema'), text);
    stage(CLEAN);
    blocked(fixture.git(...COMMIT));
    expect(headFiles()).not.toContain('deploy.sh');
  });
  it('will not call a scan clean while a local value breaks the contract', () => {
    writeFileSync(file('.env'), 'SESSION_SECRET=short\n');
    stage(CLEAN);
    blocked(fixture.git(...COMMIT), 'short');
  });
  it('fails closed without printing anything when the scanner cannot run', () => {
    writeFileSync(file('.env.schema'), '# @plugin(not-a-real-plugin)\n# ---\n');
    stage(CLEAN);
    const commit = fixture.git('commit', '--message', 'Add the deploy step');
    expect(commit.status).not.toBe(0);
    expect(commit.output.trim()).toBe(NOTICE);
  });
  it('keeps every value out of the scan schema and the arguments', () => {
    const calls = join(fixture.base, 'varlock-calls');
    unlinkSync(file('node_modules'));
    mkdirSync(file('node_modules/.bin'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules/@varlock'), file('node_modules/@varlock'));
    writeFileSync(file('node_modules/.bin/varlock'), `#!/bin/sh\nprintf '%s\\n' "$*" >>'${calls}'\nif [ "$1" = scan ]; then cat "$4" >>'${calls}'; fi\nexec '${VARLOCK}' "$@"\n`);
    chmodSync(file('node_modules/.bin/varlock'), 0o755);
    stage(LEAK);
    blocked(fixture.git(...COMMIT));
    const seen = readFileSync(calls, 'utf8');
    expect(seen).toMatch(/^# @sensitive @type=string\nSCAN_VALUE_0=$/m);
    expect(seen).not.toContain(SECRET);
  });
  it('scans everything under an inherited graph or filter', async () => {
    const nested = ['run', '--filter', '#worker', '--', 'git', ...COMMIT];
    stage(LEAK);
    blocked(await run(VARLOCK, nested));
    blocked(await run('git', COMMIT, { _VARLOCK_FILTER: '#nothing' }));
    stage(CLEAN);
    expect((await run('git', COMMIT, { _VARLOCK_FILTER: '#nothing' })).status).toBe(0);
    stage(CLEAN, 'clean.sh');
    expect((await run(VARLOCK, nested)).status).toBe(0);
  });

  describe.each([['as it started', false], ['with its markers scrubbed', true]])('from a proxy child %s', (_, scrub) => {
    it('refuses a staged secret the working copy has dropped', async () => {
      const before = snapshots();
      stage(LEAK);
      writeFileSync(file('deploy.sh'), CLEAN);
      blocked(await commitFromProxy(scrub));
      expect(headFiles()).not.toContain('deploy.sh');
      expect(snapshots()).toEqual(before);
    });
    it('refuses a clean file, because placeholders cannot vouch for it', async () => {
      stage(CLEAN);
      blocked(await commitFromProxy(scrub));
      expect(headFiles()).not.toContain('deploy.sh');
    });
  });
  it('refuses proxy markers that outlive their session', async () => {
    stage(CLEAN);
    blocked(await run('git', COMMIT, { __VARLOCK_PROXY_SESSION_ID: 'ended-session' }));
  });

  describe('with an identity on the machine', () => {
    const open: ReturnType<typeof mockStore>[] = [];
    const store = (...args: Parameters<typeof mockStore>) => { const s = mockStore(...args); open.push(s); return s; };

    beforeEach(() => {
      rmSync(file('.env'));
      mkdirSync(join(fixture.home, '.config/varlock'), { recursive: true });
      writeFileSync(join(fixture.home, '.config/varlock/.env.infisical'), `INFISICAL_CLIENT_ID=${CLIENT_ID}\nINFISICAL_CLIENT_SECRET=${CLIENT_SECRET}\n`, { mode: 0o600 });
    });
    afterEach(async () => { await Promise.all(open.splice(0).map(s => s.close())); });

    it('blocks a staged value only the store holds', async () => {
      const s = store({ OPENROUTER_API_KEY: SECRET });
      stage(LEAK);
      blocked(await run('git', COMMIT, { INFISICAL_SITE_URL: await s.url }));
      expect(headFiles()).not.toContain('deploy.sh');
    });
    it('blocks the machine identity, which no runtime is given', async () => {
      const s = store({});
      stage(`echo ${CLIENT_SECRET}\n`);
      blocked(await run('git', COMMIT, { INFISICAL_SITE_URL: await s.url }), CLIENT_SECRET);
    });
    it('scans the first store answer when the next list would be empty', async () => {
      let lists = 0;
      const s = store(() => lists++ === 0 ? { OPENROUTER_API_KEY: SECRET } : {});
      stage(LEAK);
      blocked(await run('git', COMMIT, { INFISICAL_SITE_URL: await s.url }));
      expect(lists).toBe(1);
      expect(headFiles()).not.toContain('deploy.sh');
    });
    it('fails closed when the store refuses, and commits offline without calling it', async () => {
      const s = store({}, true);
      stage(CLEAN);
      blocked(await run('git', COMMIT, { INFISICAL_SITE_URL: await s.url }));
      const refused = s.calls.length;
      expect(refused).toBeGreaterThan(0);
      expect((await run('git', COMMIT, { INFISICAL_SITE_URL: await s.url, ORBITDESK_SHARED_SECRETS: 'off' })).status).toBe(0);
      expect(s.calls).toHaveLength(refused);
    });
    it('fails closed when the store cannot be reached', async () => {
      stage(CLEAN);
      blocked(await run('git', COMMIT, { INFISICAL_SITE_URL: 'http://127.0.0.1:1' }));
      expect(headFiles()).not.toContain('deploy.sh');
    });
    // Varlock's schema guard skips a session with no fingerprint, so only the ancestry check is left.
    const dropFingerprint = `
      const { readFileSync, writeFileSync } = require('node:fs');
      const record = process.env.HOME + '/.config/varlock/proxy/sessions/' + process.env.__VARLOCK_PROXY_SESSION_UUID + '/session.json';
      const { schemaFingerprint, ...session } = JSON.parse(readFileSync(record, 'utf8'));
      if (!schemaFingerprint) process.exit(98);
      writeFileSync(record, JSON.stringify(session));`;
    it.each([['with its schema guard', ''], ['by ancestry alone', dropFingerprint]])('sends the store nothing from a scrubbed proxy child %s', async (_, prepare) => {
      const s = store({ OPENROUTER_API_KEY: SECRET });
      const values = { INFISICAL_SITE_URL: await s.url };
      stage(LEAK);
      await run(VARLOCK, ['proxy', 'run', '--', process.execPath, '-e', ''], values);
      const proxyOwnCalls = s.calls.length;
      expect(proxyOwnCalls).toBeGreaterThan(0);
      blocked(await commitFromProxy(true, values, prepare));
      expect(s.calls).toHaveLength(2 * proxyOwnCalls);
      expect(headFiles()).not.toContain('deploy.sh');
    });
  });
});
