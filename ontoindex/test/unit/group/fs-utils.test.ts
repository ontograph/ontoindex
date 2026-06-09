import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('group extractor fs-utils', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('readSafe skips files above the configured byte limit', async () => {
    vi.resetModules();
    vi.stubEnv('ONTOINDEX_GROUP_EXTRACTOR_MAX_FILE_BYTES', '8');
    const { readSafe } = await import('../../../src/core/group/extractors/fs-utils.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-fs-utils-'));
    try {
      fs.writeFileSync(path.join(dir, 'small.ts'), '12345678');
      fs.writeFileSync(path.join(dir, 'large.ts'), '123456789');

      expect(readSafe(dir, 'small.ts')).toBe('12345678');
      expect(readSafe(dir, 'large.ts')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('capScanFiles truncates broad extractor globs', async () => {
    vi.resetModules();
    vi.stubEnv('ONTOINDEX_GROUP_EXTRACTOR_MAX_FILES', '2');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { capScanFiles } = await import('../../../src/core/group/extractors/fs-utils.js');

    expect(capScanFiles(['a.ts', 'b.ts', 'c.ts'], 'unit')).toEqual(['a.ts', 'b.ts']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('matched 3 files'));
  });
});
