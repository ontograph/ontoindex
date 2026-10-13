import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({
  findRepo: vi.fn(),
  unregisterRepo: vi.fn(),
  listRegisteredRepos: vi.fn(),
  cleanGenerations: vi.fn(),
}));
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...mocks,
}));
import { cleanCommand } from '../../src/cli/clean.js';
const originalExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  process.exitCode = originalExitCode;
});
it('generation cleanup preserves storage and registration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-cli-'));
  try {
    mocks.findRepo.mockResolvedValue({ repoPath: root, storagePath: root });
    mocks.cleanGenerations.mockResolvedValue({
      kept: [],
      deleted: [],
      skipped: [],
      bytesReclaimable: 0,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await cleanCommand({ generations: true, force: true });
    expect(mocks.unregisterRepo).not.toHaveBeenCalled();
    expect((await fs.stat(root)).isDirectory()).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('continues all repositories after a failure and sets the failure exit code', async () => {
  process.exitCode = undefined;
  mocks.listRegisteredRepos.mockResolvedValue([
    { name: 'first', storagePath: 'first' },
    { name: 'second', storagePath: 'second' },
  ]);
  mocks.cleanGenerations.mockRejectedValueOnce(new Error('unreadable')).mockResolvedValueOnce({
    kept: [],
    deleted: [{ name: 'old', bytes: 4 }],
    skipped: [],
    bytesReclaimable: 4,
  });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await cleanCommand({ generations: true, all: true, force: true });
  expect(mocks.cleanGenerations).toHaveBeenCalledTimes(2);
  expect(errors).toHaveBeenCalledWith('Failed: first: unreadable');
  expect(output).toHaveBeenCalledWith('  Deleted old: 4 B');
  expect(process.exitCode).toBe(1);
});
it('leaves the exit code unset for a successful dry run', async () => {
  process.exitCode = undefined;
  mocks.listRegisteredRepos.mockResolvedValue([{ name: 'first', storagePath: 'first' }]);
  mocks.cleanGenerations.mockResolvedValue({
    kept: [],
    deleted: [],
    skipped: [],
    bytesReclaimable: 0,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await cleanCommand({ generations: true, all: true });
  expect(process.exitCode).toBeUndefined();
});
