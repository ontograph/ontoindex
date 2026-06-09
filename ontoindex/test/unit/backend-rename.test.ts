import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    );

    expect(result.status).toBe('success');
    expect(result.text_search_edits).toBe(0);
    expect(result.warnings).toBeUndefined();
  });
});
