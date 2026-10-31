import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealedEnv } from './no-keyring';

const ROOT = resolve(__dirname, '..');
const SECRET = 'synthetic-session-secret-value-0123456789';
const OTHER_SECRET = 'synthetic-google-client-secret-9876543210';
const CLEAN = 'echo clean\n';
const LEAK = `echo ${SECRET}\n`;

function repoFixture() {
  const base = mkdtempSync(join(tmpdir(), 'orbitdesk-pre-commit-'));
  const repo = join(base, 'repo'), home = join(base, 'home'), scratch = join(base, 'scratch[0]');
  for (const dir of [repo, home, scratch]) mkdirSync(dir);
  for (const path of ['.env.schema', '.env.infisical', '.githooks/pre-commit']) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(repo, path));
  }
  writeFileSync(join(repo, '.gitignore'), '.env\n.env.local\nnode_modules\n');
  writeFileSync(join(repo, '.env'), `SESSION_SECRET=${SECRET}\n`);
  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'));
  const env = sealedEnv(home, { TMPDIR: scratch, GIT_AUTHOR_NAME: 'Orbitdesk Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Orbitdesk Test', GIT_COMMITTER_EMAIL: 'test@example.com' });
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, stdout: result.stdout };
  };
  git('init', '--quiet', '--initial-branch=main');
  git('add', '.');
  git('commit', '--quiet', '--no-verify', '--message', 'Set up the fixture');
  git('config', 'core.hooksPath', '.githooks');
  return { base, repo, scratch, git };
}

describe('pre-commit secret scan', () => {
  let fixture: ReturnType<typeof repoFixture>;
  const file = (name: string) => join(fixture.repo, name);
  const headFiles = () => fixture.git('ls-tree', '--name-only', 'HEAD').stdout.split('\n');
  const snapshots = () => readdirSync('/tmp').filter(name => name.startsWith('orbitdesk-staged.'));
  const blocked = (commit: { status: number | null; output: string }) => {
    expect(commit.status).not.toBe(0);
    expect(commit.output).toContain('Secret scan failed.');
    expect(commit.output).not.toContain(SECRET);
  };

  beforeEach(() => { fixture = repoFixture(); });
  afterEach(() => {
    unlinkSync(file('node_modules'));
    rmSync(fixture.base, { recursive: true, force: true });
  });

  it('blocks a staged secret that only the working copy has dropped', () => {
    const before = snapshots();
    writeFileSync(file('deploy.sh'), LEAK);
    fixture.git('add', 'deploy.sh');
    writeFileSync(file('deploy.sh'), CLEAN);
    blocked(fixture.git('commit', '--message', 'Add the deploy step'));
    expect(headFiles()).not.toContain('deploy.sh');
    expect(fixture.git('show', ':deploy.sh').stdout).toBe(LEAK);
    expect(readFileSync(file('deploy.sh'), 'utf8')).toBe(CLEAN);
    expect(snapshots()).toEqual(before);
    expect(readdirSync(fixture.scratch)).toEqual([]);
  });
  it('commits a clean staged version while the working copy holds a secret', () => {
    writeFileSync(file('deploy.sh'), CLEAN);
    fixture.git('add', 'deploy.sh');
    writeFileSync(file('deploy.sh'), LEAK);
    expect(fixture.git('commit', '--message', 'Add the deploy step').status).toBe(0);
    expect(fixture.git('show', 'HEAD:deploy.sh').stdout).toBe(CLEAN);
    expect(readFileSync(file('deploy.sh'), 'utf8')).toBe(LEAK);
  });
  it('scans only the staged half of a partly staged file', () => {
    writeFileSync(file('deploy.sh'), `${CLEAN}${CLEAN}`);
    fixture.git('add', 'deploy.sh');
    fixture.git('commit', '--no-verify', '--message', 'Add the deploy step');
    writeFileSync(file('deploy.sh'), `${LEAK}${CLEAN}`);
    fixture.git('add', 'deploy.sh');
    writeFileSync(file('deploy.sh'), `${CLEAN}${CLEAN}`);
    blocked(fixture.git('commit', '--message', 'Change the deploy step'));
    writeFileSync(file('deploy.sh'), `${CLEAN}${CLEAN}`);
    fixture.git('add', 'deploy.sh');
    writeFileSync(file('deploy.sh'), `${LEAK}${CLEAN}`);
    expect(fixture.git('commit', '--allow-empty', '--message', 'Change nothing staged').status).toBe(0);
  });
  it('checks the working copy when a path commit will take it', () => {
    writeFileSync(file('deploy.sh'), CLEAN);
    fixture.git('add', 'deploy.sh');
    writeFileSync(file('deploy.sh'), LEAK);
    blocked(fixture.git('commit', '--message', 'Add the deploy step', '--', 'deploy.sh'));
  });
  it('follows a staged rename to the content in the index', () => {
    writeFileSync(file('old-name.sh'), CLEAN.repeat(4));
    fixture.git('add', 'old-name.sh');
    fixture.git('commit', '--no-verify', '--message', 'Add the old name');
    fixture.git('mv', 'old-name.sh', 'new-name.sh');
    writeFileSync(file('new-name.sh'), `${CLEAN.repeat(4)}${LEAK}`);
    fixture.git('add', 'new-name.sh');
    writeFileSync(file('new-name.sh'), CLEAN);
    blocked(fixture.git('commit', '--message', 'Rename the script'));
  });
  it('lets a commit delete a file that held a secret', () => {
    writeFileSync(file('leaked.sh'), LEAK);
    fixture.git('add', 'leaked.sh');
    fixture.git('commit', '--no-verify', '--message', 'Add the leak');
    fixture.git('rm', '--quiet', 'leaked.sh');
    writeFileSync(file('clean.sh'), CLEAN);
    fixture.git('add', 'clean.sh');
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
  it('never prints either secret when both appear on one staged line', () => {
    writeFileSync(file('.env'), `SESSION_SECRET=${SECRET}\nGOOGLE_CLIENT_SECRET=${OTHER_SECRET}\n`);
    writeFileSync(file('deploy.sh'), `echo ${SECRET} ${OTHER_SECRET}\n`);
    fixture.git('add', 'deploy.sh');
    const commit = fixture.git('commit', '--message', 'Add the deploy step');
    blocked(commit);
    expect(commit.output).not.toContain(OTHER_SECRET);
    expect(headFiles()).not.toContain('deploy.sh');
  });
  it('fails closed without printing anything when the scanner cannot run', () => {
    writeFileSync(file('.env.schema'), '# @plugin(not-a-real-plugin)\n# ---\n');
    writeFileSync(file('deploy.sh'), CLEAN);
    fixture.git('add', 'deploy.sh');
    const commit = fixture.git('commit', '--message', 'Add the deploy step');
    expect(commit.status).not.toBe(0);
    expect(commit.output.trim()).toBe('Secret scan failed. Check staged files and secret-store access. See docs/SECRETS.md.');
  });
});
