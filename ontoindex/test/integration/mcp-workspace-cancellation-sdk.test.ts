import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as analysis from '../../src/core/run-analyze.js';
import * as runtime from '../../src/mcp/local/local-backend-repo-runtime.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { resetOverlaySnapshotCache } from '../../src/mcp/local/backend-overlay.js';
import { createMCPServer } from '../../src/mcp/server.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe('workspace cancellation over the real MCP SDK', () => {
  const repoName = 'workspace-cancellation-sdk';
  let root: string;
  let repo: string;
  let backend: LocalBackend;
  let client: Client;
  let server: ReturnType<typeof createMCPServer>;
  // This existing method is reached only after production preparation and pin acquisition.
  type QueryBackend = { query(...args: unknown[]): Promise<unknown> };
  const call = (signal?: AbortSignal) =>
    client.callTool(
      {
        name: 'query',
        arguments: { repo: repoName, query: 'workspaceOnlySymbol' },
      },
      undefined,
      { signal },
    );

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-cancellation-sdk-'));
    repo = path.join(root, repoName);
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    vi.stubEnv('ONTOINDEX_VECTOR_BACKEND', 'lbug');
    vi.stubEnv('ONTOINDEX_MCP_AUTO_ANALYZE', '0');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
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
    git('commit', '-qm', 'workspace cancellation baseline');
    await analysis.runFullAnalysis(
      repo,
      {
        skipNativeClose: true,
        skipAgentsMd: true,
        noStats: true,
        registryName: repoName,
        embeddings: false,
      },
      { onProgress() {} },
    );
    await fs.writeFile(
      path.join(repo, 'src/fresh.ts'),
      'export function workspaceOnlySymbol() { return 2; }\n',
    );
    resetOverlaySnapshotCache();
    backend = new LocalBackend();
    await backend.init();
    server = createMCPServer(backend, { full: true });
    client = new Client({ name: repoName, version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 240_000);

  afterAll(async () => {
    try {
      await client?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        try {
          await backend?.disconnect();
        } finally {
          vi.restoreAllMocks();
          resetOverlaySnapshotCache();
          runtime.resetWorkspaceBuildFailures();
          vi.unstubAllEnvs();
          if (root) await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  });

  it('cancels one SDK preparation waiter while its survivor completes the shared native build', async () => {
    const buildEntered = deferred();
    const releaseBuild = deferred();
    const bothPreparing = deferred();
    const cancelledPreparation = deferred<unknown>();
    const runAnalysis = analysis.runFullAnalysis;
    const prepare = runtime.prepareWorkspaceRead;
    const queryBackend = backend as unknown as QueryBackend;
    const query = queryBackend.query.bind(backend);
    const handlerEntries: unknown[][] = [];
    let preparationCount = 0;
    let workspaceBuildCount = 0;
    const buildSpy = vi.spyOn(analysis, 'runFullAnalysis').mockImplementation(async (...args) => {
      if (args[1]?.workspaceGraph) {
        workspaceBuildCount++;
        buildEntered.resolve();
        await releaseBuild.promise;
      }
      return runAnalysis(...args);
    });
    const preparationSpy = vi
      .spyOn(runtime, 'prepareWorkspaceRead')
      .mockImplementation(async (options) => {
        preparationCount++;
        const pending = prepare(options);
        if (preparationCount === 2) bothPreparing.resolve();
        try {
          return await pending;
        } catch (error) {
          if (options.signal?.aborted) cancelledPreparation.resolve(error);
          throw error;
        }
      });
    const handlerSpy = vi.spyOn(queryBackend, 'query').mockImplementation(async (...args) => {
      handlerEntries.push(args);
      return query(...args);
    });
    const controller = new AbortController();
    const cancelled = call(controller.signal).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let survivor: ReturnType<typeof call> | undefined;
    try {
      await buildEntered.promise;
      survivor = call();
      await bothPreparing.promise;
      controller.abort();
      expect(await cancelled).toHaveProperty('error');
      // SDK rejection alone is insufficient: wait for the server's preparation waiter to exit.
      expect(await cancelledPreparation.promise).toMatchObject({ code: 'workspace_cancelled' });
      expect(handlerEntries).toEqual([]);
      expect(workspaceBuildCount).toBe(1);
      releaseBuild.resolve();
      const result = await survivor;
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
      const payload = JSON.parse(text.split('\n\n---\n')[0]) as {
        definitions?: Array<{ name: string; filePath: string }>;
      };
      expect(payload.definitions).toContainEqual(
        expect.objectContaining({
          name: 'workspaceOnlySymbol',
          filePath: 'src/fresh.ts',
        }),
      );
      expect(handlerEntries).toHaveLength(1);
      expect(workspaceBuildCount).toBe(1);
    } finally {
      controller.abort();
      releaseBuild.resolve();
      await Promise.allSettled([cancelled, ...(survivor ? [survivor] : [])]);
      handlerSpy.mockRestore();
      preparationSpy.mockRestore();
      buildSpy.mockRestore();
    }
  }, 240_000);

  it('keeps the real generation reader marker and shutdown pending after SDK abort until the actual handler settles', async () => {
    const handlerEntered = deferred();
    const releaseHandler = deferred();
    const serverAborted = deferred();
    const operationSettled = deferred();
    const queryBackend = backend as unknown as QueryBackend;
    const query = queryBackend.query.bind(backend);
    const withOperation = backend.withOperation.bind(backend);
    const operationSpy = vi.spyOn(backend, 'withOperation').mockImplementation((fn, options) => {
      const pending = withOperation(fn, options);
      if (options?.signal) {
        options.signal.addEventListener('abort', () => serverAborted.resolve(), { once: true });
        void pending.then(
          () => operationSettled.resolve(),
          () => operationSettled.resolve(),
        );
      }
      return pending;
    });
    const handlerSpy = vi.spyOn(queryBackend, 'query').mockImplementation(async (...args) => {
      handlerEntered.resolve();
      await releaseHandler.promise;
      return query(...args);
    });
    const controller = new AbortController();
    const cancelled = call(controller.signal).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let disconnect: Promise<void> | undefined;
    let disconnected = false;
    try {
      await handlerEntered.promise;
      const overlayRoot = path.join(repo, '.ontoindex', 'overlay');
      const generation = (await fs.readFile(path.join(overlayRoot, 'CURRENT'), 'utf8')).trim();
      const generationDir = path.join(overlayRoot, generation);
      const readers = async () =>
        (await fs.readdir(generationDir)).filter((name) => name.startsWith('.reader-')).sort();
      const pinnedMarkers = await readers();
      expect(pinnedMarkers).toHaveLength(1);
      controller.abort();
      expect(await cancelled).toHaveProperty('error');
      await serverAborted.promise;
      disconnect = backend.disconnect().then(() => {
        disconnected = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disconnected).toBe(false);
      expect(await readers()).toEqual(pinnedMarkers);
      releaseHandler.resolve();
      // Wait for the production request operation, including withPinnedOverlay's finally.
      await operationSettled.promise;
      await disconnect;
      expect(disconnected).toBe(true);
      expect(await readers()).toEqual([]);
      expect(handlerSpy).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      releaseHandler.resolve();
      await cancelled;
      await operationSettled.promise;
      await disconnect;
      handlerSpy.mockRestore();
      operationSpy.mockRestore();
    }
  }, 240_000);
});
