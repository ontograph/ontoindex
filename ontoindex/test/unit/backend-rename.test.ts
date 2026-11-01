import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { renameSymbol } from '../../src/mcp/local/backend-rename.js';

const ripgrep = vi.hoisted(() => ({ missing: false, noMatches: false }));
vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    execFile: (...args: Parameters<typeof original.execFile>) => {
      if (ripgrep.noMatches && args[0] === 'rg') {
        const callback = args[args.length - 1] as Function;
        callback(Object.assign(new Error('no matches'), { code: 1 }), '', '');
        return;
      }
      if (ripgrep.missing && args[0] === 'rg') {
        const callback = args[args.length - 1] as Function;
        callback(Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' }), '', '');
        return;
      }
      return original.execFile(...args);
    },
  };
});

describe('renameSymbol text-search fallback bounds', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-rename-')));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    ripgrep.missing = false;
    ripgrep.noMatches = false;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('caps fallback files and reports a warning', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(path.join(tmpDir, 'src', 'def.ts'), 'export const oldName = 1;\n', 'utf8');
    for (let i = 0; i < 205; i++) {
      await fs.writeFile(
        path.join(tmpDir, 'src', `ref-${String(i).padStart(3, '0')}.ts`),
        'console.log(oldName);\n',
        'utf8',
      );
    }

    const result = await renameSymbol(
      { repoPath: tmpDir },
      { symbol_name: 'oldName', new_name: 'newName', dry_run: true },
      async () => ({
        symbol: { name: 'oldName', filePath: 'src/def.ts', startLine: 0 },
        incoming: { calls: [], imports: [], extends: [], implements: [] },
      }),
      { confirmWrites: false },
    );

    expect(result.status).toBe('success');
    expect(result.text_search_edits).toBeLessThanOrEqual(200);
    expect(result.files_affected).toBeLessThanOrEqual(201);
    if (result.text_search_edits === 200) {
      expect(result.warnings).toContain('Text-search rename fallback capped at 200 files');
    }
  });

  it('treats no ripgrep matches as an empty fallback result', async () => {
    ripgrep.noMatches = true;
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(path.join(tmpDir, 'src', 'def.ts'), 'export const oldName = 1;\n', 'utf8');

    const result = await renameSymbol(
      { repoPath: tmpDir },
      { symbol_name: 'oldName', new_name: 'newName', dry_run: true },
      async () => ({
        symbol: { name: 'missingName', filePath: 'src/def.ts', startLine: 0 },
        incoming: { calls: [], imports: [], extends: [], implements: [] },
      }),
      { confirmWrites: false },
    );

    expect(result.status).toBe('success');
    expect(result.text_search_edits).toBe(0);
    expect(result.warnings).toBeUndefined();
  });

  it.each([false, true])(
    'caps fallback edits and skips oversized files (rg missing: %s)',
    async (missing) => {
      ripgrep.missing = missing;
      await fs.writeFile(path.join(tmpDir, 'def.ts'), 'export const oldName = 1;\n');
      await fs.writeFile(path.join(tmpDir, 'refs.ts'), 'console.log(oldName);\n'.repeat(1005));
      await fs.writeFile(path.join(tmpDir, 'large.ts'), `oldName\n${' '.repeat(1024 * 1024)}`);

      const result = await renameSymbol(
        { repoPath: tmpDir },
        { symbol_name: 'oldName', new_name: 'newName' },
        async () => ({
          symbol: { name: 'oldName', filePath: 'def.ts', startLine: 0 },
          incoming: {},
        }),
        { confirmWrites: false },
      );

      expect(result).toMatchObject({ applied: false, text_search_edits: 1000 });
      expect(result.changes.map((change) => change.file_path)).not.toContain('large.ts');
      expect(result.total_edits).toBe(1001);
      if (missing)
        expect(result.warnings).toContain('ripgrep unavailable; used built-in text search');
    },
  );

  it.each([false, true])(
    'scans each graph or supplemental file once and replaces every token-bearing line (rg missing: %s)',
    async (missing) => {
      ripgrep.missing = missing;
      const fixtures = {
        'def.ts': 'export function oldName() {}\noldName(); oldName();\noldName();\n',
        'ref.ts': 'oldNameSuffix();\noldName(); oldName();\noldName();\n',
        'extra.ts': 'oldName();\noldName();\n',
      };
      for (const [file, source] of Object.entries(fixtures)) {
        await fs.writeFile(path.join(tmpDir, file), source);
      }
      const read = vi.spyOn(fs, 'readFile');
      const result = await renameSymbol(
        { repoPath: tmpDir },
        { symbol_name: 'oldName', new_name: 'newName' },
        async () => ({
          symbol: { name: 'oldName', filePath: 'def.ts', startLine: 0 },
          incoming: {
            calls: [{ filePath: './def.ts' }, { filePath: 'ref.ts' }, { filePath: 'ref.ts' }],
            imports: [{ filePath: './ref.ts' }],
          },
        }),
        { confirmWrites: false },
      );
      expect(result).toMatchObject({
        applied: false,
        files_affected: 3,
        total_edits: 7,
        graph_edits: 5,
        text_search_edits: 2,
        changes: [
          {
            file_path: 'def.ts',
            edits: [
              { line: 1, new_text: 'export function newName() {}', confidence: 'graph' },
              { line: 2, new_text: 'newName(); newName();', confidence: 'graph' },
              { line: 3, new_text: 'newName();', confidence: 'graph' },
            ],
          },
          {
            file_path: 'ref.ts',
            edits: [
              { line: 2, new_text: 'newName(); newName();', confidence: 'graph' },
              { line: 3, new_text: 'newName();', confidence: 'graph' },
            ],
          },
          {
            file_path: 'extra.ts',
            edits: [
              { line: 1, new_text: 'newName();', confidence: 'text_search' },
              { line: 2, new_text: 'newName();', confidence: 'text_search' },
            ],
          },
        ],
      });
      for (const file of Object.keys(fixtures)) {
        expect(read.mock.calls.filter(([name]) => name === path.join(tmpDir, file))).toHaveLength(
          1,
        );
      }
      read.mockRestore();
      for (const [file, source] of Object.entries(fixtures)) {
        expect(await fs.readFile(path.join(tmpDir, file), 'utf8')).toBe(source);
      }
    },
  );

  it.each([false, true])(
    'matches dollar identifiers literally without rewriting substrings or replacement escapes (rg missing: %s)',
    async (missing) => {
      ripgrep.missing = missing;
      await fs.writeFile(path.join(tmpDir, 'def.ts'), 'function $old() {}\n');
      await fs.writeFile(
        path.join(tmpDir, 'ref.ts'),
        '$old(); $old();\n$older(); x$old(); $oldSuffix(); é$old();\n',
      );
      const result = await renameSymbol(
        { repoPath: tmpDir },
        { symbol_name: '$old', new_name: '$&$$' },
        async () => ({ symbol: { name: '$old', filePath: 'def.ts', startLine: 0 }, incoming: {} }),
        { confirmWrites: false },
      );
      expect(result).toMatchObject({
        total_edits: 2,
        graph_edits: 1,
        text_search_edits: 1,
        changes: [
          { file_path: 'def.ts', edits: [{ line: 1, new_text: 'function $&$$() {}' }] },
          { file_path: 'ref.ts', edits: [{ line: 1, new_text: '$&$$(); $&$$();' }] },
        ],
      });
    },
  );

  it('bounds graph reads and reports skipped large and unreadable graph files', async () => {
    ripgrep.noMatches = true;
    await fs.writeFile(path.join(tmpDir, 'large.ts'), `oldName\n${' '.repeat(1024 * 1024)}`);
    await fs.writeFile(path.join(tmpDir, 'refs.ts'), 'oldName();\n'.repeat(1005));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi.spyOn(fs, 'readFile');
    const result = await renameSymbol(
      { repoPath: tmpDir },
      { symbol_name: 'oldName', new_name: 'newName' },
      async () => ({
        symbol: { name: 'oldName', filePath: 'large.ts', startLine: 0 },
        incoming: { calls: [{ filePath: 'missing.ts' }, { filePath: 'refs.ts' }] },
      }),
      { confirmWrites: false },
    );
    expect(result).toMatchObject({ graph_edits: 1000, text_search_edits: 0, total_edits: 1000 });
    expect(result.warnings).toEqual([
      'Skipped oversized rename candidate: large.ts',
      'Could not read rename candidate: missing.ts',
      'Graph rename candidates capped at 1000 edits',
    ]);
    expect(read.mock.calls.map(([file]) => file)).toEqual([path.join(tmpDir, 'refs.ts')]);
  });

  it('caps graph candidates before reading more than 200 distinct files', async () => {
    ripgrep.noMatches = true;
    const calls = [];
    for (let i = 0; i < 205; i++) {
      const filePath = `ref-${i}.ts`;
      calls.push({ filePath });
      await fs.writeFile(path.join(tmpDir, filePath), 'oldName();\n');
    }
    const read = vi.spyOn(fs, 'readFile');
    const result = await renameSymbol(
      { repoPath: tmpDir },
      { symbol_name: 'oldName', new_name: 'newName' },
      async () => ({
        symbol: { name: 'oldName', filePath: calls[0].filePath, startLine: 0 },
        incoming: { calls },
      }),
      { confirmWrites: false },
    );
    expect(read).toHaveBeenCalledTimes(200);
    expect(result).toMatchObject({ graph_edits: 200, files_affected: 200 });
    expect(result.warnings).toContain('Graph rename candidates capped at 200 files');
  });
});

