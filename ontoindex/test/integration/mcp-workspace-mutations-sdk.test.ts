import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as analysis from '../../src/core/run-analyze.js';
import * as supervisor from '../../src/mcp/local/workspace-build-supervisor.js';
import * as runtime from '../../src/mcp/local/local-backend-repo-runtime.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { resetOverlaySnapshotCache } from '../../src/mcp/local/backend-overlay.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { resetFreshnessCache } from '../../src/mcp/super/ensure-fresh.js';

interface Edge {
  uid: string;
  name: string;
  filePath: string;
  kind: string;
}

interface Context {
  status: string;
  source?: string;
  symbol: Edge;
  incoming: { calls?: Edge[] };
  outgoing: { calls?: Edge[] };
}

describe('workspace mutations over the real MCP SDK', () => {
  const repoName = 'workspace-mutations-sdk';
  let root: string;
  let repo: string;
  let backend: LocalBackend;
  let client: Client;
  let server: ReturnType<typeof createMCPServer>;
  let inProcessBuilds = 0;
  let supervisedBuilds = 0;
  const builds = () => inProcessBuilds + supervisedBuilds;
  const git = (directory: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-C',
        directory,
        ...args,
      ],
      { stdio: 'pipe' },
    );
  const write = (file: string, content: string) => fs.writeFile(path.join(repo, file), content);

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const response = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 180_000,
    });
    const text = (response.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    expect(response.isError, text).not.toBe(true);
    return JSON.parse(text.split('\n\n---\n')[0]) as T;
  }

  const context = (target: string, name = repoName) =>
    call<Context>('inspect', {
      action: 'context',
      repo: name,
      target,
    });
  const search = (query: string) =>
    call<{ definitions?: Edge[] }>('search', {
      action: 'semantic',
      repo: repoName,
      query,
    });

  async function activeOverlay() {
    const handle = await backend.resolveRepo(repoName);
    const overlayRoot = path.join(handle.storagePath, 'overlay');
    const generation = (await fs.readFile(path.join(overlayRoot, 'CURRENT'), 'utf8')).trim();
    const base = JSON.parse(
      await fs.readFile(path.join(overlayRoot, generation, 'base.json'), 'utf8'),
    );
    return { generation, base };
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-mutations-sdk-'));
    repo = path.join(root, repoName);
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    vi.stubEnv('ONTOINDEX_VECTOR_BACKEND', 'lbug');
    vi.stubEnv('ONTOINDEX_MCP_AUTO_ANALYZE', '0');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await write('.gitignore', '.ontoindex/\n');
    await write('tsconfig.json', '{"compilerOptions":{"module":"commonjs","target":"es2022"}}\n');
    await write(
      'src/callee.ts',
      'export function callee() { return 1; }\nexport function alternate() { return 2; }\n',
    );
    await write(
      'src/caller.ts',
      "import { callee } from './callee';\nexport function caller() { return callee(); }\n",
    );
    await write('src/deleted.ts', 'export function deletedSymbol() { return 0; }\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'workspace mutations baseline');
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
    resetFreshnessCache();
    resetOverlaySnapshotCache();
    runtime.resetWorkspaceBuildFailures();
    const runAnalysis = analysis.runFullAnalysis;
    vi.spyOn(analysis, 'runFullAnalysis').mockImplementation(async (...args) => {
      if (args[1]?.workspaceGraph) inProcessBuilds++;
      return runAnalysis(...args);
    });
    const supervise = supervisor.superviseWorkspaceBuild;
    vi.spyOn(supervisor, 'superviseWorkspaceBuild').mockImplementation(async (...args) => {
      supervisedBuilds++;
      return supervise(...args);
    });
    backend = new LocalBackend();
    await backend.init();
    server = createMCPServer(backend);
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
          resetFreshnessCache();
          resetOverlaySnapshotCache();
          runtime.resetWorkspaceBuildFailures();
          vi.unstubAllEnvs();
          if (root) await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  });

  it('invalidates each edit, reuses unchanged generations, and matches an independent full analysis', async () => {
    const clean = await context('callee');
    expect(clean.status).toBe('found');
    expect(clean.source).not.toBe('workspace-graph');
    expect(clean.incoming.calls).toContainEqual(expect.objectContaining({ name: 'caller' }));
    expect(builds()).toBe(0);
    let generation: string | undefined;
    let expectedBuilds = 0;
    async function rebuilt(target: string, filePath: string) {
      const result = await context(target);
      expect(result).toMatchObject({
        status: 'found',
        source: 'workspace-graph',
        symbol: { name: target, filePath },
      });
      const active = await activeOverlay();
      expect(active.generation).not.toBe(generation);
      generation = active.generation;
      expect(builds()).toBe(++expectedBuilds);
      return result;
    }

    await write(
      'src/callee.ts',
      'export function callee() { return 10; }\nexport function alternate() { return 2; }\n' +
        'export function modifiedExport() { return 3; }\n',
    );
    // Search must admit the workspace before any context request warms it.
    expect((await search('modifiedExport')).definitions).toContainEqual(
      expect.objectContaining({
        name: 'modifiedExport',
        filePath: 'src/callee.ts',
      }),
    );
    expect(builds()).toBe(1);
    await rebuilt('modifiedExport', 'src/callee.ts');
    await context('modifiedExport');
    expect((await activeOverlay()).generation).toBe(generation);
    expect(builds()).toBe(expectedBuilds);

    await write(
      'src/added.ts',
      "import { callee } from './callee';\nexport function addedCaller() { return callee(); }\n",
    );
    await rebuilt('addedCaller', 'src/added.ts');
    expect((await context('callee')).incoming.calls).toContainEqual(
      expect.objectContaining({ name: 'addedCaller' }),
    );

    await fs.unlink(path.join(repo, 'src/deleted.ts'));
    await rebuilt('callee', 'src/callee.ts');
    expect((await search('deletedSymbol')).definitions ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'deletedSymbol' }),
    );
    expect((await activeOverlay()).base.tombstones).toContain('src/deleted.ts');

    await fs.rename(path.join(repo, 'src/added.ts'), path.join(repo, 'src/renamed.ts'));
    await rebuilt('addedCaller', 'src/renamed.ts');
    const renamed = (await search('addedCaller')).definitions ?? [];
    expect(renamed).toContainEqual(
      expect.objectContaining({ name: 'addedCaller', filePath: 'src/renamed.ts' }),
    );
    expect(renamed.some((entry) => entry.filePath === 'src/added.ts')).toBe(false);

    await write(
      'src/caller.ts',
      "import { alternate } from './callee';\nexport function caller() { return alternate(); }\n",
    );
    const changedCaller = await rebuilt('caller', 'src/caller.ts');
    expect(changedCaller.outgoing.calls).toContainEqual(
      expect.objectContaining({ name: 'alternate' }),
    );
    expect(changedCaller.outgoing.calls ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'callee' }),
    );
    expect((await context('callee')).incoming.calls ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'caller' }),
    );
    expect((await context('alternate')).incoming.calls).toContainEqual(
      expect.objectContaining({ name: 'caller' }),
    );

    // Resolver inputs participate in identity even when their semantics do not change.
    await fs.appendFile(path.join(repo, 'tsconfig.json'), ' \n');
    await rebuilt('caller', 'src/caller.ts');
    await context('caller');
    expect((await activeOverlay()).generation).toBe(generation);
    expect(builds()).toBe(expectedBuilds);

    await fs.appendFile(
      path.join(repo, 'src/callee.ts'),
      'export function secondEdit() { return 4; }\n',
    );
    await rebuilt('secondEdit', 'src/callee.ts');

    const referenceName = 'workspace-mutations-reference-sdk';
    const reference = path.join(root, referenceName);
    await fs.mkdir(path.join(reference, 'src'), { recursive: true });
    const files = [
      '.gitignore',
      'tsconfig.json',
      ...(await fs.readdir(path.join(repo, 'src'))).sort().map((file) => `src/${file}`),
    ];
    for (const file of files) {
      const bytes = await fs.readFile(path.join(repo, file));
      await fs.writeFile(path.join(reference, file), bytes);
      const copied = await fs.readFile(path.join(reference, file));
      expect(createHash('sha256').update(copied).digest('hex')).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(copied).toEqual(bytes);
    }
    git(reference, 'init', '-q');
    git(reference, 'add', '.');
    git(reference, 'commit', '-qm', 'exact workspace reference');
    await analysis.runFullAnalysis(
      reference,
      {
        skipNativeClose: true,
        skipAgentsMd: true,
        noStats: true,
        registryName: referenceName,
        embeddings: false,
      },
      { onProgress() {} },
    );
    const normalize = (result: Context) => ({
      status: result.status,
      uid: result.symbol.uid,
      incoming: (result.incoming.calls ?? [])
        .map(({ uid, name, filePath, kind }) => ({ uid, name, filePath, kind }))
        .sort((a, b) => a.uid.localeCompare(b.uid)),
      outgoing: (result.outgoing.calls ?? [])
        .map(({ uid, name, filePath, kind }) => ({ uid, name, filePath, kind }))
        .sort((a, b) => a.uid.localeCompare(b.uid)),
    });
    for (const target of ['callee', 'alternate', 'caller']) {
      const workspace = await context(target);
      const full = await context(target, referenceName);
      expect(workspace.source).toBe('workspace-graph');
      expect(full.status).toBe('found');
      expect(full.source).not.toBe('workspace-graph');
      expect(normalize(workspace)).toEqual(normalize(full));
      if (target === 'callee') {
        expect(full.incoming.calls).toContainEqual(
          expect.objectContaining({ uid: 'Function:src/renamed.ts:addedCaller' }),
        );
        expect(full.incoming.calls ?? []).not.toContainEqual(
          expect.objectContaining({ uid: 'Function:src/caller.ts:caller' }),
        );
      } else if (target === 'alternate') {
        expect(full.incoming.calls).toContainEqual(
          expect.objectContaining({ uid: 'Function:src/caller.ts:caller' }),
        );
      } else {
        expect(full.outgoing.calls).toContainEqual(
          expect.objectContaining({ uid: 'Function:src/callee.ts:alternate' }),
        );
        expect(full.outgoing.calls ?? []).not.toContainEqual(
          expect.objectContaining({ uid: 'Function:src/callee.ts:callee' }),
        );
      }
    }
    expect(builds()).toBe(expectedBuilds);
    expect((await activeOverlay()).generation).toBe(generation);

    await write('src/broken.ts', 'export function broken( {\n');
    await rebuilt('callee', 'src/callee.ts');
    expect((await activeOverlay()).base).toMatchObject({
      capability: 'workspace-graph',
      coverage: 'partial',
      parseErrorCount: 1,
      parseErrorFiles: ['src/broken.ts'],
    });
  }, 1_200_000);

  it('admits small symbol reads and rebuilds once after a clean HEAD advances', async () => {
    await fs.unlink(path.join(repo, 'src/broken.ts'));
    await write('src/admission.ts', 'export function admissionCurrent() { return 42; }\n');
    const symbol = await call<{ name: string; filePath: string; content?: string }>(
      'get_symbol_info',
      {
        repo: repoName,
        uid: 'Function:src/admission.ts:admissionCurrent',
      },
    );
    expect(symbol).toMatchObject({ name: 'admissionCurrent', filePath: 'src/admission.ts' });
    expect(symbol.content).toContain('return 42');
    expect(
      await call('get_symbol_info', {
        repo: repoName,
        uid: 'Function:src/deleted.ts:deletedSymbol',
      }),
    ).toMatchObject({ error: 'not found', repoLabel: repoName, repoPath: await fs.realpath(repo) });

    const dirty = await activeOverlay();
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'advance HEAD without analyzing');
    const head = git(repo, 'rev-parse', 'HEAD').toString().trim();
    expect(git(repo, 'status', '--porcelain').toString()).toBe('');
    const registryPath = path.join(root, 'home', 'registry.json');
    const registry = await fs.readFile(registryPath);
    const source = await fs.readFile(path.join(repo, 'src/admission.ts'));
    const beforeBuilds = builds();

    expect(await context('admissionCurrent')).toMatchObject({
      status: 'found',
      source: 'workspace-graph',
      symbol: { name: 'admissionCurrent' },
    });
    const clean = await activeOverlay();
    expect(clean.generation).not.toBe(dirty.generation);
    expect(clean.base).toMatchObject({
      capability: 'workspace-graph',
      coverage: 'complete',
      head,
      baseCommit: dirty.base.baseCommit,
      baseGenerationId: dirty.base.baseGenerationId,
    });
    expect(clean.base.baseCommit).not.toBe(head);
    expect(clean.base.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(builds()).toBe(beforeBuilds + 1);
    expect((await search('admissionCurrent')).definitions).toContainEqual(
      expect.objectContaining({
        name: 'admissionCurrent',
        filePath: 'src/admission.ts',
      }),
    );
    expect((await search('deletedSymbol')).definitions ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'deletedSymbol' }),
    );
    await context('admissionCurrent');
    expect((await activeOverlay()).generation).toBe(clean.generation);
    expect(builds()).toBe(beforeBuilds + 1);
    expect(await fs.readFile(registryPath)).toEqual(registry);
    expect(await fs.readFile(path.join(repo, 'src/admission.ts'))).toEqual(source);
    expect(git(repo, 'rev-parse', 'HEAD').toString().trim()).toBe(head);
    expect(git(repo, 'status', '--porcelain').toString()).toBe('');
  }, 1_200_000);
});
