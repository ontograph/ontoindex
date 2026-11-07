import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

it('bounds the actual overlay fixture cleanup and reports the owning phase', () => {
  const source = ts.createSourceFile(
    'overlay-generations.test.ts',
    fs.readFileSync(path.join(repoRoot, 'test/unit/overlay-generations.test.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const recorders: ts.FunctionDeclaration[] = [];
  const generations: ts.ArrowFunction[] = [];
  let visited = 0;
  const visit = (node: ts.Node) => {
    if (++visited > 20_000) throw new Error('Overlay fixture AST exceeds bounded search');
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'createPhaseRecorder') {
      recorders.push(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'it' &&
      node.expression.name.text === 'extend'
    ) {
      const fixtures = node.arguments[0];
      if (fixtures && ts.isObjectLiteralExpression(fixtures)) {
        for (const property of fixtures.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            property.name.getText(source) === 'generation' &&
            ts.isArrowFunction(property.initializer)
          )
            generations.push(property.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(recorders, 'exactly one real phase recorder').toHaveLength(1);
  expect(generations, 'exactly one real generation initializer').toHaveLength(1);
  const extracted = ts.transpileModule(
    `${recorders[0]!.getText(source)}\nconst generation = ${generations[0]!.getText(source)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-generation-hooks-'));
  const trace = path.join(cwd, 'trace.jsonl');
  const results = path.join(cwd, 'results.json');
  const modes = ['success', 'reader-reject', 'database-reject', 'database-timeout'];
  try {
    const fixture = path.join(cwd, 'test/unit/hooks.test.ts');
    const config = path.join(cwd, 'vitest.config.mjs');
    fs.writeFileSync(
      config,
      `export default { test: {
  globals: true, hookTimeout: 100, pool: 'forks', maxWorkers: 1,
  disableConsoleIntercept: true,
  include: ['test/unit/hooks.test.ts'],
} };`,
    );
    fs.mkdirSync(path.dirname(fixture), { recursive: true });
    fs.writeFileSync(
      fixture,
      `import nativeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
${modes
  .map(
    (mode) => `{
  const mode = ${JSON.stringify(mode)};
  const marker = 'OVERLAY_HOOK_' + mode;
  const event = (value) => nativeFs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify([mode, value]) + '\\n');
  const close = async (owner) => {
    event(owner + ':start');
    if (mode === owner + '-reject') throw new Error(marker + ':close rejected');
    if (mode === owner + '-timeout') await new Promise(() => {});
    event(owner + ':closed');
  };
  const fs = { mkdtemp: async () => marker, rm: async () => event('remove') };
  const pool = { closeLbug: async () => close('reader') };
  const closeLbug = async () => close('database');
  const overlayRepoId = (root) => root;
  const resetOverlaySnapshotCache = () => {};
  const lbug = { Database: function Database() {} };
  const createFixture = async (_root, markPhase) => {
    markPhase('read: ' + marker);
    return { marker };
  };
  ${extracted}
  const test = it.extend({ generation });
  test(marker, async ({ generation, onTestFailed }) => {
    onTestFailed(({ task }) => {
      task.meta.failureMessages = task.result?.errors?.map(error => error.message) ?? [];
    });
    expect(generation.marker).toBe(marker);
    event('body');
  });
}`,
  )
  .join('\n')}`,
    );
    const run = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        config,
        '--root',
        cwd,
        '--no-file-parallelism',
        '--reporter=json',
        '--outputFile',
        results,
        'test/unit/hooks.test.ts',
      ],
      {
        cwd,
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, ONTOINDEX_SKIP_GLOBAL_SETUP: '1', ONTOINDEX_TEST_WORKERS: '1' },
      },
    );
    const traceTail = fs.existsSync(trace)
      ? fs.readFileSync(trace, 'utf8').trim().split('\n').slice(-12).join('\n')
      : '(no trace)';
    const diagnostic = run.stdout + run.stderr + '\nTrace tail:\n' + traceTail;
    expect(run.error, diagnostic).toBeUndefined();
    expect(run.signal, diagnostic).toBeNull();
    expect(run.status, diagnostic).toBe(1);
    const report = JSON.parse(fs.readFileSync(results, 'utf8'));
    const assertions = report.testResults[0].assertionResults;
    expect(assertions.map((entry: { status: string }) => entry.status)).toEqual([
      'passed',
      'failed',
      'failed',
      'failed',
    ]);
    const events: [string, string][] = fs
      .readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const expectedEvents = [
      ['body', 'reader:start', 'reader:closed', 'database:start', 'database:closed', 'remove'],
      ['body', 'reader:start'],
      ['body', 'reader:start', 'reader:closed', 'database:start'],
      ['body', 'reader:start', 'reader:closed', 'database:start'],
    ];
    modes.forEach((mode, index) => {
      expect(events.filter(([owner]) => owner === mode).map(([, event]) => event)).toEqual(
        expectedEvents[index],
      );
      if (mode === 'success') return;
      const marker = 'OVERLAY_HOOK_' + mode;
      const phase = mode === 'reader-reject' ? 'overlay reader' : 'native database';
      expect(diagnostic).toMatch(
        new RegExp(`lastOperation=read: ${marker}[^\\n]*lastRecorded=cleanup: ${phase}`),
      );
      const failure = assertions[index].meta.failureMessages.join('\n');
      expect(failure).toContain(
        mode.endsWith('timeout') ? 'Hook timed out in 100ms' : marker + ':close rejected',
      );
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}, 25_000);
