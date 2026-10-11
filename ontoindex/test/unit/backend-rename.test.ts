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

  it('refuses to apply without confirm or without backend write permission', async () => {
    await fs.writeFile(path.join(repoDir, 'def.ts'), 'export const oldName = 1;\n');
    const params = { symbol_name: 'oldName', new_name: 'newName', dry_run: false };

    await expect(
      renameSymbol({ repoPath: repoDir }, params, lookupDef('def.ts'), { confirmWrites: true }),
    ).rejects.toThrow(/Explicit confirmation required/);
    await expect(
      renameSymbol({ repoPath: repoDir }, { ...params, confirm: true }, lookupDef('def.ts'), {
        confirmWrites: false,
      }),
    ).rejects.toThrow(/Write operations are disabled/);
    expect(await fs.readFile(path.join(repoDir, 'def.ts'), 'utf8')).toBe(
      'export const oldName = 1;\n',
    );
  });

  it('does not follow a symlink to a file outside the repository', async () => {
    const outside = path.join(tmpDir, 'outside.ts');
    await fs.writeFile(outside, 'export const oldName = 1;\n');
    await fs.symlink(outside, path.join(repoDir, 'linked.ts'));

    const result = await renameSymbol(
      { repoPath: repoDir },
      { symbol_name: 'oldName', new_name: 'newName', dry_run: false, confirm: true },
      lookupDef('linked.ts'),
      { confirmWrites: true },
    );

    expect(await fs.readFile(outside, 'utf8')).toBe('export const oldName = 1;\n');
    expect(result).toMatchObject({ applied: false, files_affected: 0 });
  });

  it('reports a failed write instead of success', async () => {
    await fs.writeFile(path.join(repoDir, 'def.ts'), 'export const oldName = 1;\n');
    const denied = Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
    vi.spyOn(fs, 'writeFile').mockRejectedValue(denied);

    const result = await renameSymbol(
      { repoPath: repoDir },
      { symbol_name: 'oldName', new_name: 'newName', dry_run: false, confirm: true },
      lookupDef('def.ts'),
      { confirmWrites: true },
    );

    expect(result).toMatchObject({
      status: 'failed',
      applied: false,
      applied_files: [],
      failed_files: [{ file_path: 'def.ts', error: 'simulated EACCES' }],
    });
  });

  it('applies a confirmed rename inside the repository', async () => {
    await fs.writeFile(path.join(repoDir, 'def.ts'), 'export const oldName = 1;\n');

    const result = await renameSymbol(
      { repoPath: repoDir },
      { symbol_name: 'oldName', new_name: 'newName', dry_run: false, confirm: true },
      lookupDef('def.ts'),
      { confirmWrites: true },
    );

    expect(result).toMatchObject({ status: 'success', applied: true, applied_files: ['def.ts'] });
    expect(await fs.readFile(path.join(repoDir, 'def.ts'), 'utf8')).toBe(
      'export const newName = 1;\n',
    );
  });
});
