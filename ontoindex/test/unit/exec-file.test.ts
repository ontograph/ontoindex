import { describe, expect, it } from 'vitest';
import { execFileText } from '../../src/core/process/exec-file.js';

describe('execFileText', () => {
  it('supports uncapped output while retaining the default cap', async () => {
    const output = 'x'.repeat(1024 * 1024 + 1);
    await expect(
      execFileText('node', ['-e', `process.stdout.write('x'.repeat(${output.length}))`]),
    ).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    await expect(
      execFileText('node', ['-e', `process.stdout.write('x'.repeat(${output.length}))`], {
        maxBuffer: null,
      }),
    ).resolves.toHaveLength(output.length);
  });
});
