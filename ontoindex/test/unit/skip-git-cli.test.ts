import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const cliCwd = path.resolve(__dirname, '../..');
const cliEnv = {
  ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
};

describe('--skip-git CLI flag', () => {
  it('Commander maps --skip-git to options.skipGit (not --no-git inversion)', () => {
    // Verify the CLI defines --skip-git and --skip-agents-md in analyze help.
    const helpOutput = execSync('node dist/cli/index.js analyze --help', {
      cwd: cliCwd,
      encoding: 'utf8',
      timeout: 10000,
      env: cliEnv,
    });

    expect(helpOutput).toContain('--skip-git');
    expect(helpOutput).toContain('--skip-agents-md');
    expect(helpOutput).toContain('--index-only');
    expect(helpOutput).toContain('--large-repo-safe');
    expect(helpOutput).toContain('ONTOINDEX_WORKER_SUB_BATCH_MAX_BYTES');
    expect(helpOutput).not.toContain('--no-git');
  });

  it('rejects non-git folder without --skip-git', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-no-git-'));
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), 'export const x = 1;');

    try {
      execSync(`node dist/cli/index.js analyze "${tmpDir}"`, {
        cwd: cliCwd,
        encoding: 'utf8',
        timeout: 10000,
        env: cliEnv,
      });
      // Should not reach here
      expect.unreachable('Should have exited with non-zero');
    } catch (err: any) {
      expect(err.stdout || err.stderr || '').toContain('--skip-git');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
