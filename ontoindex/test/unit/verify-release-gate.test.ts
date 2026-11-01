import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const verifier = readFileSync(
  new URL('../../../scripts/verify-release.sh', import.meta.url),
  'utf8',
);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('release verification input identity', () => {
  it.each(['unchanged', 'unstaged', 'staged', 'failure'])(
    'handles %s inputs after the validation commands',
    (mode) => {
      const root = mkdtempSync(path.join(tmpdir(), 'ontoindex-verify-release-'));
      roots.push(root);
      const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}` };
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
      mkdirSync(path.join(root, 'ontoindex'));
      mkdirSync(path.join(root, 'bin'));
      writeFileSync(path.join(root, 'verify-release.sh'), verifier);
      writeFileSync(path.join(root, 'ontoindex/input'), 'original');
      writeFileSync(path.join(root, '.gitignore'), 'ontoindex/dist/\n');
      git('init', '-q');
      git('add', 'ontoindex/input', '.gitignore');
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
      const mutation =
        mode === 'unstaged'
          ? 'echo changed > input'
          : mode === 'staged'
            ? 'echo changed > input\ngit add input'
            : mode === 'failure'
              ? 'exit 17'
              : 'mkdir -p dist\necho generated > dist/output';
      writeFileSync(
        path.join(root, 'bin/npm'),
        `#!/bin/sh\nset -e\nif [ "$2" = build ]; then\n${mutation}\nfi\n`,
        { mode: 0o755 },
      );
      const result = spawnSync('bash', ['verify-release.sh'], { cwd: root, env, encoding: 'utf8' });
      const stamp = path.join(root, git('rev-parse', '--git-path', 'ontoindex-release-verified'));
      expect(result.status, result.stderr).toBe(
        mode === 'unchanged' ? 0 : mode === 'failure' ? 17 : 1,
      );
      expect(existsSync(stamp)).toBe(mode === 'unchanged');
      if (mode === 'unchanged') expect(readFileSync(stamp, 'utf8').trim()).toBe(git('write-tree'));
    },
  );
});
