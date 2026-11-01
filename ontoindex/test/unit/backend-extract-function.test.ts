import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveSymbolCandidates } from '../../src/mcp/local/backend-symbol-resolution.js';
import { guardMutationRange } from '../../src/mcp/local/backend-move-symbol.js';
import { extractFunction } from '../../src/mcp/local/backend-extract-function.js';

vi.mock('../../src/mcp/local/backend-symbol-resolution.js', () => ({
  resolveSymbolCandidates: vi.fn(),
}));
vi.mock('../../src/mcp/local/backend-move-symbol.js', () => ({
  guardMutationRange: vi.fn().mockResolvedValue(['dirty range']),
}));

let repo: { id: string; repoPath: string };
let sourceFile: string;
const original =
  '// λ prefix\nexport function sample(\n  value: number,\n  extra: number\n): number {\n  return this.base + value + arguments.length;\n}\n';

async function fixture(source = original, filePath = 'sample.ts', startLine = 1) {
  sourceFile = path.join(repo.repoPath, filePath);
  await fs.writeFile(sourceFile, source);
  vi.mocked(resolveSymbolCandidates).mockResolvedValue({
    kind: 'ok',
    resolvedLabel: 'Function',
    symbol: {
      id: 'sample',
      name: 'sample',
      type: 'Function',
      filePath,
      startLine,
      endLine: source.trimEnd().split('\n').length - 1,
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  repo = {
    id: 'fixture',
    repoPath: await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-extract-')),
  };
  await fixture();
});
afterEach(async () => {
  await fs.rm(repo.repoPath, { recursive: true, force: true });
});

it('preserves multiline typed signatures, receiver and supplied argument count in preview and apply', async () => {
  const preview = await extractFunction(repo, { uid: 'sample', new_name: 'helper' });
  expect(preview).toMatchObject({ warnings: ['dirty range'], dry_run: true });
  expect(preview.preview).toContain(
    'export function sample(\n  value: number,\n  extra: number\n): number {\n  return helper.apply(this, arguments as unknown as Parameters<typeof helper>);\n}',
  );
  expect(await fs.readFile(sourceFile, 'utf8')).toBe(original);
  const applied = await extractFunction(repo, {
    uid: 'sample',
    new_name: 'helper',
    dry_run: false,
    confirm: true,
  });
  expect(applied).toMatchObject({ filePath: 'sample.ts', insertedAt: 2 });
  expect(await fs.readFile(sourceFile, 'utf8')).toBe(preview.preview);
  const javascript = ts.transpileModule(preview.preview!, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = { exports: {} as { sample: (...args: number[]) => number } };
  vm.runInNewContext(javascript, context);
  expect(context.exports.sample.call({ base: 10 }, 4)).toBe(15);
  expect(context.exports.sample.call({ base: 10 }, 4, 9, 8)).toBe(17);
});

it.each([true, false])(
  'rejects a distinct destination before writing (dry_run=%s)',
  async (dry_run) => {
    await fs.writeFile(path.join(repo.repoPath, 'other.ts'), '// destination');
    await expect(
      extractFunction(repo, {
        uid: 'sample',
        new_name: 'helper',
        target_file: 'other.ts',
        dry_run,
        confirm: true,
      }),
    ).rejects.toThrow('Cross-file');
    expect(await fs.readFile(sourceFile, 'utf8')).toBe(original);
    expect(await fs.readFile(path.join(repo.repoPath, 'other.ts'), 'utf8')).toBe('// destination');
  },
);

it.each([
  'function sample(value = 1) { return value; }',
  'function sample(...values) { return values; }',
  'function sample({ value }) { return value; }',
  'async function sample(value) { return value; }',
  'function* sample(value) { yield value; }',
  'function sample<T>(value: T) { return value; }',
  'function sample(value?: number) { return value; }',
  'function sample() { return new.target; }',
  'function sample() { return eval("1"); }',
  'function sample() { return (eval)("1"); }',
  'function sample(arguments) { return arguments; }',
  'function sample() { return arguments.callee; }',
  'function sample() { return arguments["callee"]; }',
  'function sample() { return arguments[key]; }',
  'function sample() { const alias = arguments; return alias.callee; }',
  'function sample() { return sample; }',
  'function sample(value: number): number;\nfunction sample(value: number) { return value; }',
  'function outer() { function sample() { return 1; } }',
  'const sample = () => 1;',
])('rejects unsupported extraction unchanged: %s', async (source) => {
  await fixture(source, 'sample.ts', 0);
  for (const dry_run of [true, false]) {
    await expect(
      extractFunction(repo, { uid: 'sample', new_name: 'helper', dry_run, confirm: true }),
    ).rejects.toThrow();
    expect(await fs.readFile(sourceFile, 'utf8')).toBe(source);
  }
});

it.each(['sample', 'not-valid', 'return', 'value'])(
  'rejects invalid or colliding helper name %s',
  async (new_name) => {
    for (const dry_run of [true, false]) {
      await expect(
        extractFunction(repo, { uid: 'sample', new_name, dry_run, confirm: true }),
      ).rejects.toThrow();
    }
    expect(await fs.readFile(sourceFile, 'utf8')).toBe(original);
  },
);

it.each([
  'export function sample(value: number) { return value + arguments.length; }',
  'export function sample(this: { base: number }, value: number): number { return this.base + value; }',
])('generates semantically valid strict TypeScript: %s', async (source) => {
  await fixture(source, 'sample.ts', 0);
  const result = await extractFunction(repo, { uid: 'sample', new_name: 'helper' });
  const checkFile = path.join(repo.repoPath, 'generated.ts');
  await fs.writeFile(
    checkFile,
    result.preview! + '\nconst check: number = sample.call({ base: 1 }, 2);\n',
  );
  const program = ts.createProgram([checkFile], {
    strict: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
  });
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  ).toEqual([]);
});

it('rejects a stale source range and unsupported language', async () => {
  await fixture(original, 'sample.ts', 0);
  vi.mocked(guardMutationRange).mockResolvedValueOnce(undefined);
  await expect(extractFunction(repo, { uid: 'sample', new_name: 'helper' })).rejects.toThrow(
    'Stale range',
  );
  await fixture('def sample():\n  return 1\n', 'sample.py', 0);
  await expect(extractFunction(repo, { uid: 'sample', new_name: 'helper' })).rejects.toThrow(
    'JavaScript and TypeScript',
  );
});

it('relocates a unique declaration for a warned dry run with a stale range', async () => {
  await fixture(original, 'sample.ts', 0);

  const result = await extractFunction(repo, { uid: 'sample', new_name: 'helper' });

  expect(result).toMatchObject({ success: true, dry_run: true, warnings: ['dirty range'] });
  expect(result.preview).toContain(
    '// λ prefix\nfunction helper(\n  value: number,\n  extra: number\n): number {',
  );
  expect(await fs.readFile(sourceFile, 'utf8')).toBe(original);
});

it('copies body directives so strict functions retain an undefined receiver', async () => {
  await fixture(
    'function sample(\n  value\n) {\n  "use strict";\n  return this === undefined && arguments.length === 1;\n}\n',
    'sample.js',
    0,
  );
  const result = await extractFunction(repo, { uid: 'sample', new_name: 'helper' });
  expect(vm.runInNewContext(result.preview! + '\nsample.call(undefined, 1)')).toBe(true);
});

it('requires confirmation and rejects destinations outside the repository without writes', async () => {
  await expect(
    extractFunction(repo, { uid: 'sample', new_name: 'helper', dry_run: false }),
  ).rejects.toThrow('confirmation');
  await expect(
    extractFunction(repo, { uid: 'sample', new_name: 'helper', target_file: '../outside.ts' }),
  ).rejects.toThrow();
  expect(await fs.readFile(sourceFile, 'utf8')).toBe(original);
});