describe('renameSymbol apply safety', () => {
  let tmpDir: string;
  let repoDir: string;

  const lookupDef = (filePath: string) => async () => ({
    symbol: { name: 'oldName', filePath, startLine: 0 },
    incoming: { calls: [], imports: [], extends: [], implements: [] },
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-rename-apply-'));
    repoDir = path.join(tmpDir, 'repo');
    await fs.mkdir(repoDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each([{ symbol_name: 'oldName' }, { symbol_uid: 'Function:def.ts:oldName' }])(
    'refuses to apply without confirm or backend write permission: %j',
    async (selector) => {
      await fs.writeFile(path.join(repoDir, 'def.ts'), 'export const oldName = 1;\n');
      const params = { ...selector, new_name: 'newName', dry_run: false };
      const lookup = vi.fn(lookupDef('def.ts'));

      await expect(
        renameSymbol({ repoPath: repoDir }, params, lookup, { confirmWrites: true }),
      ).rejects.toThrow(/Explicit confirmation required/);
      await expect(
        renameSymbol({ repoPath: repoDir }, { ...params, confirm: true }, lookup, {
          confirmWrites: false,
        }),
      ).rejects.toThrow(/Write operations are disabled/);
      expect(lookup).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(repoDir, 'def.ts'), 'utf8')).toBe(
        'export const oldName = 1;\n',
      );
    },
  );

  it.each(['linked.ts', '../outside.ts'])(
    'keeps dry-run candidates inside the repository: %s',
    async (filePath) => {
      const outside = path.join(tmpDir, 'outside.ts');
      await fs.writeFile(outside, 'export const oldName = 1;\n');
      await fs.symlink(outside, path.join(repoDir, 'linked.ts'));

      vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await renameSymbol(
        { repoPath: repoDir },
        { symbol_name: 'oldName', new_name: 'newName', dry_run: true },
        lookupDef(filePath),
        { confirmWrites: false },
      );

      expect(await fs.readFile(outside, 'utf8')).toBe('export const oldName = 1;\n');
      expect(result).toMatchObject({ applied: false, files_affected: 0 });
    },
  );

  it.each([{ symbol_name: 'oldName' }, { symbol_uid: 'Function:def.ts:oldName' }])(
    'refuses authorized apply without reading candidates or changing any bytes: %j',
    async (selector) => {
      const fixtures = {
        'def.ts': 'export const oldName = 1;\nconst text = "oldName"; // oldName\n',
        'ref.ts':
          'import { oldName } from "./def";\nconsole.log(oldName);\nfunction shadow(oldName: number) { return oldName; }\n// oldName\nconst text = "oldName";\n',
        'unrelated.ts': 'const oldName = 2;\nconsole.log(oldName);\n',
      };
      for (const [file, content] of Object.entries(fixtures)) {
        await fs.writeFile(path.join(repoDir, file), content);
      }
      const read = vi.spyOn(fs, 'readFile');
      const write = vi.spyOn(fs, 'writeFile');
      const lookup = vi.fn(async () => ({
        symbol: { name: 'oldName', filePath: 'def.ts', startLine: 0 },
        incoming: { calls: [{ filePath: 'ref.ts' }] },
      }));

      const result = await renameSymbol(
        { repoPath: repoDir },
        { ...selector, new_name: 'newName', dry_run: false, confirm: true },
        lookup,
        { confirmWrites: true },
      );

      expect(result).toEqual({
        error:
          'Rename apply is unavailable: graph and text-search candidates do not provide a precise semantic rename edit plan. Use dry_run: true to review candidates.',
      });
      expect(lookup).toHaveBeenCalledWith(selector.symbol_name, selector.symbol_uid, undefined);
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      for (const [file, content] of Object.entries(fixtures)) {
        expect(await fs.readFile(path.join(repoDir, file))).toEqual(Buffer.from(content));
      }
    },
  );

  it('preserves missing selectors, lookup failures, ambiguity, and same-name errors', async () => {
    const repo = { repoPath: repoDir };
    const authorization = { confirmWrites: true };
    const params = {
      symbol_name: 'oldName',
      new_name: 'newName',
      dry_run: false,
      confirm: true,
    };
    const lookup = vi.fn(lookupDef('def.ts'));
    expect(await renameSymbol(repo, { new_name: 'newName' }, lookup, authorization)).toEqual({
      error: 'Either symbol_name or symbol_uid is required.',
    });
    expect(lookup).not.toHaveBeenCalled();

    const ambiguous = { status: 'ambiguous' as const, candidates: ['first', 'second'] };
    expect(await renameSymbol(repo, params, async () => ambiguous, authorization)).toEqual(
      ambiguous,
    );
    expect(
      await renameSymbol(repo, params, async () => ({ error: 'not found' }), authorization),
    ).toEqual({ error: 'not found' });

    expect(
      await renameSymbol(repo, { ...params, new_name: 'oldName' }, lookup, authorization),
    ).toEqual({ error: 'New name is the same as the current name.' });
  });
});
