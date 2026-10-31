import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const hook = readFileSync(new URL('../../../.husky/commit-msg', import.meta.url), 'utf8');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(initial: string | null = '{"version":"2.4.3"}') {
  const root = mkdtempSync(path.join(tmpdir(), 'ontoindex-commit-msg-'));
  roots.push(root);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  // Fixtures own their Git state even when Vitest is launched by a Git hook.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  mkdirSync(path.join(root, 'ontoindex'));
  writeFileSync(path.join(root, 'commit-msg'), hook);
  const write = (source: string) =>
    writeFileSync(path.join(root, 'ontoindex/package.json'), source);
  const stage = (source: string) => {
    write(source);
    git('add', 'ontoindex/package.json');
  };
  if (initial !== null) {
    stage(initial);
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'baseline',
    );
  }
  const stamp = () =>
    writeFileSync(
      path.join(root, git('rev-parse', '--git-path', 'ontoindex-release-verified')),
      git('write-tree'),
    );
  const run = () => spawnSync('sh', ['-e', 'commit-msg'], { cwd: root, env, encoding: 'utf8' });
  return { root, env, git, write, stage, stamp, run };
}

describe('release commit hook', () => {
  it.each(['{"version":"2.4.4"}', '{"\\u0076ersion":"2.4.4"}', '{\n  "version": "2.4.4"\n}'])(
    'requires an exact staged-tree stamp for %s',
    (source) => {
      const f = fixture();
      f.stage(source);
      expect(f.run().status).toBe(1);
      f.stamp();
      expect(f.run().status).toBe(0);
      writeFileSync(path.join(f.root, 'other'), 'changed');
      f.git('add', 'other');
      expect(f.run().status).toBe(1);
    },
  );

  it('ignores formatting, metadata, nested versions and unstaged version changes', () => {
    const f = fixture();
    f.stage('{"nested":{"version":"9"},"name":"other","version":"2.4.3"}');
    f.write('{"version":"2.4.4"}');
    expect(f.run().status).toBe(0);
  });

  it('uses the staged bump even when the working tree has the old version', () => {
    const f = fixture();
    f.stage('{"version":"2.4.4"}');
    f.write('{"version":"2.4.3"}');
    expect(f.run().status).toBe(1);
  });

  it.each(['oops', 'null', '[]', '{}', '{"version":1}', '{"version":""}'])(
    'rejects invalid staged manifest %s',
    (source) => {
      const f = fixture();
      f.stage(source);
      f.stamp();
      expect(f.run().status).toBe(1);
    },
  );

  it('requires a stamp for an initial manifest', () => {
    const f = fixture(null);
    f.stage('{"version":"1.0.0"}');
    expect(f.run().status).toBe(1);
    f.stamp();
    expect(f.run().status).toBe(0);
  });

  it('rejects deletion and malformed HEAD versions', () => {
    const f = fixture();
    f.git('rm', '-q', 'ontoindex/package.json');
    expect(f.run().status).toBe(1);
    const invalid = fixture('{}');
    invalid.stage('{"version":"2.4.4"}');
    invalid.stamp();
    expect(invalid.run().status).toBe(1);
  });

  it('honors an alternate index', () => {
    const f = fixture();
    f.env.GIT_INDEX_FILE = path.join(f.root, 'alternate-index');
    f.git('read-tree', 'HEAD');
    f.stage('{"version":"2.4.4"}');
    expect(f.run().status).toBe(1);
    f.stamp();
    expect(f.run().status).toBe(0);
  });

  it('rejects Git failure instead of interpreting it as no version change', () => {
    const f = fixture();
    f.env.GIT_DIR = path.join(f.root, 'missing-git-dir');
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('commit-msg:');
  });
});
