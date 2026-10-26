import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RepoHandle } from 'ontoindex-shared';

import {
  ensureRepoInitialized,
  RepoPreparationWaitError,
  resolveRepoFromHandles,
  committedGraphNotice,
  prepareWorkspaceRead,
  stopWorkspaceBuild,
  acquireWorkspaceWatch,
  WORKSPACE_PREPARATION_DEADLINE_MS,
} from '../../src/mcp/local/local-backend-repo-runtime.js';
import type { OverlaySnapshot } from '../../src/mcp/local/backend-overlay.js';

const { createWatchCommand } = vi.hoisted(() => ({ createWatchCommand: vi.fn() }));
vi.mock('../../src/cli/watch.js', () => ({ createWatchCommand }));

describe('shared workspace watcher lifecycle', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    createWatchCommand.mockReset();
  });

  it('drains every retained alias before stopping and admitting a replacement watcher', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-watch-alias-'));
    const aliasPath = `${root}-alias`;
    await fs.symlink(root, aliasPath);
    const repo = { id: root, repoPath: root, storagePath: path.join(root, '.ontoindex') };
    const alias = { ...repo, id: aliasPath, repoPath: aliasPath };
    const stop = vi.fn(async () => {});
    createWatchCommand.mockResolvedValue({ stop, owned: true });
    const dirty = {
      usable: false,
      reason: 'missing',
      dirtyPaths: new Set(['a.ts']),
      parseErrorPaths: new Set(),
      overlayPaths: new Set(),
      uncoveredPaths: new Set(),
      tombstones: new Set(),
    } as OverlaySnapshot;
    const signals: AbortSignal[] = [];
    const drains: (() => void)[] = [];
    const dependencies = {
      getSnapshot: async () => dirty,
      baseFileCount: async () => 1,
      acquireLock: async () => ({ release: async () => {} }),
      evictSnapshot() {},
      buildWorkspaceGraph: async (_repo: typeof repo, signal?: AbortSignal) => {
        signals.push(signal!);
        await new Promise<void>((resolve) => {
          drains.push(resolve);
        });
      },
    };
    try {
      const first = await acquireWorkspaceWatch(repo);
      const last = await acquireWorkspaceWatch(alias);
      expect(createWatchCommand).toHaveBeenCalledOnce();
      expect(createWatchCommand.mock.calls[0][0]).toBe(await fs.realpath(root));
      const reads = [repo, alias].map((owner) =>
        prepareWorkspaceRead({
          repo: owner,
          needsRelationships: true,
          dependencies,
        }).catch((error) => error.code),
      );
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      await first.release();
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      expect(stop).not.toHaveBeenCalled();
      const release = last.release();
      await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
      let replacementReady = false;
      const replacement = acquireWorkspaceWatch(repo).then((value) => {
        replacementReady = true;
        return value;
      });
      expect(signals[1].aborted).toBe(false);
      expect(replacementReady).toBe(false);
      drains[0]();
      await vi.waitFor(() => expect(signals[1].aborted).toBe(true));
      expect(stop).not.toHaveBeenCalled();
      expect(createWatchCommand).toHaveBeenCalledOnce();
      drains[1]();
      await release;
      expect(await Promise.all(reads)).toEqual(['workspace_cancelled', 'workspace_cancelled']);
      const renewed = await replacement;
      expect(stop).toHaveBeenCalledOnce();
      expect(createWatchCommand).toHaveBeenCalledTimes(2);
      await renewed.release();
    } finally {
      drains.forEach((drain) => drain());
      await Promise.all([stopWorkspaceBuild(repo), stopWorkspaceBuild(alias)]);
      await fs.rm(aliasPath, { force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('retains the admission fence when final shared cleanup fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-watch-failed-'));
    const repo = { id: root, repoPath: root, storagePath: path.join(root, '.ontoindex') };
    const stop = vi.fn(async () => {
      throw new Error('watcher still owned');
    });
    createWatchCommand.mockResolvedValue({ stop, owned: true });
    try {
      const first = await acquireWorkspaceWatch(repo);
      const last = await acquireWorkspaceWatch({ ...repo, id: `${root}-alias` });
      await first.release();
      expect(stop).not.toHaveBeenCalled();
      await expect(last.release()).rejects.toThrow('Workspace watcher cleanup failed');
      await expect(acquireWorkspaceWatch(repo)).rejects.toThrow('Workspace watcher cleanup failed');
      await expect(last.release()).rejects.toThrow('Workspace watcher cleanup failed');
      expect(createWatchCommand).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// Run the real compiled runtime and child entry in separate processes. Only the entry's
// analysis dependency is replaced; source-mode fallback must never satisfy this fixture.
async function compiledAdmissionFixture(config: {
  repoPath: string;
  runtime: string;
  supervisor: string;
  analyze: string;
  child: string;
  state: string;
  peer?: boolean;
}) {
  // Keep the serialized subprocess function independent of Vitest's import rewriting.
  const load = new Function('url', 'return import(url)');
  const fs = (await load('node:fs/promises')) as typeof import('node:fs/promises');
  const syncFs = (await load('node:fs')) as typeof import('node:fs');
  const path = (await load('node:path')) as typeof import('node:path');
  const cp = (await load('node:child_process')) as typeof import('node:child_process');
  const { fileURLToPath } = (await load('node:url')) as typeof import('node:url');
  const { syncBuiltinESMExports } = (await load('node:module')) as typeof import('node:module');
  const storagePath = path.join(config.repoPath, '.ontoindex');
  const markerPath = path.join(storagePath, 'workspace-build.owner.json');
  const lockPath = path.join(storagePath, 'analyze.lock');
  const entriesPath = path.join(config.repoPath, 'entries.jsonl');
  const { prepareWorkspaceRead } = await load(config.runtime);
  const { sweepOrphanedWorkspaceBuild } = await load(config.supervisor);
  const originalKill = process.kill.bind(process);
  const originalSpawn = cp.default.spawn;
  let group: number | undefined;
  const builds: number[] = [];
  cp.default.spawn = ((...args: Parameters<typeof originalSpawn>) => {
    const child = originalSpawn(...args);
    if (args[0] === process.execPath && args[1]?.[0] === fileURLToPath(config.child)) {
      group = child.pid;
      if (child.pid) {
        builds.push(child.pid);
        syncFs.appendFileSync(path.join(config.repoPath, 'groups.jsonl'), `${child.pid}\n`);
      }
    }
    return child;
  }) as typeof originalSpawn;
  syncBuiltinESMExports();
  const exists = (filename: string) =>
    fs.stat(filename).then(
      () => true,
      () => false,
    );
  const readEntries = async () =>
    (await fs.readFile(entriesPath, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const dirty = {
    usable: false,
    reason: 'missing',
    generation: config.peer ? 'changed-identity' : 'initial',
    dirtyPaths: new Set([config.peer ? 'b.ts' : 'a.ts']),
    configPaths: new Set(),
    parseErrorPaths: new Set(),
    overlayPaths: new Set(),
    uncoveredPaths: new Set(),
    tombstones: new Set(),
  };
  let probes = 0;
  const prepare = () =>
    prepareWorkspaceRead({
      repo: { id: 'fixture', repoPath: config.repoPath, storagePath },
      needsRelationships: true,
      dependencies: {
        getSnapshot: async () =>
          ++probes < 3
            ? dirty
            : {
                ...dirty,
                usable: true,
                reason: null,
                capability: 'workspace-graph',
                coverage: 'complete',
              },
        baseFileCount: async () => 1,
        evictSnapshot() {},
      },
    }).then(
      () => ({ result: 'completed' }),
      (error: { code: string; message: string }) => ({
        result: error.code,
        message: error.message,
      }),
    );
  const runPeer = (script: string, args: string[] = []) => {
    const result = cp.spawnSync(process.execPath, ['--input-type=module', '-e', script, ...args], {
      cwd: config.repoPath,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, IQ4F_ENTRY_MODE: 'successor' },
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Fixture peer failed (${result.status}): ${result.error ?? ''} ${result.stderr}`,
      );
    }
    return JSON.parse(result.stdout.trim());
  };
  try {
    if (config.peer) {
      const outcome = await prepare();
      return { ...outcome, builds, entries: await readEntries() };
    }
    if (config.state === 'reaped') {
      const owner = cp.spawnSync(process.execPath, ['-e', '0']);
      if (owner.error || owner.status !== 0 || !owner.pid)
        throw new Error('Fixture owner did not reap');
      await fs.mkdir(path.join(storagePath, 'overlay', 'orphan'), { recursive: true });
      await fs.writeFile(
        markerPath,
        JSON.stringify({
          parentPid: owner.pid,
          childPid: owner.pid,
          before: { overlay: ['CURRENT', 'old-gen'], 'workspace-inputs': [] },
        }),
      );
    }
    if (config.state === 'unresolved') {
      // Ignore SIGKILL only for the group spawned by this runtime. Its actual survivor
      // keeps groupAlive true; all unrelated PIDs/signals use the real implementation.
      process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
        if (group !== undefined && pid === -group && signal === 'SIGKILL') return true;
        return originalKill(pid, signal);
      }) as typeof process.kill;
    }
    const first = await prepare();
    const markerAfterFirst = await exists(markerPath);
    const lockAfterFirst = await exists(lockPath);
    const entriesAfterFirst = await readEntries();
    const survivor = entriesAfterFirst.find((entry) => entry.survivor)?.survivor as
      | number
      | undefined;
    let survivorAlive = false;
    if (survivor) {
      originalKill(survivor, 0);
      survivorAlive = true;
    }
    const swept = await sweepOrphanedWorkspaceBuild(storagePath);
    // CLI and MCP peers are independent processes; no in-memory cooldown or lock mock.
    const cli = runPeer(
      `
      const { acquireAnalyzeLock } = await import(${JSON.stringify(config.analyze)});
      try {
        const lock = await acquireAnalyzeLock(process.argv[1]);
        await lock.release();
        console.log(JSON.stringify({ admitted: true }));
      } catch (error) {
        console.log(JSON.stringify({ admitted: false, message: error.message }));
      }
    `,
      [config.repoPath],
    );
    const peerConfig = { ...config, peer: true };
    const mcp = runPeer(`
      const result = await (${compiledAdmissionFixture.toString()})(${JSON.stringify(peerConfig)});
      console.log(JSON.stringify(result));
    `);
    return {
      state: config.state,
      first,
      markerAfterFirst,
      lockAfterFirst,
      survivorAlive,
      swept,
      cli,
      mcp,
      entriesAfterFirst,
      markerAfterSuccessor: await exists(markerPath),
      liveArtifactRetained: await exists(path.join(storagePath, 'overlay', 'live-gen')),
      liveCaptureRetained: await exists(path.join(storagePath, 'workspace-inputs', 'live-capture')),
    };
  } finally {
    process.kill = originalKill;
    cp.default.spawn = originalSpawn;
    syncBuiltinESMExports();
    if (!config.peer && config.state === 'unresolved') {
      // The handshake records only fixture-owned children, never host processes.
      for (const entry of await readEntries()) {
        if (!entry.survivor) continue;
        try {
          originalKill(-entry.pid, 'SIGKILL');
        } catch {}
      }
    }
  }
}

describe('compiled surviving-build admission', () => {
  it.each(['absent', 'reaped', 'unresolved'])(
    'retains ownership until the build is safely reaped: %s',
    async (state) => {
      const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'iq4f-admission-'));
      const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
      const config = {
        repoPath,
        state,
        runtime: pathToFileURL(path.join(dist, 'mcp/local/local-backend-repo-runtime.js')).href,
        supervisor: pathToFileURL(path.join(dist, 'mcp/local/workspace-build-supervisor.js')).href,
        analyze: pathToFileURL(path.join(dist, 'cli/analyze.js')).href,
        child: pathToFileURL(path.join(dist, 'core/workspace-build-child.js')).href,
      };
      try {
        for (const url of [config.runtime, config.supervisor, config.analyze, config.child]) {
          await fs.access(fileURLToPath(url));
        }
        const storage = path.join(repoPath, '.ontoindex');
        await fs.mkdir(path.join(storage, 'overlay', 'old-gen'), { recursive: true });
        await fs.writeFile(path.join(storage, 'overlay', 'CURRENT'), 'old-gen\n');
        const preload = path.join(repoPath, 'analysis-fixture.mjs');
        await fs.writeFile(
          preload,
          `
          import { registerHooks } from 'node:module';
          const child = ${JSON.stringify(config.child)};
          registerHooks({
            resolve(specifier, context, nextResolve) {
              if (context.parentURL === child && specifier === './run-analyze.js') {
                return { url: 'iq4f:analysis', shortCircuit: true };
              }
              return nextResolve(specifier, context);
            },
            load(url, context, nextLoad) {
              if (url !== 'iq4f:analysis') return nextLoad(url, context);
              return { format: 'module', shortCircuit: true, source: ${JSON.stringify(`
                import fs from 'node:fs';
                import path from 'node:path';
                import { spawn } from 'node:child_process';
                import { pathToFileURL } from 'node:url';
                export async function runFullAnalysis(repoPath, options) {
                  const storage = path.join(repoPath, '.ontoindex');
                  let survivor;
                  if (process.env.IQ4F_ENTRY_MODE === 'unresolved') {
                    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
                      stdio: 'ignore',
                    });
                    survivor = worker.pid;
                    fs.mkdirSync(path.join(storage, 'overlay', 'live-gen'), { recursive: true });
                    fs.mkdirSync(path.join(storage, 'workspace-inputs', 'live-capture'), { recursive: true });
                  }
                  fs.appendFileSync(path.join(repoPath, 'entries.jsonl'), JSON.stringify({
                    pid: process.pid, survivor, options, entry: pathToFileURL(process.argv[1]).href,
                    marker: JSON.parse(fs.readFileSync(path.join(storage, 'workspace-build.owner.json'), 'utf8')),
                  }) + '\\n');
                }
              `)} };
            },
          });
        `,
        );
        const result = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `console.log(JSON.stringify(await (${compiledAdmissionFixture.toString()})(${JSON.stringify(config)})));`,
          ],
          {
            cwd: repoPath,
            encoding: 'utf8',
            timeout: 25_000,
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              ONTOINDEX_AUTO_WORKSPACE: '1',
              IQ4F_ENTRY_MODE: state,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
            },
          },
        );
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const observed = JSON.parse(result.stdout.trim());
        console.info('IQ-4F compiled admission', JSON.stringify(observed));
        const firstEntry = observed.entriesAfterFirst[0];
        expect(firstEntry.entry).toBe(config.child);
        expect(firstEntry.options).toEqual({ workspaceGraph: true, skipNativeClose: true });
        expect(firstEntry.pid).toBe(firstEntry.marker.childPid);
        if (state === 'unresolved') {
          expect(observed.first).toMatchObject({
            result: 'workspace_build_failed',
            message: 'Working-tree graph build failed.',
          });
          expect(observed.survivorAlive).toBe(true);
          expect
            .soft(observed.markerAfterFirst, 'unstoppable must retain recovery ownership')
            .toBe(true);
          expect
            .soft(observed.cli.admitted, 'CLI must refuse an unresolved build owner')
            .toBe(false);
          expect.soft(observed.cli.message).toContain('Cannot safely recover');
          expect.soft(observed.mcp.result).toBe('workspace_busy');
          expect
            .soft(observed.mcp.builds, 'independent MCP must not spawn a successor')
            .toEqual([]);
          expect.soft(observed.markerAfterSuccessor).toBe(true);
          expect.soft(observed.liveArtifactRetained).toBe(true);
          expect.soft(observed.liveCaptureRetained).toBe(true);
        } else {
          expect(observed.first.result).toBe('completed');
          expect(observed.survivorAlive).toBe(false);
          expect(observed.markerAfterFirst).toBe(false);
          expect(observed.lockAfterFirst).toBe(false);
          expect(observed.cli.admitted).toBe(true);
          expect(observed.mcp.result).toBe('completed');
          expect(observed.mcp.builds).toHaveLength(1);
          expect(observed.mcp.entries).toHaveLength(2);
        }
      } finally {
        // Also cover an outer timeout before the subprocess could run its own finally.
        const groups = await fs
          .readFile(path.join(repoPath, 'groups.jsonl'), 'utf8')
          .catch(() => '');
        for (const raw of groups.trim().split('\n').filter(Boolean)) {
          try {
            process.kill(-Number(raw), 'SIGKILL');
          } catch {}
        }
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    },
  );
});

describe('workspace read preparation', () => {
  afterEach(() => vi.unstubAllEnvs());
  let sequence = 0;
  it.each([
    ['flag off', '0', 2, undefined],
    ['clean tree', '1', 0, undefined],
    ['dirty tree', '1', 2, expect.stringContaining('2 uncommitted file change')],
    ['default dirty tree', undefined, 2, expect.stringContaining('2 uncommitted file change')],
  ])('committed-graph notice: %s', async (_name, flag, count, expected) => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', flag);
    const snapshot = {
      dirtyPaths: new Set(Array.from({ length: count }, (_, i) => `f${i}.ts`)),
    } as unknown as OverlaySnapshot;
    const repo = { id: 'n', repoPath: '/r', storagePath: '/r/.o' };
    expect(await committedGraphNotice(repo, async () => snapshot)).toEqual(expected);
  });
  function fixture() {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const dirty: OverlaySnapshot = {
      usable: false,
      reason: 'missing',
      dirtyPaths: new Set(['a.ts']),
      parseErrorPaths: new Set(),
      overlayPaths: new Set(),
      uncoveredPaths: new Set(),
      tombstones: new Set(),
    };
    const ready: OverlaySnapshot = {
      ...dirty,
      usable: true,
      reason: null,
      capability: 'workspace-graph',
      coverage: 'complete',
    };
    const release = vi.fn(async () => {});
    const dependencies = {
      getSnapshot: vi
        .fn(async () => dirty)
        .mockResolvedValueOnce(dirty)
        .mockResolvedValueOnce(dirty)
        .mockResolvedValue(ready),
      acquireLock: vi.fn(async () => ({ release })),
      buildWorkspaceGraph: vi.fn(
        async (
          _repo: { id: string; repoPath: string; storagePath: string },
          _signal?: AbortSignal,
        ) => {},
      ),
      evictSnapshot: vi.fn(),
      baseFileCount: vi.fn(async (): Promise<number | undefined> => 10),
      now: vi.fn(() => 0),
    };
    const options = {
      repo: { id: `workspace-${sequence++}`, repoPath: '/repo', storagePath: '/repo/.ontoindex' },
      needsRelationships: true,
      dependencies,
    };
    return { dirty, ready, release, dependencies, options };
  }
  it.each([
    ['getSnapshot', 'timeout'],
    ['getSnapshot', 'cancelled'],
    ['baseFileCount', 'timeout'],
    ['baseFileCount', 'cancelled'],
  ] as const)('does not admit a build after %s resumes for a %s caller', async (probe, code) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const f = fixture();
      const controller = new AbortController();
      let resume!: () => void;
      let entered!: () => void;
      const probeEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const deferred = new Promise<void>((resolve) => {
        resume = resolve;
      });
      if (probe === 'getSnapshot') {
        f.dependencies.getSnapshot
          .mockReset()
          .mockResolvedValue(f.dirty)
          .mockImplementationOnce(async () => {
            entered();
            await deferred;
            return f.dirty;
          });
      } else {
        f.dependencies.baseFileCount.mockImplementationOnce(async () => {
          entered();
          await deferred;
          return 10;
        });
      }
      const pending = prepareWorkspaceRead({
        ...f.options,
        signal: controller.signal,
        deadline: performance.now() + 50,
      });
      const rejected = expect(pending).rejects.toMatchObject({ code: `workspace_${code}` });
      await probeEntered;
      if (code === 'timeout') await vi.advanceTimersByTimeAsync(50);
      else controller.abort();
      await rejected;
      resume();
      // The rejected caller settles before its probe continuation; drain that continuation too.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.dependencies.acquireLock).not.toHaveBeenCalled();
      expect(f.dependencies.buildWorkspaceGraph).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['clean', 'flag off'])('does not build for %s', async (kind) => {
    const f = fixture();
    if (kind === 'clean') f.dirty.dirtyPaths = new Set();
    if (kind === 'flag off') vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
    expect(await prepareWorkspaceRead(f.options)).toBe(f.dirty);
    expect(f.dependencies.acquireLock).not.toHaveBeenCalled();
    expect(f.dependencies.buildWorkspaceGraph).not.toHaveBeenCalled();
  });
  it('builds bounded symbols through the shared builder', async () => {
    const f = fixture();
    f.options.needsRelationships = false;
    f.ready.capability = 'symbols';
    expect(await prepareWorkspaceRead(f.options)).toBe(f.ready);
    expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledWith(
      f.options.repo,
      expect.any(AbortSignal),
      { workspaceGraph: false, includePaths: ['a.ts'] },
    );
  });
  it('builds a missing workspace graph when activation is absent', async () => {
    const f = fixture();
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', undefined);
    expect(await prepareWorkspaceRead(f.options)).toBe(f.ready);
    expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledWith(
      f.options.repo,
      expect.any(AbortSignal),
      { workspaceGraph: true, includePaths: ['a.ts'] },
    );
  });
  it('fails closed when dirty planning cannot establish workspace identity', async () => {
    const f = fixture();
    f.dirty.dirtyPaths = new Set();
    f.dirty.reason = 'dirty planning failed: private detail';
    await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({
      code: 'workspace_build_failed',
    });
    expect(f.dependencies.buildWorkspaceGraph).not.toHaveBeenCalled();
  });
  it('builds once for a clean tree whose HEAD differs from the committed base', async () => {
    const f = fixture();
    f.dirty.dirtyPaths = new Set();
    f.dirty.baseMatches = false;
    f.dirty.headChanged = true;
    f.dirty.currentHead = 'new-head';
    f.ready.dirtyPaths = new Set();
    f.dependencies.getSnapshot.mockReset().mockResolvedValue(f.dirty);
    f.dependencies.buildWorkspaceGraph.mockImplementation(async () => {
      f.dependencies.getSnapshot.mockResolvedValue(f.ready);
    });
    expect(await prepareWorkspaceRead(f.options)).toBe(f.ready);
    expect(await prepareWorkspaceRead(f.options)).toBe(f.ready);
    expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledOnce();
  });
  it('rejects a weaker symbols result for a full graph caller', async () => {
    const f = fixture();
    f.ready.capability = 'symbols';
    await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({
      code: 'workspace_build_failed',
    });
  });
  it('builds, releases, evicts, and validates a new snapshot', async () => {
    const f = fixture();
    expect(await prepareWorkspaceRead(f.options)).toBe(f.ready);
    expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.dependencies.evictSnapshot).toHaveBeenCalledWith(f.options.repo.id);
    expect(f.dependencies.getSnapshot).toHaveBeenCalledTimes(3);
  });
  it('builds the working-tree graph for a configuration-only edit', async () => {
    const f = fixture();
    // No dirty source file: only tsconfig.json differs from the committed tree.
    const configOnly = {
      ...f.dirty,
      dirtyPaths: new Set<string>(),
      configPaths: new Set(['tsconfig.json']),
    };
    f.dependencies.getSnapshot.mockReset();
    f.dependencies.getSnapshot
      .mockResolvedValueOnce(configOnly)
      .mockResolvedValueOnce(configOnly)
      .mockResolvedValue(f.ready);
    expect(await prepareWorkspaceRead(f.options)).toBe(f.ready);
    expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledOnce();
  });
  it('adopts a graph another server finished while this one waited for the lock', async () => {
    const f = fixture();
    // The probe sees a dirty tree; by the time the lock is ours, a peer has published the graph.
    f.dependencies.getSnapshot.mockReset();
    f.dependencies.getSnapshot.mockResolvedValueOnce(f.dirty).mockResolvedValue(f.ready);
    expect(await prepareWorkspaceRead(f.options)).toBe(f.ready);
    expect(f.dependencies.acquireLock).toHaveBeenCalledOnce();
    expect(f.dependencies.buildWorkspaceGraph).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('releases the lock when the under-lock re-read fails', async () => {
    const f = fixture();
    f.dependencies.getSnapshot
      .mockReset()
      .mockResolvedValueOnce(f.dirty)
      .mockRejectedValueOnce(new Error('probe failed'));
    await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({
      code: 'workspace_build_failed',
    });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.dependencies.buildWorkspaceGraph).not.toHaveBeenCalled();
  });
  it('shares concurrent builds and collapses changed snapshots into one successor', async () => {
    const f = fixture();
    let finish!: () => void;
    f.dependencies.getSnapshot.mockResolvedValue(f.dirty);
    f.dependencies.buildWorkspaceGraph.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = prepareWorkspaceRead(f.options);
    const shared = prepareWorkspaceRead(f.options);
    await vi.waitFor(() => expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledOnce());
    f.dependencies.getSnapshot.mockResolvedValue({ ...f.dirty, dirtyPaths: new Set(['b.ts']) });
    const second = prepareWorkspaceRead(f.options);
    const third = prepareWorkspaceRead(f.options);
    await vi.waitFor(() => expect(f.dependencies.getSnapshot).toHaveBeenCalledTimes(5));
    // First build's post-build read, then the successor's under-lock re-read, then its post-build read.
    f.dependencies.getSnapshot
      .mockResolvedValueOnce(f.ready)
      .mockResolvedValueOnce(f.dirty)
      .mockResolvedValue(f.ready);
    finish();
    await Promise.all([first, shared, second, third]);
    expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledTimes(2);
  });
  it('returns busy without building when the lock is held', async () => {
    const f = fixture();
    f.dependencies.acquireLock.mockRejectedValue(new Error('OntoIndex analyze is already running'));
    await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({ code: 'workspace_busy' });
    expect(f.dependencies.buildWorkspaceGraph).not.toHaveBeenCalled();
  });
  it('says when the held lock belongs to this server', async () => {
    const f = fixture();
    f.dependencies.getSnapshot.mockReset();
    f.dependencies.getSnapshot.mockResolvedValue(f.dirty);
    f.dependencies.acquireLock.mockRejectedValue(
      new Error(
        `OntoIndex analyze is already running for this repo (PID ${process.pid} since now).`,
      ),
    );
    await expect(prepareWorkspaceRead(f.options)).rejects.toThrow(/started by this server/);
    const other = fixture();
    other.dependencies.getSnapshot.mockReset();
    other.dependencies.getSnapshot.mockResolvedValue(other.dirty);
    other.dependencies.acquireLock.mockRejectedValue(
      new Error('OntoIndex analyze is already running for this repo (PID 1 since now).'),
    );
    await expect(prepareWorkspaceRead(other.options)).rejects.not.toThrow(/started by this server/);
  });
  it('does not retry a held analyze lock on every request', async () => {
    const f = fixture();
    f.dependencies.getSnapshot.mockReset();
    f.dependencies.getSnapshot.mockResolvedValue(f.dirty);
    f.dependencies.acquireLock.mockRejectedValue(new Error('OntoIndex analyze is already running'));
    await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({ code: 'workspace_busy' });
    await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({ code: 'workspace_busy' });
    expect(f.dependencies.acquireLock).toHaveBeenCalledTimes(1);
    f.dependencies.now.mockReturnValue(6_000);
    f.dependencies.acquireLock.mockResolvedValue({ release: f.release });
    f.dependencies.getSnapshot
      .mockResolvedValueOnce(f.dirty)
      .mockResolvedValueOnce(f.dirty)
      .mockResolvedValue(f.ready);
    await prepareWorkspaceRead(f.options);
    expect(f.dependencies.acquireLock).toHaveBeenCalledTimes(2);
  });
  it.each(['error', 'non-error'])(
    'keeps %s lock and build diagnostics out of first and cached messages for all reads',
    async (kind) => {
      const privateText = `SYNTHETIC_SECRET\nSYNTHETIC_SOURCE_${'x'.repeat(8192)}`;
      for (const failure of ['busy', 'same-server busy', 'lock', 'build']) {
        const f = fixture();
        f.dependencies.getSnapshot.mockReset().mockResolvedValue(f.dirty);
        const raw = failure.includes('busy')
          ? `OntoIndex analyze is already running (PID ${failure === 'same-server busy' ? process.pid : 1} since now). ${privateText}`
          : privateText;
        const cause = kind === 'error' ? new Error(raw) : raw;
        const code = failure.includes('busy') ? 'workspace_busy' : 'workspace_build_failed';
        const message =
          failure === 'same-server busy'
            ? 'A working-tree graph build started by this server is still running; retry shortly.'
            : failure === 'busy'
              ? 'An analyze lock is held; retry shortly.'
              : failure === 'lock'
                ? 'Working-tree graph lock acquisition failed.'
                : 'Working-tree graph build failed.';
        if (failure === 'build') f.dependencies.buildWorkspaceGraph.mockRejectedValue(cause);
        else f.dependencies.acquireLock.mockRejectedValue(cause);

        await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({
          code,
          message,
          cause,
        });
        await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({ code, message });
        expect(f.dependencies.acquireLock).toHaveBeenCalledTimes(failure === 'lock' ? 2 : 1);
        expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledTimes(
          failure === 'build' ? 1 : 0,
        );
        expect(f.release).toHaveBeenCalledTimes(failure === 'build' ? 1 : 0);

        f.options.needsRelationships = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(
            prepareWorkspaceRead({ ...f.options, wantsWorkspaceGraph: true }),
          ).rejects.toMatchObject({ code, message });
        }
        f.dependencies.now.mockReturnValue(31_000);
        f.dependencies.acquireLock.mockResolvedValue({ release: f.release });
        f.dependencies.buildWorkspaceGraph.mockResolvedValue(undefined);
        f.dependencies.getSnapshot
          .mockResolvedValueOnce(f.dirty)
          .mockResolvedValueOnce(f.dirty)
          .mockResolvedValue(f.ready);
        expect(await prepareWorkspaceRead({ ...f.options, needsRelationships: true })).toBe(
          f.ready,
        );
      }
    },
  );
  it('admits a full graph build exactly at the indexed-file limit', async () => {
    const f = fixture();
    vi.stubEnv('ONTOINDEX_WORKSPACE_MAX_FILES', '1600');
    f.dependencies.baseFileCount.mockResolvedValue(1600);
    expect(await prepareWorkspaceRead(f.options)).toBe(f.ready);
    expect(f.dependencies.acquireLock).toHaveBeenCalledOnce();
    expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('reuses a matching complete workspace graph above the admission limit without rebuilding', async () => {
    const f = fixture();
    f.dependencies.getSnapshot.mockReset().mockResolvedValue(f.ready);
    f.dependencies.baseFileCount.mockResolvedValue(7001);
    expect(await prepareWorkspaceRead(f.options)).toBe(f.ready);
    expect(f.dependencies.baseFileCount).not.toHaveBeenCalled();
    expect(f.dependencies.acquireLock).not.toHaveBeenCalled();
    expect(f.dependencies.buildWorkspaceGraph).not.toHaveBeenCalled();
  });
  it('refuses a build for a repository above the file limit without taking the lock', async () => {
    const f = fixture();
    f.dependencies.baseFileCount.mockResolvedValue(5000);
    f.dependencies.getSnapshot.mockResolvedValue(f.dirty);
    await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({
      code: 'workspace_too_large',
      diagnostics: {
        observedIndexedFiles: 5000,
        maxIndexedFiles: 1600,
        requiredCapability: 'workspace-graph',
      },
    });
    expect(f.dependencies.acquireLock).not.toHaveBeenCalled();
    expect(f.dependencies.buildWorkspaceGraph).not.toHaveBeenCalled();
    vi.stubEnv('ONTOINDEX_WORKSPACE_MAX_FILES', '9000');
    f.dependencies.getSnapshot
      .mockReset()
      .mockResolvedValueOnce(f.dirty)
      .mockResolvedValueOnce(f.dirty)
      .mockResolvedValue(f.ready);
    await prepareWorkspaceRead(f.options);
    expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledOnce();
  });
  describe('reads that need no relationships', () => {
    const manyDirty = (f: ReturnType<typeof fixture>) => {
      f.dirty.dirtyPaths = new Set(Array.from({ length: 60 }, (_, i) => `f${i}.ts`));
      f.options.needsRelationships = false;
      f.dependencies.getSnapshot.mockResolvedValue(f.dirty);
    };
    it.each([
      ['too large', 'workspace_too_large'],
      ['busy', 'workspace_busy'],
      ['build failure', 'workspace_build_failed'],
    ])('rejects when the required build is refused: %s', async (kind, code) => {
      const f = fixture();
      manyDirty(f);
      if (kind === 'too large') f.dependencies.baseFileCount.mockResolvedValue(9000);
      if (kind === 'busy')
        f.dependencies.acquireLock.mockRejectedValue(
          new Error('OntoIndex analyze is already running'),
        );
      if (kind === 'build failure')
        f.dependencies.buildWorkspaceGraph.mockRejectedValue(new Error('boom'));
      await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({ code });
    });
    it('rejects a refused build instead of returning a stale symbols overlay', async () => {
      const f = fixture();
      manyDirty(f);
      // 60 dirty files force a workspace build even though a symbols overlay is usable.
      f.dependencies.getSnapshot.mockReset();
      f.dependencies.getSnapshot.mockResolvedValue({
        ...f.ready,
        dirtyPaths: f.dirty.dirtyPaths,
        capability: 'symbols',
        generation: 'old-generation',
        reason: 'overlay was built on base a/1 but the active base is b/2; rebuild',
      });
      f.dependencies.baseFileCount.mockResolvedValue(9000);
      await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({
        code: 'workspace_too_large',
      });
      expect(f.dependencies.baseFileCount).toHaveBeenCalled();
    });
    it.each([
      ['search', false],
      ['relationship read', true],
    ])('rejects a %s whose build outlasts the deadline', async (_name, needsRelationships) => {
      const f = fixture();
      manyDirty(f);
      f.options.needsRelationships = needsRelationships;
      let finish!: () => void;
      f.dependencies.buildWorkspaceGraph.mockImplementation(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      const deadline = performance.now() + 50;
      const pending = prepareWorkspaceRead({ ...f.options, deadline });
      await expect(pending).rejects.toMatchObject({ code: 'workspace_timeout' });
      finish();
    });
    it('waits until the sixty-second preparation cap and then rejects', async () => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        manyDirty(f);
        f.options.needsRelationships = true;
        let finish!: () => void;
        f.dependencies.buildWorkspaceGraph.mockImplementation(
          () => new Promise<void>((resolve) => (finish = resolve)),
        );
        let outcome = 'pending';
        const pending = prepareWorkspaceRead(f.options).then(
          () => (outcome = 'resolved'),
          (error: { code?: string }) => (outcome = error.code ?? 'rejected'),
        );
        expect(WORKSPACE_PREPARATION_DEADLINE_MS).toBe(60_000);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(outcome).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(outcome).toBe('workspace_timeout');
        finish();
      } finally {
        vi.useRealTimers();
      }
    });
    it('lets the next request join a build that outlasted the previous waiter', async () => {
      const f = fixture();
      manyDirty(f);
      let finish!: () => void;
      f.dependencies.buildWorkspaceGraph.mockImplementation(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      await expect(
        prepareWorkspaceRead({ ...f.options, deadline: performance.now() + 30 }),
      ).rejects.toMatchObject({ code: 'workspace_timeout' });
      const second = prepareWorkspaceRead(f.options);
      await vi.waitFor(() => expect(f.dependencies.getSnapshot).toHaveBeenCalledTimes(3));
      f.dependencies.getSnapshot.mockResolvedValue(f.ready);
      finish();
      expect((await second).usable).toBe(true);
      expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledOnce();
      expect(f.dependencies.acquireLock).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
    });
    it('still throws for a read that needs relationships', async () => {
      const f = fixture();
      manyDirty(f);
      f.options.needsRelationships = true;
      f.dependencies.baseFileCount.mockResolvedValue(9000);
      await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({
        code: 'workspace_too_large',
      });
    });
    it('rejects a cancelled read', async () => {
      const f = fixture();
      manyDirty(f);
      const controller = new AbortController();
      controller.abort();
      await expect(
        prepareWorkspaceRead({ ...f.options, signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'workspace_cancelled' });
    });
  });
  it('does not rebuild an unchanged failed snapshot until the cooldown expires', async () => {
    const f = fixture();
    f.dependencies.buildWorkspaceGraph.mockRejectedValueOnce(new Error('broken'));
    f.dependencies.getSnapshot.mockResolvedValue(f.dirty);
    await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({
      code: 'workspace_build_failed',
    });
    await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({
      code: 'workspace_build_failed',
      message: 'Working-tree graph build failed.',
    });
    expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledTimes(1);
    f.dependencies.now.mockReturnValue(31_000);
    f.dependencies.getSnapshot
      .mockResolvedValueOnce(f.dirty)
      .mockResolvedValueOnce(f.dirty)
      .mockResolvedValue(f.ready);
    await prepareWorkspaceRead(f.options);
    expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledTimes(2);
  });
  it('releases a failed build and retries on the next request', async () => {
    const f = fixture();
    f.dependencies.buildWorkspaceGraph.mockRejectedValueOnce(new Error('broken'));
    f.dependencies.getSnapshot.mockResolvedValue(f.dirty);
    await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({
      code: 'workspace_build_failed',
    });
    expect(f.release).toHaveBeenCalledOnce();
    f.dependencies.now.mockReturnValue(31_000);
    f.dependencies.getSnapshot
      .mockResolvedValueOnce(f.dirty)
      .mockResolvedValueOnce(f.dirty)
      .mockResolvedValue(f.ready);
    await prepareWorkspaceRead(f.options);
    expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledTimes(2);
  });
  it('drains lifecycle cancellation and suppresses its queued successor', async () => {
    const f = fixture();
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-stop-'));
    f.options.repo.storagePath = storagePath;
    let ownerSignal!: AbortSignal;
    let finish!: () => void;
    f.dependencies.getSnapshot.mockResolvedValue(f.dirty);
    f.dependencies.buildWorkspaceGraph.mockImplementationOnce((_repo, signal) => {
      ownerSignal = signal!;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    try {
      const first = prepareWorkspaceRead(f.options);
      const firstRejected = expect(first).rejects.toMatchObject({ code: 'workspace_cancelled' });
      await vi.waitFor(() => expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledOnce());
      f.dependencies.getSnapshot.mockResolvedValue({ ...f.dirty, generation: 'successor' });
      const next = prepareWorkspaceRead(f.options);
      const nextRejected = expect(next).rejects.toMatchObject({ code: 'workspace_cancelled' });
      await vi.waitFor(() => expect(f.dependencies.getSnapshot).toHaveBeenCalledTimes(3));
      let stopped = false;
      const stop = stopWorkspaceBuild(f.options.repo).then(() => {
        stopped = true;
      });
      expect(ownerSignal.aborted).toBe(true);
      await nextRejected;
      expect(stopped).toBe(false);
      finish();
      await firstRejected;
      await stop;
      expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });
  it.each(['timeout', 'cancelled'])(
    'bounds one waiter with %s without stopping another',
    async (code) => {
      const f = fixture();
      const controller = new AbortController();
      let finish!: () => void;
      f.dependencies.getSnapshot.mockResolvedValue(f.dirty);
      f.dependencies.buildWorkspaceGraph.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const first = prepareWorkspaceRead({
        ...f.options,
        signal: controller.signal,
        deadline: performance.now() + (code === 'timeout' ? 40 : 1000),
      });
      const rejected = expect(first).rejects.toMatchObject({ code: `workspace_${code}` });
      const second = prepareWorkspaceRead(f.options);
      await vi.waitFor(() => expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledOnce());
      const ownerSignal = f.dependencies.buildWorkspaceGraph.mock.calls[0][1];
      expect(ownerSignal).not.toBe(controller.signal);
      if (code === 'cancelled') controller.abort();
      expect(ownerSignal?.aborted).toBe(false);
      await rejected;
      f.dependencies.getSnapshot.mockResolvedValue(f.ready);
      finish();
      expect(await second).toBe(f.ready);
      expect(f.dependencies.buildWorkspaceGraph).toHaveBeenCalledOnce();
    },
  );
  it('rejects an unusable snapshot after building', async () => {
    const f = fixture();
    f.dependencies.getSnapshot.mockResolvedValue(f.dirty);
    await expect(prepareWorkspaceRead(f.options)).rejects.toMatchObject({
      code: 'workspace_build_failed',
    });
  });
});

describe('generation reopen retry', () => {
  it.each(['close', 'init'])(
    'keeps committed metadata after failed %s and retries',
    async (failure) => {
      const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-retry-'));
      const handle = makeRepo('retry', 'retry', storagePath);
      handle.storagePath = storagePath;
      handle.lbugPath = '/gen/A/lbug';
      const originalIndexedAt = handle.indexedAt;
      const initializedRepos = new Set([handle.id]);
      const closeLbug = vi.fn(async () => {});
      const initLbug = vi.fn(async () => {});
      (failure === 'close' ? closeLbug : initLbug).mockRejectedValueOnce(
        new Error('temporary failure'),
      );
      const options = {
        repoId: handle.id,
        handle,
        initializedRepos,
        reinitPromises: new Map<string, Promise<void>>(),
        lastStalenessCheck: new Map<string, number>(),
        isLbugReady: () => initializedRepos.has(handle.id),
        closeLbug,
        initLbug,
        resolveActiveLbugPath: vi.fn(async () => '/gen/B/lbug'),
        now: () => 5000,
      };
      try {
        await fs.writeFile(
          path.join(storagePath, 'meta.json'),
          JSON.stringify({ indexedAt: 'new' }),
        );
        await expect(ensureRepoInitialized(options)).rejects.toThrow('temporary failure');
        expect(handle.lbugPath).toBe('/gen/A/lbug');
        expect(handle.indexedAt).toBe(originalIndexedAt);
        await ensureRepoInitialized(options);
        expect(initLbug).toHaveBeenLastCalledWith(handle.id, '/gen/B/lbug');
        expect(handle.lbugPath).toBe('/gen/B/lbug');
        expect(handle.indexedAt).toBe('new');
        expect(initializedRepos.has(handle.id)).toBe(true);
      } finally {
        await fs.rm(storagePath, { recursive: true, force: true });
      }
    },
  );
});

function makeRepo(id: string, name: string, repoPath: string): RepoHandle {
  const resolvedRepoPath = path.resolve(repoPath);
  return {
    id,
    name,
    repoPath: resolvedRepoPath,
    storagePath: `${resolvedRepoPath}/.ontoindex`,
    lbugPath: `${resolvedRepoPath}/.ontoindex/lbug.db`,
    indexedAt: '2026-06-13T00:00:00.000Z',
    lastCommit: 'abc123',
  };
}

describe('resolveRepoFromHandles', () => {
  it('defaults to the preferred project path when multiple repos are indexed', () => {
    const repos = new Map<string, RepoHandle>([
      ['ontoindex', makeRepo('ontoindex', 'OntoIndex', '/opt/demodb/_workfolder/OntoIndex')],
      ['codex', makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode')],
    ]);

    const result = resolveRepoFromHandles(repos, undefined, '/opt/demodb/_workfolder/ontocode');

    expect(result).toEqual({ kind: 'resolved', repo: repos.get('codex') });
  });

  it('prefers an explicit repo parameter over the preferred project path', () => {
    const repos = new Map<string, RepoHandle>([
      ['ontoindex', makeRepo('ontoindex', 'OntoIndex', '/opt/demodb/_workfolder/OntoIndex')],
      ['codex', makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode')],
    ]);

    const result = resolveRepoFromHandles(repos, 'ontoindex', '/opt/demodb/_workfolder/ontocode');

    expect(result).toEqual({ kind: 'resolved', repo: repos.get('ontoindex') });
  });

  it('still returns null when multiple repos are indexed and no default matches', () => {
    const repos = new Map<string, RepoHandle>([
      ['ontoindex', makeRepo('ontoindex', 'OntoIndex', '/opt/demodb/_workfolder/OntoIndex')],
      ['codex', makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode')],
    ]);

    const result = resolveRepoFromHandles(
      repos,
      undefined,
      '/opt/demodb/_workfolder/unindexed-project',
    );

    expect(result.kind).toBe('ambiguous');
  });

  it('uses the preferred project path to disambiguate duplicate labels', () => {
    const active = makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode');
    const stale = makeRepo('codex-b3B0L2', 'codex', '/opt/demodb/_workfolder/ontocode-f1-layout');
    const repos = new Map<string, RepoHandle>([
      [active.id, active],
      [stale.id, stale],
    ]);

    expect(resolveRepoFromHandles(repos, 'codex', active.repoPath)).toEqual({
      kind: 'resolved',
      repo: active,
    });
  });

  it('prefers the longest containing repository path', () => {
    const parent = makeRepo('workspace', 'shared', '/opt/workspace');
    const child = makeRepo('project', 'shared', '/opt/workspace/project');
    const repos = new Map<string, RepoHandle>([
      [parent.id, parent],
      [child.id, child],
    ]);

    expect(resolveRepoFromHandles(repos, 'shared', '/opt/workspace/project/src')).toEqual({
      kind: 'resolved',
      repo: child,
    });
    expect(resolveRepoFromHandles(repos, undefined, '/opt/workspace/project/src')).toEqual({
      kind: 'resolved',
      repo: child,
    });
  });

  it('reports duplicate labels as ambiguous without a matching preferred path', () => {
    const first = makeRepo('first', 'shared', '/opt/first');
    const second = makeRepo('second', 'shared', '/opt/second');
    const repos = new Map<string, RepoHandle>([
      [first.id, first],
      [second.id, second],
    ]);

    expect(resolveRepoFromHandles(repos, 'shared', '/opt/unrelated')).toEqual({
      kind: 'ambiguous',
      candidates: [first, second],
    });
  });

  it('reports partial labels as ambiguous unless only one matches', () => {
    const first = makeRepo('first', 'shared-api', '/opt/first');
    const second = makeRepo('second', 'shared-web', '/opt/second');
    const repos = new Map<string, RepoHandle>([
      [first.id, first],
      [second.id, second],
    ]);

    expect(resolveRepoFromHandles(repos, 'shared')).toEqual({
      kind: 'ambiguous',
      candidates: [first, second],
    });
    expect(resolveRepoFromHandles(repos, 'api')).toEqual({ kind: 'resolved', repo: first });
  });

  it('matches an exact repository path through a symlink', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-resolve-'));
    const repoPath = path.join(tempRoot, 'repo');
    const symlinkPath = path.join(tempRoot, 'repo-link');
    await fs.mkdir(repoPath);
    await fs.symlink(repoPath, symlinkPath, 'dir');
    const repo = makeRepo('repo', 'repo', repoPath);

    try {
      expect(resolveRepoFromHandles(new Map([[repo.id, repo]]), symlinkPath)).toEqual({
        kind: 'resolved',
        repo,
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('ensureRepoInitialized', () => {
  it('adopts the commit of a newly published generation when it reopens the index', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-republish-'));
    const storagePath = path.join(repoPath, '.ontoindex');
    await fs.mkdir(storagePath);
    const handle = makeRepo('repo', 'repo', repoPath);
    const initLbug = vi.fn(async () => undefined);
    try {
      await fs.writeFile(
        path.join(storagePath, 'meta.json'),
        JSON.stringify({ indexedAt: '2026-09-27T06:44:54.355Z', lastCommit: 'def456' }),
      );
      await ensureRepoInitialized({
        repoId: 'repo',
        handle,
        initializedRepos: new Set(['repo']),
        reinitPromises: new Map(),
        lastStalenessCheck: new Map(),
        isLbugReady: () => true,
        initLbug,
        closeLbug: vi.fn(async () => undefined),
        resolveActiveLbugPath: vi.fn(async () => '/gen/B/lbug'),
      });
      expect(initLbug).toHaveBeenCalledOnce();
      expect(handle.indexedAt).toBe('2026-09-27T06:44:54.355Z');
      expect(handle.lastCommit).toBe('def456');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'unchanged timestamp',
      indexedAt: '2026-06-13T00:00:00.000Z',
      activePath: '/gen/B/lbug',
      reopens: true,
    },
    {
      label: 'changed timestamp',
      indexedAt: '2026-06-14T00:00:00.000Z',
      activePath: '/gen/B/lbug',
      reopens: true,
    },
    {
      label: 'legacy layout with unchanged timestamp',
      indexedAt: '2026-06-13T00:00:00.000Z',
      activePath: null,
      reopens: false,
    },
    {
      label: 'legacy layout with changed timestamp',
      indexedAt: '2026-06-14T00:00:00.000Z',
      activePath: null,
      reopens: true,
    },
    { label: 'missing metadata', indexedAt: null, activePath: '/gen/B/lbug', reopens: true },
  ])('uses the active generation for $label', async ({ indexedAt, activePath, reopens }) => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-reinit-'));
    const handle = makeRepo('repo', 'repo', storagePath);
    handle.storagePath = storagePath;
    handle.lbugPath = '/gen/A/lbug';
    const originalIndexedAt = handle.indexedAt;
    const calls: string[] = [];
    const closeLbug = vi.fn(async () => {
      calls.push('close');
    });
    const initLbug = vi.fn(async () => {
      calls.push('init');
    });
    const initializedRepos = new Set([handle.id]);
    const reinitPromises = new Map<string, Promise<void>>();
    const resolveActiveLbugPath = vi.fn(async () => activePath);

    try {
      if (indexedAt)
        await fs.writeFile(path.join(storagePath, 'meta.json'), JSON.stringify({ indexedAt }));
      await ensureRepoInitialized({
        repoId: handle.id,
        handle,
        initializedRepos,
        reinitPromises,
        lastStalenessCheck: new Map(),
        isLbugReady: () => true,
        initLbug,
        closeLbug,
        resolveActiveLbugPath,
        now: () => 5000,
      });

      expect(resolveActiveLbugPath).toHaveBeenCalledWith(storagePath);
      expect(calls).toEqual(reopens ? ['close', 'init'] : []);
      if (reopens) expect(initLbug).toHaveBeenCalledWith(handle.id, activePath ?? '/gen/A/lbug');
      expect(handle.lbugPath).toBe(activePath ?? '/gen/A/lbug');
      expect(handle.indexedAt).toBe(indexedAt ?? originalIndexedAt);
      expect(initializedRepos.has(handle.id)).toBe(true);
      expect(reinitPromises.size).toBe(0);
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });
});

describe('repository preparation coalescing', () => {
  function fixture() {
    const handle = makeRepo('coalesce', 'coalesce', '/missing/coalesce');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initLbug = vi.fn(async () => {
      await gate;
    });
    const options = {
      repoId: handle.id,
      handle,
      initializedRepos: new Set<string>(),
      reinitPromises: new Map<string, Promise<void>>(),
      lastStalenessCheck: new Map<string, number>(),
      isLbugReady: () => false,
      initLbug,
      closeLbug: vi.fn(async () => {}),
      resolveActiveLbugPath: vi.fn(async () => null),
    };
    return { options, initLbug, release };
  }

  it('cancels one waiter without cancelling shared preparation', async () => {
    const { options, initLbug, release } = fixture();
    const controller = new AbortController();
    const first = ensureRepoInitialized({ ...options, signal: controller.signal });
    const second = ensureRepoInitialized(options);
    const rejected = expect(first).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await rejected;
    release();
    await second;
    expect(initLbug).toHaveBeenCalledOnce();
  });

  it('times out one waiter while another still resolves', async () => {
    vi.useFakeTimers();
    try {
      const { options, initLbug, release } = fixture();
      const first = ensureRepoInitialized({ ...options, deadline: performance.now() + 10 });
      const second = ensureRepoInitialized(options);
      const rejected = expect(first).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      release();
      await second;
      expect(initLbug).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the waiter deadline at sixty seconds and observes late failure', async () => {
    vi.useFakeTimers();
    try {
      const { options, initLbug, release } = fixture();
      initLbug.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 60_001));
        throw new Error('late failure');
      });
      const waiter = ensureRepoInitialized({ ...options, deadline: performance.now() + 120_000 });
      const rejected = expect(waiter).rejects.toBeInstanceOf(RepoPreparationWaitError);
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      // Flush native filesystem preparation before advancing its delayed initializer.
      await vi.waitFor(() => expect(initLbug).toHaveBeenCalledOnce());
      await vi.runAllTimersAsync();
      release();
      // The late shared rejection is observed even though no waiter remains.
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes abort listeners after preparation settles', async () => {
    const { options, release } = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const waiter = ensureRepoInitialized({ ...options, signal: controller.signal });
    release();
    await waiter;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('fails a queued successor once and permits a fresh retry', async () => {
    const { options, initLbug } = fixture();
    initLbug.mockImplementation(async () => {
      throw new Error('failed');
    });
    const first = ensureRepoInitialized(options);
    const successor = ensureRepoInitialized({
      ...options,
      handle: { ...options.handle, indexedAt: 'next' },
    });
    await Promise.all([
      expect(first).rejects.toThrow('failed'),
      expect(successor).rejects.toThrow('failed'),
    ]);
    expect(initLbug).toHaveBeenCalledTimes(2);
    initLbug.mockResolvedValue(undefined);
    await ensureRepoInitialized(options);
    expect(initLbug).toHaveBeenCalledTimes(3);
  });

  it('shares concurrent preparation for the same snapshot and starts fresh after settling', async () => {
    const { options, initLbug, release } = fixture();
    const first = ensureRepoInitialized(options);
    const second = ensureRepoInitialized(options);
    expect(first).not.toBe(second);
    await vi.waitFor(() => expect(initLbug).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    await ensureRepoInitialized(options);
    expect(initLbug).toHaveBeenCalledTimes(2);
  });

  it('collapses changed snapshots into one latest successor', async () => {
    const { options, initLbug, release } = fixture();
    const first = ensureRepoInitialized(options);
    await vi.waitFor(() => expect(initLbug).toHaveBeenCalledTimes(1));
    const second = ensureRepoInitialized({
      ...options,
      handle: { ...options.handle, lbugPath: '/gen/B/lbug' },
    });
    const third = ensureRepoInitialized({
      ...options,
      handle: { ...options.handle, lbugPath: '/gen/C/lbug' },
    });
    expect(second).not.toBe(third);
    expect(initLbug).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, third]);
    expect(initLbug).toHaveBeenCalledTimes(2);
    expect(initLbug).toHaveBeenLastCalledWith(options.repoId, '/gen/C/lbug');
  });

  it('clears failed preparation so the next call retries', async () => {
    const { options, initLbug, release } = fixture();
    initLbug.mockRejectedValueOnce(new Error('preparation failed'));
    await expect(ensureRepoInitialized(options)).rejects.toThrow('preparation failed');
    release();
    await ensureRepoInitialized(options);
    expect(initLbug).toHaveBeenCalledTimes(2);
  });
});
