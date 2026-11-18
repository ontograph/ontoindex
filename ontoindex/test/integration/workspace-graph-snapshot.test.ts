import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import lbug from '@ladybugdb/core';
import { expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { prepareWorkspaceGraphCommand } from '../../src/cli/analyze.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import * as workspaceRuntime from '../../src/mcp/local/local-backend-repo-runtime.js';
import { planDirtyOverlay } from '../../src/core/analyze-delta.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { closeLbug, initLbug, loadGraphToLbug } from '../../src/core/lbug/lbug-adapter.js';
import * as repoManager from '../../src/storage/repo-manager.js';
import {
  getOverlaySnapshot,
  queryOverlay,
  resetOverlaySnapshotCache,
} from '../../src/mcp/local/backend-overlay.js';

async function hashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of Object.entries(await hashes(file)))
        result[`${entry.name}/${name}`] = hash;
    } else if (entry.isSymbolicLink()) result[entry.name] = await fs.readlink(file);
    else
      result[entry.name] = createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex');
  }
  return result;
}

async function readGraph(file: string) {
  const db = new lbug.Database(file, 0, true, true, 2 ** 32);
  const conn = new lbug.Connection(db);
  const query = async (cypher: string) => {
    const response = await conn.query(cypher);
    const results = Array.isArray(response) ? response : [response];
    try {
      return await results[0].getAll();
    } finally {
      for (const result of results) result.close();
    }
  };
  try {
    return {
      nodes: (await query('MATCH (n) RETURN n.id AS id')).map((row) => String(row.id)).sort(),
      edges: (
        await query('MATCH (a)-[r]->(b) RETURN a.id AS source, b.id AS target, r.type AS type')
      )
        .map((row) => JSON.stringify([row.source, row.target, row.type]))
        .sort(),
    };
  } finally {
    try {
      await conn.close();
    } finally {
      await db.close();
    }
  }
}

