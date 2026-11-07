import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const hook = readFileSync(new URL('../../../.husky/pre-commit', import.meta.url), 'utf8');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const diagnostic = 'src/example.ts(1,1): error TS2322: Type is not assignable.\n';
type CompilerResult = { status: number; output: string };

function fixture(
  changed: string,
  production: CompilerResult = { status: 0, output: '' },
  tests: CompilerResult = { status: 0, output: '' },
  baseline = 1,
  formatterStatus = 0,
) {
  const root = mkdtempSync(path.join(tmpdir(), 'ontoindex-pre-commit-'));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env });
  git('init', '-q');
  const write = (name: string, contents: string, executable = false) => {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, { mode: executable ? 0o755 : 0o644 });
  };
  write('.husky/pre-commit', hook);
  write('node_modules/.bin/lint-staged', `#!/bin/sh\nexit ${formatterStatus}\n`, true);
  for (const pkg of ['ontoindex', 'ontoindex-web']) {
    write(`.husky/tsc-baseline.${pkg}.txt`, String(baseline));
    write(`${pkg}/production-output`, production.output);
    write(`${pkg}/test-output`, tests.output);
    write(
      `${pkg}/node_modules/.bin/tsc`,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$PWD/invocations"
case " $* " in
  *' -p tsconfig.test.json '*) cat test-output; exit ${tests.status} ;;
  *) cat production-output; exit ${production.status} ;;
esac
`,
      true,
    );
  }
  write(changed, 'staged');
  git('add', changed);
  const run = () => spawnSync('bash', ['.husky/pre-commit'], { cwd: root, env, encoding: 'utf8' });
  return { root, run };
}

describe('pre-commit typecheck gate', () => {
  for (const pkg of ['ontoindex', 'ontoindex-web']) {
    describe(pkg, () => {
      it.each([
        { count: 0, status: 0, expected: 0 },
        { count: 1, status: 2, expected: 0 },
        { count: 2, status: 1, expected: 0 },
        { count: 3, status: 2, expected: 1 },
      ])('ratchets $count diagnostics with exit $status', ({ count, status, expected }) => {
        const f = fixture(
          `${pkg}/src/example.ts`,
          { status, output: diagnostic.repeat(count) },
          undefined,
          2,
        );
        const result = f.run();
        expect(result.status).toBe(expected);
        expect(readFileSync(path.join(f.root, pkg, 'invocations'), 'utf8')).toContain(
          '--pretty false',
        );
        if (count > 2) expect(result.stdout).toContain(diagnostic.trim());
      });

      it('permits indented multiline diagnostic details', () => {
        const f = fixture(`${pkg}/src/example.ts`, {
          status: 2,
          output: diagnostic + '  Types of property are incompatible.\n    Nested explanation.\n',
        });
        expect(f.run().status).toBe(0);
      });

      it.each(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])(
        'permits baseline diagnostics for .%s sources',
        (extension) => {
          const f = fixture(`${pkg}/src/example.ts`, {
            status: 2,
            output: diagnostic.replace('example.ts', `example.${extension}`),
          });
          expect(f.run().status).toBe(0);
        },
      );

      it.each([
        { status: 2, output: 'base.jsonc(2,3): error TS5023: Unknown compiler option.\n' },
        { status: 2, output: 'custom.config(2,3): error TS5023: Unknown compiler option.\n' },
        { status: 1, output: "error TS5023: Unknown compiler option 'invalid'.\n" },
        { status: 2, output: 'error TS18003: No inputs were found in config file.\n' },
        {
          status: 2,
          output: "tsconfig.json(2,3): error TS5023: Unknown compiler option 'invalid'.\n",
        },
        {
          status: 2,
          output:
            diagnostic + "config/build.json(2,3): error TS6053: File 'base.json' not found.\n",
        },
        { status: 1, output: '' },
        { status: 1, output: 'Error: Cannot find module typescript\n' },
        { status: 1, output: diagnostic + 'FATAL ERROR: JavaScript heap out of memory\n' },
        { status: 137, output: diagnostic },
        { status: 2, output: 'runtime mentioned error TS but emitted no diagnostic\n' },
      ])('blocks infrastructure failure $status: $output', (production) => {
        const f = fixture(`${pkg}/src/example.ts`, production);
        const result = f.run();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(`compiler failed (exit ${production.status})`);
        expect(result.stdout).toContain(production.output);
      });

      it('blocks a missing compiler and exposes its error', () => {
        const f = fixture(`${pkg}/src/example.ts`);
        rmSync(path.join(f.root, pkg, 'node_modules/.bin/tsc'));
        const result = f.run();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('compiler failed (exit 127)');
        expect(result.stdout).toContain('No such file or directory');
      });
    });
  }

  it.each([
    { status: 1, output: '' },
    { status: 2, output: diagnostic },
    { status: 137, output: 'compiler killed\n' },
  ])('strictly rejects test typecheck exit $status', (tests) => {
    const f = fixture('ontoindex/src/example.ts', undefined, tests);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`test source typecheck failed (exit ${tests.status})`);
    expect(result.stdout).toContain(tests.output);
  });

  it('skips typechecks for unrelated staged paths', () => {
    const f = fixture('other/file', { status: 137, output: 'compiler killed' });
    expect(f.run().status).toBe(0);
  });

  it('does not check an unaffected package', () => {
    const f = fixture('ontoindex-web/src/example.ts');
    rmSync(path.join(f.root, 'ontoindex/node_modules/.bin/tsc'));
    expect(f.run().status).toBe(0);
  });

  it('retains formatter failure as a commit blocker', () => {
    const f = fixture('ontoindex/src/example.ts', undefined, undefined, 1, 1);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('typechecking');
  });
});
