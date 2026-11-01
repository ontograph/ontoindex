import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceSymbol } from '../../src/mcp/local/backend-symbol-mutations.js';
import { resolveSymbolCandidates } from '../../src/mcp/local/backend-symbol-resolution.js';

// Keep symbol lookup deterministic; parsing, filesystem access and replacement are real.
vi.mock('../../src/mcp/local/backend-symbol-resolution.js', () => ({
  resolveSymbolCandidates: vi.fn(),
}));

const fixturesDir = fileURLToPath(new URL('../fixtures/replace-symbol/', import.meta.url));
const cases = [
  ['ts-decorator', 'method', 6, 8],
  ['ts-template-literal', 'template', 0, 6],
  ['ts-as-const', 'getConst', 0, 5],
  ['ts-generic', 'identity', 0, 3],
  ['ts-arrow', 'myArrow', 0, 2],
  ['ts-class-method', 'myMethod', 1, 4],
  ['ts-async', 'fetchData', 0, 3],
  ['ts-overload', 'overload', 2, 7],
  ['ts-default-export', 'defaultExport', 0, 3],
  ['ts-mixed', 'second', 4, 7],
] as const;

describe('replace_symbol real filesystem round trips', () => {
  let repo: { id: string; repoPath: string };

  beforeEach(async () => {
    vi.clearAllMocks();
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'replace-symbol-'));
    repo = { id: repoPath, repoPath };
  });
  afterEach(async () => {
    await fs.rm(repo.repoPath, { recursive: true, force: true });
  });

  function resolve(filePath: string, name: string, startLine: number, endLine: number) {
    vi.mocked(resolveSymbolCandidates).mockResolvedValue({
      kind: 'ok',
      resolvedLabel: 'Function',
      symbol: { id: 'target', type: 'Function', name, filePath, startLine, endLine },
    });
  }

  it.each(cases)('replaces only the body in %s', async (fixture, name, start, end) => {
    const input = await fs.readFile(path.join(fixturesDir, `${fixture}.in.ts`), 'utf8');
    const expected = await fs.readFile(path.join(fixturesDir, `${fixture}.expected.ts`), 'utf8');
    const target = path.join(repo.repoPath, 'source.ts');
    await fs.writeFile(target, input);
    resolve('source.ts', name, start, end);
    const new_body = ['ts-arrow', 'ts-generic'].includes(fixture)
      ? 'return "replaced" as any;'
      : 'return "replaced";';
    const params = { uid: 'target', new_body, dry_run: false, confirm: true };
    expect(
      await replaceSymbol(repo, { ...params, dry_run: true, confirm: false }, false),
    ).toMatchObject({ success: true, dry_run: true });
    expect(await fs.readFile(target, 'utf8')).toBe(input);
    expect(await replaceSymbol(repo, params, true)).toMatchObject({
      success: true,
      dry_run: false,
    });
    expect(await fs.readFile(target, 'utf8')).toBe(expected);
  });

  it.each([
    [
      'source.js',
      'function target() {\n  return 1;\n}\n// suffix\n',
      'return 2;',
      'function target() {\n  return 2;\n}\n// suffix\n',
    ],
    [
      'source.cpp',
      'int target() {\n  return 1;\n}\n// suffix\n',
      'return 2;',
      'int target() {\n  return 2;\n}\n// suffix\n',
    ],
    [
      'source.rs',
      'fn target() -> i32 {\n    1\n}\n// suffix\n',
      '2',
      'fn target() -> i32 {\n    2\n}\n// suffix\n',
    ],
    [
      'source.py',
      'def target():\n    return 1\n\n# suffix\n',
      'if True:\n    return 2\nreturn 3',
      'def target():\n    if True:\n        return 2\n    return 3\n\n# suffix\n',
    ],
    [
      'source.ts',
      '// 😀\r\nfunction target() {\r\n  return 1;\r\n}\r\n// suffix\r\n',
      'return "é";',
      '// 😀\r\nfunction target() {\r\n  return "é";\r\n}\r\n// suffix\r\n',
    ],
  ])('preserves surrounding bytes in %s', async (filePath, input, new_body, expected) => {
    const target = path.join(repo.repoPath, filePath);
    await fs.writeFile(target, input);
    resolve(
      filePath,
      'target',
      input.startsWith('//') ? 1 : 0,
      filePath.endsWith('.py') ? 1 : input.startsWith('//') ? 3 : 2,
    );
    await replaceSymbol(repo, { uid: 'target', new_body, confirm: true }, true);
    expect(await fs.readFile(target, 'utf8')).toBe(expected);
  });

  it.each([
    { body: 'return (;', start: 0, end: 2 },
    { body: '} function injected() {', start: 0, end: 2 },
    { body: 'return 2;', start: 1, end: 2 },
    { body: 'return 2;', start: 0, end: 98 },
  ])('fails closed for malformed replacement or stale ranges: %j', async ({ body, start, end }) => {
    const input = 'function target() {\n  return 1;\n}\n';
    const target = path.join(repo.repoPath, 'source.ts');
    await fs.writeFile(target, input);
    resolve('source.ts', 'target', start, end);
    await expect(
      replaceSymbol(repo, { uid: 'target', new_body: body, confirm: true }, true),
    ).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe(input);
  });

  it('rejects inline Python suites without changing the file', async () => {
    const input = 'def target(): return 1\n';
    const target = path.join(repo.repoPath, 'source.py');
    await fs.writeFile(target, input);
    resolve('source.py', 'target', 0, 0);
    await expect(
      replaceSymbol(repo, { uid: 'target', new_body: 'return 2', confirm: true }, true),
    ).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe(input);
  });

  it('rejects an ambiguous symbol resolution', async () => {
    vi.mocked(resolveSymbolCandidates).mockResolvedValue({ kind: 'ambiguous', candidates: [] });
    await expect(
      replaceSymbol(repo, { uid: 'target', new_body: 'return 2;', confirm: true }, true),
    ).rejects.toThrow(/not found or ambiguous/);
  });

  it('rejects unsupported languages before writing', async () => {
    const target = path.join(repo.repoPath, 'source.go');
    const input = 'func target() int { return 1 }\n';
    await fs.writeFile(target, input);
    resolve('source.go', 'target', 0, 0);
    await expect(
      replaceSymbol(repo, { uid: 'target', new_body: 'return 2', confirm: true }, true),
    ).rejects.toThrow(/Unsupported replacement language/);
    expect(await fs.readFile(target, 'utf8')).toBe(input);
  });

  it.each([
    ['source.ts', 'function target() {\n  return 1;\n}\n', 'return `first\nsecond`;'],
    ['source.py', 'def target():\n    return 1\n', 'return """first\nsecond"""'],
  ])(
    'rejects multiline literal formatting that could change values in %s',
    async (filePath, input, new_body) => {
      const target = path.join(repo.repoPath, filePath);
      await fs.writeFile(target, input);
      resolve(filePath, 'target', 0, filePath.endsWith('.py') ? 1 : 2);
      for (const dry_run of [true, false]) {
        await expect(
          replaceSymbol(repo, { uid: 'target', new_body, confirm: true, dry_run }, true),
        ).rejects.toThrow(/Multiline string literals|Replacement escapes the callable body/);
        expect(await fs.readFile(target, 'utf8')).toBe(input);
      }
    },
  );

  it('refuses a source replaced by an outside symlink immediately before opening for write', async () => {
    const input = 'function target() {\n  return 1;\n}\n';
    const target = path.join(repo.repoPath, 'source.ts');
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'replace-outside-'));
    const outside = path.join(outsideDir, 'source.ts');
    const open = fs.open.bind(fs);
    await fs.writeFile(target, input);
    await fs.writeFile(outside, input);
    resolve('source.ts', 'target', 0, 2);
    const spy = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.unlink(target);
      await fs.symlink(outside, target);
      return Reflect.apply(open, undefined, args);
    });
    try {
      await expect(
        replaceSymbol(repo, { uid: 'target', new_body: 'return 2;', confirm: true }, true),
      ).rejects.toThrow();
      expect(await fs.readFile(outside, 'utf8')).toBe(input);
      expect(await fs.readlink(target)).toBe(outside);
    } finally {
      spy.mockRestore();
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
