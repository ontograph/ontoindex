import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { renameSymbol } from '../../src/mcp/local/backend-rename.js';

describe('renameSymbol text-search fallback bounds', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-rename-'));
  });

  afterEach(async () => {
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
        symbol: { name: 'oldName', filePath: 'src/def.ts', startLine: 1 },
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
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(path.join(tmpDir, 'src', 'def.ts'), 'export const oldName = 1;\n', 'utf8');

    const result = await renameSymbol(
      { repoPath: tmpDir },
      { symbol_name: 'oldName', new_name: 'newName', dry_run: true },
      async () => ({
        symbol: { name: 'missingName', filePath: 'src/def.ts', startLine: 1 },
        incoming: { calls: [], imports: [], extends: [], implements: [] },
      }),
      { confirmWrites: false },
    );

    expect(result.status).toBe('success');
    expect(result.text_search_edits).toBe(0);
    expect(result.warnings).toBeUndefined();
  });

  it('caps fallback edits and skips oversized files', async () => {
    await fs.writeFile(path.join(tmpDir, 'def.ts'), 'export const oldName = 1;\n');
    await fs.writeFile(path.join(tmpDir, 'refs.ts'), 'console.log(oldName);\n'.repeat(1005));
    await fs.writeFile(path.join(tmpDir, 'large.ts'), `oldName\n${' '.repeat(1024 * 1024)}`);

    const result = await renameSymbol(
      { repoPath: tmpDir },
      { symbol_name: 'oldName', new_name: 'newName' },
      async () => ({
        symbol: { name: 'oldName', filePath: 'def.ts', startLine: 1 },
        incoming: {},
      }),
      { confirmWrites: false },
    );

    expect(result).toMatchObject({ applied: false, text_search_edits: 1000 });
    expect(result.changes.map((change) => change.file_path)).not.toContain('large.ts');
    expect(result.total_edits).toBe(1001);
  });
});

describe('renameSymbol apply safety', () => {
  let tmpDir: string;
  let repoDir: string;

  const lookupDef = (filePath: string) => async () => ({
    symbol: { name: 'oldName', filePath, startLine: 1 },
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
        symbol: { name: 'oldName', filePath: 'def.ts', startLine: 1 },
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
