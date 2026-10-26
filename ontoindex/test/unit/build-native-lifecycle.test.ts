import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../scripts/build.js', import.meta.url), 'utf8');
const preflight = source.slice(
  source.indexOf('const NATIVE_ROOT ='),
  source.indexOf('fs.rmSync(DIST,'),
);

describe('native build lifecycle', () => {
  it('produces the Linux addon before checking artifacts and preserves the environment', () => {
    const events: string[] = [];
    const execFileSync = vi.fn(() => events.push('build'));
    const statSync = vi.fn(() => {
      events.push('stat');
      return { isFile: () => true };
    });
    runInNewContext(preflight, {
      ROOT: '/checkout/ontoindex',
      path,
      process: { platform: 'linux', env: { BUILD_FIXTURE: 'retained', CARGO_BUILD_JOBS: '20' } },
      console: { log: vi.fn() },
      execFileSync,
      fs: { statSync },
    });
    expect(events).toEqual(['build', 'stat', 'stat', 'stat']);
    expect(execFileSync).toHaveBeenCalledWith('npm', ['run', 'build'], {
      cwd: '/checkout/ontoindex-native',
      stdio: 'inherit',
      env: { BUILD_FIXTURE: 'retained', CARGO_BUILD_JOBS: '4' },
    });
    expect(statSync).toHaveBeenCalledWith(
      '/checkout/ontoindex-native/native/ontoindex_native.node',
    );
  });

  it('propagates producer failure before consuming artifacts', () => {
    const failure = new Error('native producer failed');
    const statSync = vi.fn();
    expect(() =>
      runInNewContext(preflight, {
        ROOT: '/checkout/ontoindex',
        path,
        process: { platform: 'linux', env: {} },
        console: { log: vi.fn() },
        execFileSync: () => {
          throw failure;
        },
        fs: { statSync },
      }),
    ).toThrow(failure);
    expect(statSync).not.toHaveBeenCalled();
  });
});
