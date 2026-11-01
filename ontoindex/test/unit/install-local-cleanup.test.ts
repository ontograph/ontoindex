import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const installer = readFileSync(
  fileURLToPath(new URL('../../../scripts/install-ontoindex-latest.sh', import.meta.url)),
  'utf8',
);
const cleanup = installer.match(/^cleanup_temp_asset\(\) \{\n[\s\S]*?^\}/m)?.[0];

describe('installer EXIT cleanup', () => {
  it('keeps successful local installs successful and preserves an install failure', () => {
    expect(cleanup).toBeDefined();
    for (const status of [0, 7]) {
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -e; temp_asset_dir=""; ${cleanup}\ntrap cleanup_temp_asset EXIT\nexit ${status}`,
        ],
        { encoding: 'utf8' },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(status);
    }
  });

  it('removes owned download scratch and retains cleanup failures', () => {
    expect(cleanup).toBeDefined();
    const scratch = mkdtempSync(path.join(tmpdir(), 'ontoindex-cleanup-test-'));
    try {
      execFileSync('bash', [
        '-c',
        `set -e; temp_asset_dir="$1"; ${cleanup}\ntrap cleanup_temp_asset EXIT`,
        'cleanup-test',
        scratch,
      ]);
      expect(existsSync(scratch)).toBe(false);
      const failure = spawnSync('bash', [
        '-c',
        `set -e; temp_asset_dir=owned; rm() { return 9; }; ${cleanup}\ntrap cleanup_temp_asset EXIT`,
      ]);
      expect(failure.error).toBeUndefined();
      expect(failure.status).toBe(9);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
