import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.doUnmock('node:child_process');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function runBuild(options: { nativeFailure?: Error; missingAfterBuild?: boolean } = {}) {
  vi.resetModules();
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const stop = new Error('reached TypeScript compilation');
  let built = false;
  const execSync = vi.fn((command: string) => {
    if (command !== 'npm run build') throw stop;
    if (options.nativeFailure) throw options.nativeFailure;
    built = true;
  });
  const rmSync = vi.fn();
  const copyFileSync = vi.fn();
  const statSync = vi.fn(() => ({
    isFile: () => !(built && options.missingAfterBuild),
  }));
  vi.doMock('node:child_process', () => ({ execSync }));
  vi.doMock('node:fs', () => ({ default: { statSync, rmSync, copyFileSync } }));
  const result = import('../../scripts/build.js');
  return { result, stop, execSync, statSync, rmSync, copyFileSync };
}

describe('Linux native build lifecycle', () => {
  it('builds even when an existing addon is present, before TypeScript compilation', async () => {
    const build = await runBuild();
    await expect(build.result).rejects.toThrow(build.stop);
    expect(build.execSync.mock.calls.map(([command]) => command)).toEqual([
      'npm run build',
      'npx tsc',
    ]);
    expect(build.execSync).toHaveBeenNthCalledWith(
      1,
      'npm run build',
      expect.objectContaining({
        cwd: expect.stringContaining(`${path.sep}ontoindex-native`),
        stdio: 'inherit',
      }),
    );
    expect(build.statSync).toHaveBeenCalled();
  });

  it('propagates a native build failure before deleting or copying output', async () => {
    const failure = new Error('native build failed');
    const build = await runBuild({ nativeFailure: failure });
    await expect(build.result).rejects.toThrow(failure);
    expect(build.execSync).toHaveBeenCalledTimes(1);
    expect(build.rmSync).not.toHaveBeenCalled();
    expect(build.copyFileSync).not.toHaveBeenCalled();
  });

  it('rejects missing post-build artifacts before deleting or copying output', async () => {
    const build = await runBuild({ missingAfterBuild: true });
    await expect(build.result).rejects.toThrow('Missing native build artifact');
    expect(build.execSync).toHaveBeenCalledTimes(1);
    expect(build.rmSync).not.toHaveBeenCalled();
    expect(build.copyFileSync).not.toHaveBeenCalled();
  });
});
