import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({
  findRepo: vi.fn(),
  unregisterRepo: vi.fn(),
  listRegisteredRepos: vi.fn(),
}));
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...mocks,
}));
import { cleanCommand } from '../../src/cli/clean.js';
afterEach(() => {
  vi.restoreAllMocks();
});
it('generation cleanup preserves storage and registration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-cli-'));
  try {
    mocks.findRepo.mockResolvedValue({ repoPath: root, storagePath: root });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await cleanCommand({ generations: true, force: true });
    expect(mocks.unregisterRepo).not.toHaveBeenCalled();
    expect((await fs.stat(root)).isDirectory()).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
