import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vitest = path.join(repoRoot, 'node_modules/vitest/vitest.mjs');
const config = path.join(repoRoot, 'vitest.config.ts');

describe.skipIf(process.platform !== 'linux')('Vitest unhandled errors', () => {
  it('fails an unhandled rejection and preserves its diagnostic', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-unhandled-errors-'));
    const fixture = path.join(cwd, 'test/unit/unhandled.test.ts');
    const marker = 'ONTOINDEX_IQ2_UNHANDLED_REJECTION';

    try {
      fs.mkdirSync(path.dirname(fixture), { recursive: true });
      const runFixture = (source: string) => {
        fs.writeFileSync(fixture, source);
        return spawnSync(
          process.execPath,
          [
            vitest,
            'run',
            '--config',
            config,
            '--root',
            cwd,
            '--project',
            'default',
            '--maxWorkers=1',
            '--no-file-parallelism',
            'test/unit/unhandled.test.ts',
          ],
          {
            cwd,
            encoding: 'utf8',
            env: { ...process.env, ONTOINDEX_SKIP_GLOBAL_SETUP: '1', ONTOINDEX_TEST_WORKERS: '1' },
            timeout: 20_000,
            maxBuffer: 64 * 1024,
          },
        );
      };

      const control = runFixture("it('control', () => { expect(true).toBe(true); });\n");
      expect(control.error, control.stderr).toBeUndefined();
      expect(control.signal, control.stderr).toBeNull();
      expect(control.status, control.stderr).toBe(0);

      const rejected = runFixture(`it('unhandled rejection', async () => {
  Promise.reject(new Error('${marker}'));
  await new Promise(resolve => setImmediate(resolve));
});\n`);
      expect(rejected.error, rejected.stderr).toBeUndefined();
      expect(rejected.signal, rejected.stderr).toBeNull();
      expect(rejected.status, rejected.stderr).toBe(1);
      expect(rejected.stderr).toContain('Unhandled Rejection');
      expect(rejected.stderr).toContain(marker);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
