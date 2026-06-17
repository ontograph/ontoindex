import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  collectFileScopePreview,
  explainPathScope,
} from '../../src/core/indexing/file-scope-preview.js';

describe('collectFileScopePreview', () => {
  let tmpDir: string;
  let oldMaxFileKb: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-file-scope-'));
    oldMaxFileKb = process.env.ONTOINDEX_SCAN_MAX_FILE_KB;
    process.env.ONTOINDEX_SCAN_MAX_FILE_KB = '1';
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src/index.ts'), 'export const value = 1;\n');
    await fs.writeFile(path.join(tmpDir, 'src/app.js'), 'export const app = 1;\n');
    await fs.writeFile(path.join(tmpDir, 'src/big.ts'), 'x'.repeat(2048));
    await fs.writeFile(path.join(tmpDir, 'dist/bundle.js'), 'export const bundled = 1;\n');
  });

  afterEach(async () => {
    if (oldMaxFileKb === undefined) {
      delete process.env.ONTOINDEX_SCAN_MAX_FILE_KB;
    } else {
      process.env.ONTOINDEX_SCAN_MAX_FILE_KB = oldMaxFileKb;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('collects included counts without creating .ontoindex', async () => {
    const preview = await collectFileScopePreview(tmpDir);

    expect(preview.repoPath).toBe(tmpDir);
    expect(preview.includedCount).toBe(2);
    expect(preview.skippedCount).toBe(1);
    expect(preview.totalCandidates).toBe(3);
    expect(preview.includedByExtension).toEqual({ '.js': 1, '.ts': 1 });
    await expect(fs.stat(path.join(tmpDir, '.ontoindex'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports large skipped files and largest included files', async () => {
    const preview = await collectFileScopePreview(tmpDir, { limit: 2 });

    expect(preview.topSkippedDirectories).toEqual([
      { path: 'src', count: 1, reason: 'large-file' },
    ]);
    expect(preview.warnings.some((warning) => warning.includes('large-file-skipped:src/big.ts'))).toBe(
      true,
    );
    expect(preview.largestIncludedFiles.map((file) => file.path)).not.toContain('dist/bundle.js');
    expect(preview.largestIncludedFiles[0].path).toMatch(/^src\//);
  });

  it('re-exports explainPathScope for MCP and CLI consumers', async () => {
    const result = await explainPathScope(tmpDir, 'src/index.ts');

    expect(result.included).toBe(true);
    expect(result.reason).toBe('included-extension');
  });
});