it('publishes a partial captured workspace graph with parse-error paths without mutating committed state and rolls back failures', async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-graph-')),
  );
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const copy = path.join(root, 'independent');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  try {
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    vi.stubEnv('ONTOINDEX_HOME', home);
    // The snapshot is only usable with the feature on; the gate has its own test.
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n');
    await fs.writeFile(
      path.join(repo, 'src/caller.ts'),
      "import { callee } from './callee';\nexport function caller() { return callee(); }\n",
    );
    await fs.writeFile(
      path.join(repo, 'src/callee.ts'),
      "import { deletedSymbol } from './deleted';\nexport function callee() { return deletedSymbol(); }\n",
    );
    await fs.writeFile(
      path.join(repo, 'src/deleted.ts'),
      'export function deletedSymbol() { return 0; }\n',
    );
    await fs.writeFile(
      path.join(repo, 'src/renamed.ts'),
      'export function retained() { return 3; }\n',
    );
    await fs.writeFile(
      path.join(repo, 'src/importer.ts'),
      "import { retained } from './renamed';\nexport function importer() { return retained(); }\n",
    );
    git('init', '-q');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'baseline',
    );
    const { storagePath } = repoManager.getStoragePaths(repo);
    const baselineGraph = await runPipelineFromRepo(repo, () => {}, {
      skipWorkers: true,
      profile: 'full',
      capturedWorkspace: { captureRoot: repo, canonicalRepoPath: await fs.realpath(repo) },
    });
    const baseline = await repoManager.createIndexGeneration(storagePath, 'baseline');
    await initLbug(baseline.lbugPath, { maxDBSize: 2 ** 32 });
    try {
      await loadGraphToLbug(baselineGraph.graph, repo, baseline.generationPath);
    } finally {
      await closeLbug();
    }
    await fs.writeFile(
      baseline.metaPath,
      JSON.stringify({
        generationId: baseline.generationId,
        lastCommit: git('rev-parse', 'HEAD').trim(),
      }),
    );
    const active = await repoManager.activateIndexGeneration(storagePath, baseline);
    const baselineStored = await readGraph(active.lbugPath);
    expect(baselineStored.edges).toContain(
      JSON.stringify([
        'Function:src/callee.ts:callee',
        'Function:src/deleted.ts:deletedSymbol',
        'CALLS',
      ]),
    );
    await fs.writeFile(
      path.join(active.generationPath, 'embeddings.sentinel'),
      'committed embeddings\n',
    );
    await fs.writeFile(
      path.join(repo, 'src/callee.ts'),
      'export function callee() { return newSymbol(); }\nexport function newSymbol() { return 2; }\n',
    );
    await fs.unlink(path.join(repo, 'src/deleted.ts'));
    git('mv', 'src/renamed.ts', 'src/moved.ts');
    await fs.writeFile(
      path.join(repo, 'src/importer.ts'),
      "import { retained } from './moved';\nexport function importer() { return retained(); }\n",
    );
    await fs.writeFile(path.join(repo, 'src/broken.ts'), 'export function broken( {\n');
    await fs.mkdir(copy);
    await fs.cp(path.join(repo, 'src'), path.join(copy, 'src'), { recursive: true });
    await fs.copyFile(path.join(repo, '.gitignore'), path.join(copy, '.gitignore'));
    const before = {
      generation: await hashes(active.generationPath),
      meta: await fs.readFile(repoManager.getStoragePaths(repo).metaPath),
      registry: await hashes(home),
      git: await hashes(path.join(repo, '.git')),
      head: git('rev-parse', 'HEAD'),
      status: git('status', '--porcelain'),
      current: await fs.readlink(path.join(storagePath, 'current')),
    };
    const analyzeRepo = vi.fn(({ repoPath, onProgress, options }) => {
      const phaseEvent = {
        event: 'phase-end' as const,
        phaseName: 'injected-phase',
        elapsedMs: 5,
        durationMs: 5,
        rssBytes: 0,
        heapUsedBytes: 0,
        heapTotalBytes: 0,
        heapLimitBytes: 0,
        graphNodes: 0,
        graphRelationships: 0,
      };
      options?.onTelemetry?.(phaseEvent);
      for (const durationMs of [-1, NaN, Infinity]) {
        options?.onTelemetry?.({ ...phaseEvent, phaseName: 'invalid-phase', durationMs });
      }
      options?.onTelemetry?.({ ...phaseEvent, phaseName: '' });
      for (let i = 0; i < 140; i++) {
        options?.onTelemetry?.({ ...phaseEvent, phaseName: `bounded-phase-${i}` });
      }
      return runPipelineFromRepo(repoPath, onProgress, { ...options, skipWorkers: true });
    });
    const options = { workspaceGraph: true, skipNativeClose: true, embeddings: true };
    const dependencies = { analyzeRuntime: { analyzeRepo } };
    const result = await runFullAnalysis(repo, options, { onProgress: () => {} }, dependencies);
    expect(result.stats.embeddings).toBe(0);
    const overlay = path.join(storagePath, 'overlay');
    const current = await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8');
    const published = path.join(overlay, current.trim());
    const graph = await readGraph(path.join(published, 'lbug'));
    expect(graph.nodes).toContain('Function:src/callee.ts:newSymbol');
    expect(graph.nodes.some((id) => id.includes('deleted'))).toBe(false);
    expect(graph.nodes.some((id) => id.includes('src/renamed.ts'))).toBe(false);
    expect(graph.edges).toContain(
      JSON.stringify([
        'Function:src/importer.ts:importer',
        'Function:src/moved.ts:retained',
        'CALLS',
      ]),
    );
    expect(graph.edges).toContain(
      JSON.stringify([
        'Function:src/callee.ts:callee',
        'Function:src/callee.ts:newSymbol',
        'CALLS',
      ]),
    );
    expect(graph.edges).toContain(
      JSON.stringify(['Function:src/caller.ts:caller', 'Function:src/callee.ts:callee', 'CALLS']),
    );
    const base = JSON.parse(await fs.readFile(path.join(published, 'base.json'), 'utf8'));
    expect(base).toMatchObject({
      capability: 'workspace-graph',
      profile: 'full',
      includePaths: [],
      coverage: 'partial',
      parseErrorCount: 1,
      parseErrorFiles: ['src/broken.ts'],
      dirtyPaths: [
        'src/broken.ts',
        'src/callee.ts',
        'src/deleted.ts',
        'src/importer.ts',
        'src/moved.ts',
        'src/renamed.ts',
      ],
      tombstones: ['src/deleted.ts', 'src/renamed.ts'],
      inputs: { 'src/callee.ts': expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    for (const key of ['captureAndInventoryMs', 'pipelineMs', 'storageLoadMs', 'ftsMs']) {
      expect(Number.isFinite(base.buildTimings[key])).toBe(true);
      expect(base.buildTimings[key]).toBeGreaterThanOrEqual(0);
    }
    expect(base.buildTimings.ftsMs).toBe(base.ftsDurationMs);
    expect(base.buildTimings.phases).toHaveLength(128);
    expect(base.buildTimings.phases[0]).toEqual({ name: 'injected-phase', durationMs: 5 });
    expect(base.buildTimings.phases).not.toContainEqual({ name: 'invalid-phase', durationMs: -1 });
    for (const phase of base.buildTimings.phases) {
      expect(phase.name).not.toBe('invalid-phase');
      expect(phase.name.length).toBeGreaterThan(0);
      expect(Number.isFinite(phase.durationMs)).toBe(true);
      expect(phase.durationMs).toBeGreaterThanOrEqual(0);
    }
    const independent = await runPipelineFromRepo(copy, () => {}, {
      skipWorkers: true,
      profile: 'full',
      capturedWorkspace: { captureRoot: copy, canonicalRepoPath: await fs.realpath(repo) },
    });
    expect(graph).toEqual({
      nodes: independent.graph.nodes.map((node) => node.id).sort(),
      edges: independent.graph.relationships
        .map((edge) => JSON.stringify([edge.sourceId, edge.targetId, edge.type]))
        .sort(),
    });
    const overlayBefore = await hashes(overlay);
    await expect(
      runFullAnalysis(
        repo,
        options,
        {
          onProgress: (phase, _percent, message) => {
            if (phase === 'lbug' && message.startsWith('Loaded nodes'))
              throw new Error('injected workspace load failure');
          },
        },
        dependencies,
      ),
    ).rejects.toThrow('injected workspace load failure');
    expect(await hashes(overlay)).toEqual(overlayBefore);
    expect(await fs.readdir(path.join(storagePath, 'workspace-inputs'))).toEqual([]);
    expect({
      generation: await hashes(active.generationPath),
      meta: await fs.readFile(repoManager.getStoragePaths(repo).metaPath),
      registry: await hashes(home),
      git: await hashes(path.join(repo, '.git')),
      head: git('rev-parse', 'HEAD'),
      status: git('status', '--porcelain'),
      current: await fs.readlink(path.join(storagePath, 'current')),
    }).toEqual(before);
    git('update-index', '--assume-unchanged', 'src/caller.ts');
    await fs.appendFile(
      path.join(repo, 'src/caller.ts'),
      '// hidden edit after workspace capture\n',
    );
    resetOverlaySnapshotCache();
    expect(
      await getOverlaySnapshot({ id: 'inventory-integration', repoPath: repo, storagePath }),
    ).toMatchObject({
      usable: false,
      reason: 'workspace graph dirty paths or tombstones differ; rebuild required',
    });
    await fs.writeFile(
      path.join(repo, 'src/caller.ts'),
      "import { callee } from './callee';\nexport function caller() { return callee(); }\n",
    );
    git('update-index', '--no-assume-unchanged', 'src/caller.ts');
  } finally {
    vi.unstubAllEnvs();
    await closeLbug();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);

it('replaces indexed symbols after a valid dirty edit larger than the old scan limit', async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-large-edit-')),
  );
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  let backend: LocalBackend | undefined;
  try {
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    vi.stubEnv('ONTOINDEX_AUTO_REFRESH', '0');
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n');
    const sourcePath = path.join(repo, 'src/callee.ts');
    await fs.writeFile(sourcePath, 'export function callee() { return 1; }\n');
    git('init', '-q');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'baseline',
    );
    const dependencies = {
      analyzeRuntime: {
        analyzeRepo: vi.fn(({ repoPath, onProgress, options }) =>
          runPipelineFromRepo(repoPath, onProgress, { ...options, skipWorkers: true }),
        ),
      },
    };
    await runFullAnalysis(
      repo,
      { skipNativeClose: true, skipAgentsMd: true, noStats: true, embeddings: false },
      { onProgress: () => {} },
      dependencies,
    );
    await closeLbug();
    const { storagePath } = repoManager.getStoragePaths(repo);
    expect((await readGraph(repoManager.getStoragePaths(repo).lbugPath)).nodes).toContain(
      'Function:src/callee.ts:callee',
    );
    const replacement =
      `/*${'x'.repeat(512 * 1024 + 1)}*/\n\n\n\n` +
      "export function replacementOnly() { return 'large-edit-replacement-marker'; }\n";
    expect(Buffer.byteLength(replacement)).toBeGreaterThan(512 * 1024);
    await fs.writeFile(sourcePath, replacement);
    await runFullAnalysis(
      repo,
      { workspaceGraph: true, skipNativeClose: true },
      { onProgress: () => {} },
      dependencies,
    );
    await closeLbug();
    const generation = (
      await fs.readFile(path.join(storagePath, 'overlay', 'CURRENT'), 'utf8')
    ).trim();
    const base = JSON.parse(
      await fs.readFile(path.join(storagePath, 'overlay', generation, 'base.json'), 'utf8'),
    );
    expect(base).toMatchObject({
      capability: 'workspace-graph',
      coverage: 'complete',
      parseErrorCount: 0,
      parseErrorFiles: [],
      inputs: {
        'src/callee.ts': createHash('sha256').update(replacement).digest('hex'),
      },
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(generation).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    backend = new LocalBackend({ watchWorkspace: false });
    await backend.init();
    const handle = await backend.resolveRepo(path.basename(repo));
    const context = (name: string) =>
      backend!.withPreparedRepoRead(
        handle,
        { needsRelationships: true, readMode: 'workspace' },
        () =>
          backend!.callTool('context', {
            repo: path.basename(repo),
            name,
            include_content: true,
          }),
      );
    expect(await context('callee')).toMatchObject({ error: "Symbol 'callee' not found" });
    expect(await context('replacementOnly')).toMatchObject({
      status: 'found',
      source: 'workspace-graph',
      symbol: {
        name: 'replacementOnly',
        filePath: 'src/callee.ts',
        content: expect.stringContaining("return 'large-edit-replacement-marker'"),
      },
      readContext: {
        mode: 'workspace',
        workingTreeIncluded: true,
        source: 'workspace-graph',
        generation,
        inputDigest: base.manifestDigest,
        semanticCoverage: 'complete',
        parseErrorPathCount: 0,
        parseErrorPathSample: [],
        parseErrorPathSampleTruncated: false,
      },
    });
  } finally {
    try {
      await backend?.disconnect();
    } finally {
      resetOverlaySnapshotCache();
      vi.unstubAllEnvs();
      await closeLbug();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}, 120_000);

it.each(['.ontoindexignore', '.gitignore', 'assume-deletion'])(
  'rebuilds a matching-HEAD base and removes stale symbols after %s',
  async (change) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-hidden-change-')),
    );
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    try {
      vi.stubEnv('ONTOINDEX_HOME', home);
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      vi.stubEnv('ONTOINDEX_NO_GITIGNORE', '');
      await fs.mkdir(home);
      await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
      await fs.mkdir(path.join(repo, 'src'), { recursive: true });
      await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n.claude/\n');
      await fs.writeFile(path.join(repo, '.ontoindexignore'), '# baseline\n');
      await fs.writeFile(
        path.join(repo, 'src/deleted.ts'),
        'export function staleSymbol() { return 1; }\n',
      );
      await fs.writeFile(path.join(repo, 'src/retained.ts'), 'export function retained() {}\n');
      git('init', '-q');
      git('add', '.');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'baseline',
      );
      const dependencies = {
        analyzeRuntime: {
          analyzeRepo: vi.fn(({ repoPath, onProgress, options }) =>
            runPipelineFromRepo(repoPath, onProgress, { ...options, skipWorkers: true }),
          ),
        },
      };
      await runFullAnalysis(
        repo,
        { skipNativeClose: true, skipAgentsMd: true, noStats: true, embeddings: false },
        { onProgress: () => {} },
        dependencies,
      );
      await closeLbug();
      expect(git('status', '--porcelain')).toBe('');
      const { storagePath, lbugPath } = repoManager.getStoragePaths(repo);
      expect((await readGraph(lbugPath)).nodes).toContain('Function:src/deleted.ts:staleSymbol');
      const overlayRepo = { id: repo, repoPath: repo, storagePath };
      expect(await getOverlaySnapshot(overlayRepo)).toMatchObject({
        baseMatches: true,
        headChanged: false,
      });
      if (change === 'assume-deletion') {
        git('update-index', '--assume-unchanged', 'src/deleted.ts');
        await fs.unlink(path.join(repo, 'src/deleted.ts'));
        expect(git('status', '--porcelain')).toBe('');
        expect(await planDirtyOverlay(repo)).toMatchObject({
          allDirtyPaths: ['src/deleted.ts'],
          tombstones: ['src/deleted.ts'],
          configPaths: [],
        });
      } else {
        await fs.appendFile(path.join(repo, change), 'src/deleted.ts\n');
        expect(await planDirtyOverlay(repo)).toMatchObject({
          allDirtyPaths: [],
          configPaths: [change],
        });
      }
      resetOverlaySnapshotCache();
      const dirty = await getOverlaySnapshot(overlayRepo);
      expect(dirty.baseMatches).toBe(true);
      expect(dirty.dirtyPaths.size + (dirty.configPaths?.size ?? 0)).toBeGreaterThan(0);
      const build = vi
        .spyOn(workspaceRuntime, 'buildWorkspaceGraph')
        .mockImplementation(async () => {
          await runFullAnalysis(
            repo,
            { workspaceGraph: true, skipNativeClose: true },
            { onProgress: () => {} },
            dependencies,
          );
        });
      try {
        const prepared = await prepareWorkspaceGraphCommand(repo);
        expect(build).toHaveBeenCalledOnce();
        expect(prepared).toMatchObject({ baseCurrent: false, reused: false });
        expect(prepared.snapshot).toMatchObject({ usable: true, capability: 'workspace-graph' });
        expect(await queryOverlay(overlayRepo, 'MATCH (n:Function) RETURN n.name AS name')).toEqual(
          [{ name: 'retained' }],
        );
        expect((await readGraph(lbugPath)).nodes).toContain('Function:src/deleted.ts:staleSymbol');
      } finally {
        build.mockRestore();
      }
    } finally {
      resetOverlaySnapshotCache();
      vi.unstubAllEnvs();
      await closeLbug();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

it.each(['target-edit', 'directory-retarget'])(
  'rebuilds the workspace graph from a committed config base after %s',
  async (change) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-config-target-')),
    );
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    const config = (target: string) =>
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@lib/*': [`src/${target}/*`] } },
      });
    try {
      vi.stubEnv('ONTOINDEX_HOME', home);
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      await fs.mkdir(home);
      await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
      await fs.mkdir(path.join(repo, 'configs'), { recursive: true });
      for (const target of ['a', 'b']) {
        await fs.mkdir(path.join(repo, 'src', target), { recursive: true });
        await fs.writeFile(
          path.join(repo, 'src', target, 'util.ts'),
          `export function util() { return '${target}'; }\n`,
        );
      }
      await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n');
      await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n.claude/\n');
      await fs.writeFile(path.join(repo, 'configs/aliases.json'), config('a'));
      await fs.mkdir(path.join(repo, 'configs-b'));
      await fs.writeFile(path.join(repo, 'configs-b/aliases.json'), config('b'));
      await fs.symlink('configs', path.join(repo, 'config-alias'));
      await fs.symlink('config-alias/aliases.json', path.join(repo, 'tsconfig.json'));
      await fs.writeFile(
        path.join(repo, 'src/main.ts'),
        "import { util } from '@lib/util';\nexport function main() { return util(); }\n",
      );
      git('init', '-q');
      git('add', '.');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'baseline',
      );
      const dependencies = {
        analyzeRuntime: {
          analyzeRepo: vi.fn(({ repoPath, onProgress, options }) =>
            runPipelineFromRepo(repoPath, onProgress, { ...options, skipWorkers: true }),
          ),
        },
      };
      await runFullAnalysis(
        repo,
        { skipNativeClose: true, skipAgentsMd: true, noStats: true, embeddings: false },
        { onProgress: () => {} },
        dependencies,
      );
      await closeLbug();
      const { storagePath } = repoManager.getStoragePaths(repo);
      const baseline = await readGraph(repoManager.getStoragePaths(repo).lbugPath);
      expect(baseline.edges).toContain(
        JSON.stringify(['File:src/main.ts', 'File:src/a/util.ts', 'IMPORTS']),
      );
      expect(git('status', '--porcelain')).toBe('');
      if (change === 'directory-retarget') {
        await fs.unlink(path.join(repo, 'config-alias'));
        await fs.symlink('configs-b', path.join(repo, 'config-alias'));
        expect(git('status', '--porcelain').trim()).toBe('M config-alias');
      } else {
        await fs.writeFile(path.join(repo, 'configs/aliases.json'), config('b'));
        expect(git('status', '--porcelain').trim()).toBe('M configs/aliases.json');
      }
      expect((await planDirtyOverlay(repo)).configPaths).toEqual(['tsconfig.json']);
      await runFullAnalysis(
        repo,
        { workspaceGraph: true, skipNativeClose: true },
        { onProgress: () => {} },
        dependencies,
      );
      const overlayRepo = { id: 'config-target-test', repoPath: repo, storagePath };
      expect(await getOverlaySnapshot(overlayRepo)).toMatchObject({ usable: true, reason: null });
      expect(
        await queryOverlay(
          overlayRepo,
          "MATCH (a:File)-[r:CodeRelation]->(b:File) WHERE a.filePath = 'src/main.ts' AND r.type = 'IMPORTS' RETURN b.filePath AS target",
        ),
      ).toEqual([{ target: 'src/b/util.ts' }]);
      // Retain the committed base but remove the previous overlay before the unsafe edit.
      resetOverlaySnapshotCache();
      await fs.rm(path.join(storagePath, 'overlay'), { recursive: true, force: true });
      const external = path.join(root, 'external.json');
      await fs.writeFile(external, config('a'));
      await fs.unlink(path.join(repo, 'config-alias'));
      await fs.symlink('configs', path.join(repo, 'config-alias'));
      await fs.unlink(path.join(repo, 'configs/aliases.json'));
      await fs.symlink(external, path.join(repo, 'configs/aliases.json'));
      expect(git('status', '--porcelain').trim()).toBe('T configs/aliases.json');
      const build = vi
        .spyOn(workspaceRuntime, 'buildWorkspaceGraph')
        .mockImplementation(async () => {
          await runFullAnalysis(
            repo,
            { workspaceGraph: true, skipNativeClose: true },
            { onProgress: () => {} },
            dependencies,
          );
        });
      try {
        await expect(prepareWorkspaceGraphCommand(repo)).rejects.toMatchObject({
          name: 'WorkspaceInputCaptureError',
          code: 'unsupported',
        });
        expect(build).toHaveBeenCalledOnce();
      } finally {
        build.mockRestore();
      }
    } finally {
      resetOverlaySnapshotCache();
      vi.unstubAllEnvs();
      await closeLbug();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

it('validates resolver configuration symlinks and detects changed target bytes', async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-config-link-')),
  );
  try {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    await fs.mkdir(path.join(root, 'configs'));
    await fs.writeFile(path.join(root, '.gitignore'), '.ontoindex/\n');
    await fs.writeFile(path.join(root, 'configs/aliases.json'), '{"compilerOptions":{}}\n');
    await fs.symlink('configs/aliases.json', path.join(root, 'tsconfig.json'));
    await fs.writeFile(path.join(root, 'a.ts'), 'export function linkedConfig() { return 1; }\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
    git('init', '-q');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'baseline',
    );
    await runFullAnalysis(
      root,
      { workspaceGraph: true, skipNativeClose: true },
      { onProgress: () => {} },
    );
    const { storagePath } = repoManager.getStoragePaths(root);
    const repo = { id: 'config-link-test', repoPath: root, storagePath };
    expect(await getOverlaySnapshot(repo)).toMatchObject({ usable: true, reason: null });
    expect(await queryOverlay(repo, 'MATCH (n:Function) RETURN n.name AS name')).toContainEqual({
      name: 'linkedConfig',
    });
    await fs.writeFile(
      path.join(root, 'configs/aliases.json'),
      '{"compilerOptions":{"strict":true}}\n',
    );
    resetOverlaySnapshotCache();
    expect(await getOverlaySnapshot(repo)).toMatchObject({ usable: false });
  } finally {
    resetOverlaySnapshotCache();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);

it('builds full-text indexes into the published workspace generation', async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-graph-fts-')),
  );
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'src/a.ts'),
      'export function uniqueNeedleAlpha() { return 1; }\n',
    );
    execFileSync('git', ['-C', root, 'init', '-q']);
    await runFullAnalysis(
      root,
      { workspaceGraph: true, skipNativeClose: true },
      { onProgress: () => {} },
    );
    const { storagePath } = repoManager.getStoragePaths(root);
    const overlay = path.join(storagePath, 'overlay');
    const current = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
    const base = JSON.parse(await fs.readFile(path.join(overlay, current, 'base.json'), 'utf8'));
    expect(base.ftsIndexes).toEqual(expect.arrayContaining(['function_fts']));
    expect(base.ftsDurationMs).toBeGreaterThanOrEqual(0);
    const rows = await queryOverlay(
      { id: 'fts-test', repoPath: root, storagePath },
      "CALL QUERY_FTS_INDEX('Function', 'function_fts', 'uniqueNeedleAlpha', conjunctive := false) RETURN node.name AS name",
    );
    expect(rows.map((row) => (row as { name: string }).name)).toContain('uniqueNeedleAlpha');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('marks the graph degraded when parse-error paths exceed the recorded list', async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-graph-trunc-')),
  );
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/a.ts'), 'export function a() { return 1; }\n');
    execFileSync('git', ['-C', root, 'init', '-q']);
    const analyzeRepo = vi.fn(async ({ repoPath, onProgress, options }) => {
      // 1,500 failing files reported in 100-path chunks: only the first 1,000 paths fit the record.
      for (let chunk = 0; chunk < 15; chunk++) {
        options.onTelemetry?.({
          event: 'parse-error-files',
          parseErrorCount: 100,
          parseErrorFiles: Array.from({ length: 100 }, (_, i) => `src/c${chunk}-${i}.ts`),
        });
      }
      return runPipelineFromRepo(repoPath, onProgress, { ...options, skipWorkers: true });
    });
    await runFullAnalysis(
      root,
      { workspaceGraph: true, skipNativeClose: true },
      { onProgress: () => {} },
      { analyzeRuntime: { analyzeRepo } },
    );
    const { storagePath } = repoManager.getStoragePaths(root);
    const current = (
      await fs.readFile(path.join(storagePath, 'overlay', 'CURRENT'), 'utf8')
    ).trim();
    const base = JSON.parse(
      await fs.readFile(path.join(storagePath, 'overlay', current, 'base.json'), 'utf8'),
    );
    expect(base.coverage).toBe('degraded');
    expect(base.parseErrorFiles.length).toBeLessThanOrEqual(1000);
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
