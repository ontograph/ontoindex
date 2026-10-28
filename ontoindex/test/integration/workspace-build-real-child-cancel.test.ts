import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { closeLbug } from '../../src/core/lbug/lbug-adapter.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import {
  superviseWorkspaceBuild,
  WorkspaceBuildError,
} from '../../src/mcp/local/workspace-build-supervisor.js';

// The compiled child is the production entry; the suite skips when the package is not built.
const child = fileURLToPath(new URL('../../dist/core/workspace-build-child.js', import.meta.url));

describe.skipIf(!existsSync(child))('real workspace build child cancellation', () => {
  let root = '';
  afterEach(async () => {
    await closeLbug();
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('kills the real build mid-publication, keeps CURRENT, and rebuilds afterwards', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-real-child-cancel-'));
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_VECTOR_BACKEND', 'lbug');
    await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n');
    await fs.writeFile(
      path.join(repo, 'src/base.ts'),
      'export function baseline() { return 1; }\n',
    );
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-C',
          repo,
          ...args,
        ],
        { stdio: 'pipe' },
      );
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    await runFullAnalysis(
      repo,
      {
        skipNativeClose: true,
        skipAgentsMd: true,
        noStats: true,
        registryName: 'real-child',
        embeddings: false,
      },
      { onProgress() {} },
    );
    await closeLbug();
    await fs.writeFile(
      path.join(repo, 'src/fresh.ts'),
      'export function freshSymbol() { return 2; }\n',
    );

    const { storagePath } = getStoragePaths(repo);
    const overlay = path.join(storagePath, 'overlay');
    const current = path.join(overlay, 'CURRENT');
    const run = (signal?: AbortSignal) =>
      superviseWorkspaceBuild({
        command: process.execPath,
        args: [child, repo, '--symbols', JSON.stringify(['src/fresh.ts'])],
        cwd: repo,
        storagePath,
        timeoutMs: 120_000,
        signal,
      });

    // First real build publishes a generation we can compare against.
    await run();
    const published = await fs.readFile(current, 'utf8');
    const publishedEntries = (await fs.readdir(overlay)).sort();
    await fs.writeFile(
      path.join(repo, 'src/fresh.ts'),
      'export function freshSymbolTwo() { return 3; }\n',
    );

    // Abort as soon as the replacement generation directory exists.
    const controller = new AbortController();
    const watch = (async () => {
      const stop = Date.now() + 60_000;
      while (Date.now() < stop) {
        const extra = (await fs.readdir(overlay).catch(() => [] as string[])).filter(
          (entry) => !publishedEntries.includes(entry),
        );
        if (extra.length) return controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    const failure = await run(controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await watch;
    expect(failure).toBeInstanceOf(WorkspaceBuildError);
    expect((failure as WorkspaceBuildError).kind).toBe('cancelled');
    expect(await fs.readFile(current, 'utf8')).toBe(published);
    expect((await fs.readdir(overlay)).sort()).toEqual(publishedEntries);
    expect(await fs.readdir(path.join(storagePath, 'workspace-inputs'))).toEqual([]);
    expect(existsSync(path.join(storagePath, 'workspace-build.owner.json'))).toBe(false);

    // The next real build is admitted and replaces the generation.
    await run();
    const recovered = await fs.readFile(current, 'utf8');
    expect(recovered).not.toBe(published);
    expect(existsSync(path.join(overlay, recovered.trim(), 'base.json'))).toBe(true);
  }, 240_000);
});
