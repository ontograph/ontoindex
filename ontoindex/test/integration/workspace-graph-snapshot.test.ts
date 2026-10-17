import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import lbug from '@ladybugdb/core';
import { expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { closeLbug, initLbug, loadGraphToLbug } from '../../src/core/lbug/lbug-adapter.js';
import * as repoManager from '../../src/storage/repo-manager.js';
import {
  getOverlaySnapshot,
  resetOverlaySnapshotCache,
} from '../../src/mcp/local/backend-overlay.js';
import { buildTestGraph } from '../helpers/test-graph.js';

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-graph-'));
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
    await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n');
    await fs.writeFile(
      path.join(repo, 'src/caller.ts'),
      "import { callee } from './callee';\nexport function caller() { return callee(); }\n",
    );
    await fs.writeFile(
      path.join(repo, 'src/callee.ts'),
      'export function callee() { return 1; }\n',
    );
    await fs.writeFile(
      path.join(repo, 'src/deleted.ts'),
      'export function deletedSymbol() { return 0; }\n',
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
    const baseline = await repoManager.createIndexGeneration(storagePath, 'baseline');
    await initLbug(baseline.lbugPath, { maxDBSize: 2 ** 32 });
    try {
      await loadGraphToLbug(buildTestGraph([], []), repo, baseline.generationPath);
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
    await fs.writeFile(
      path.join(active.generationPath, 'embeddings.sentinel'),
      'committed embeddings\n',
    );
    await fs.writeFile(
      path.join(repo, 'src/callee.ts'),
      'export function callee() { return newSymbol(); }\nexport function newSymbol() { return 2; }\n',
    );
    await fs.unlink(path.join(repo, 'src/deleted.ts'));
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
    const analyzeRepo = vi.fn(({ repoPath, onProgress, options }) =>
      runPipelineFromRepo(repoPath, onProgress, { ...options, skipWorkers: true }),
    );
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
    expect(graph.edges).toContain(
      JSON.stringify(['Function:src/caller.ts:caller', 'Function:src/callee.ts:callee', 'CALLS']),
    );
    expect(JSON.parse(await fs.readFile(path.join(published, 'base.json'), 'utf8'))).toMatchObject({
      capability: 'workspace-graph',
      profile: 'full',
      includePaths: [],
      coverage: 'partial',
      parseErrorCount: 1,
      parseErrorFiles: ['src/broken.ts'],
      dirtyPaths: ['src/broken.ts', 'src/callee.ts', 'src/deleted.ts'],
      tombstones: ['src/deleted.ts'],
      inputs: { 'src/callee.ts': expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
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
      reason: expect.stringContaining('src/caller.ts'),
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

it('marks the graph degraded when parse-error paths exceed the recorded list', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-graph-trunc-'));
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
