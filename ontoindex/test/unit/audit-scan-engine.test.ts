import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { scanAuditPatterns } from '../../src/audit/scan-engine.js';

describe('scanAuditPatterns', () => {
  it('enforces max_hits_per_file across multiple patterns', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-audit-scan-'));
    const filePath = path.join(tmpDir, 'target.ts');
    try {
      await fs.writeFile(filePath, ['alpha beta', 'beta'].join('\n'), 'utf8');

      const result = await scanAuditPatterns({
        files: [filePath],
        patterns: [
          { id: 'alpha', kind: 'literal', expression: 'alpha' },
          { id: 'beta', kind: 'literal', expression: 'beta' },
        ],
        max_hits_per_file: 2,
      });

      expect(result.hits).toEqual([
        expect.objectContaining({
          pattern_id: 'alpha',
          match_text: 'alpha',
        }),
        expect.objectContaining({
          pattern_id: 'beta',
          match_text: 'beta',
        }),
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
