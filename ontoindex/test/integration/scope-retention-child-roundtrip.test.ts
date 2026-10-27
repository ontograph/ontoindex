import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import lbug from '@ladybugdb/core';
import { expect, it, vi } from 'vitest';
import { loadScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { superviseWorkspaceBuild } from '../../src/mcp/local/workspace-build-supervisor.js';

const child = fileURLToPath(new URL('../../dist/core/workspace-build-child.js', import.meta.url));

async function storedGraph(file: string) {
  const database = new lbug.Database(file, 0, true, true, 2 ** 32);
  const connection = new lbug.Connection(database);
  const query = async (cypher: string) => {
    const response = await connection.query(cypher);
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
      await connection.close();
    } finally {
      await database.close();
    }
  }
}

it('preserves complete candidates across real child processes and recovers after a source change', async () => {
  expect(existsSync(child), 'Build the package before running the real child roundtrip test').toBe(
    true,
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-child-roundtrip-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  try {
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_VECTOR_BACKEND', 'lbug');
    await fs.writeFile(path.join(repo, 'src/util.ts'), 'export function helper() { return 1; }\n');
    await fs.writeFile(
      path.join(repo, 'src/main.ts'),
      "import { helper } from './util';\nexport function entry() { return helper(); }\n",
    );
    git('init', '-q');
    await fs.appendFile(path.join(repo, '.git/info/exclude'), '\n.ontoindex/\n');
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
    const { storagePath } = getStoragePaths(repo);
    await fs.mkdir(storagePath, { recursive: true });
    const overlay = path.join(storagePath, 'overlay');

    async function generation() {
      await superviseWorkspaceBuild({
        command: process.execPath,
        args: [
          child,
          repo,
          '--scope-retention',
          JSON.stringify({ timeoutMs: 120_000, maxBytes: 67_108_864 }),
        ],
        cwd: repo,
        storagePath,
        timeoutMs: 120_000,
      });
      const name = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
      const directory = path.join(overlay, name);
      const base = JSON.parse(await fs.readFile(path.join(directory, 'base.json'), 'utf8'));
      expect(base).toMatchObject({ capability: 'workspace-graph', coverage: 'complete' });
      expect(base.parserIdentity).toMatch(/^[a-f0-9]{64}$/);
      const candidate = await loadScopeRetentionCandidate(
        directory,
        {
          identity: {
            sourceManifestDigest: base.manifestDigest,
            targetCommit: base.head,
            baseGenerationId: base.baseGenerationId,
          },
          parserCodeIdentity: base.parserIdentity,
        },
        { deadline: Date.now() + 120_000 },
      );
      expect(candidate.manifest).toMatchObject({
        coverage: { complete: true },
        retention: {
          inputEvidence: { complete: true, parserCodeIdentity: base.parserIdentity },
          graphNodesCaptured: true,
          graphRelationshipsCaptured: true,
        },
      });
      expect(
        candidate.manifest.retention.inputEvidence.sources.map((source) => source.filePath).sort(),
      ).toEqual(['src/main.ts', 'src/util.ts']);
      const stored = await storedGraph(path.join(directory, 'lbug'));
      expect(stored.nodes.length).toBeGreaterThan(0);
      expect(stored.edges.length).toBeGreaterThan(0);
      for (const entry of await fs.readdir(overlay, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          expect(
            (await fs.readdir(path.join(overlay, entry.name))).filter((file) =>
              file.startsWith('.reader-'),
            ),
          ).toEqual([]);
        }
      }
      expect(await fs.readdir(path.join(storagePath, 'workspace-inputs'))).toEqual([]);
      expect(existsSync(path.join(storagePath, 'workspace-build.owner.json'))).toBe(false);
      return { name, base, candidate, stored };
    }

    const first = await generation();
    expect(first.base.buildTimings.parseMode).toBe('full');
    const second = await generation();
    expect(second.base.buildTimings.parseMode).toBe('retained-replay');
    const third = await generation();
    expect(third.base.buildTimings.parseMode).toBe('retained-replay');
    for (const unchanged of [second, third]) {
      expect(unchanged.base.parserIdentity).toBe(first.base.parserIdentity);
      expect(unchanged.base.manifestDigest).toBe(first.base.manifestDigest);
      expect(unchanged.stored).toEqual(first.stored);
      expect(unchanged.candidate).toEqual(first.candidate);
    }

    await fs.appendFile(
      path.join(repo, 'src/main.ts'),
      'export function added() { return entry(); }\n',
    );
    const changed = await generation();
    expect(changed.base.buildTimings.parseMode).toBe('full');
    expect(changed.base.parserIdentity).toBe(first.base.parserIdentity);
    expect(changed.base.manifestDigest).not.toBe(first.base.manifestDigest);
    expect(changed.stored.nodes).toEqual(expect.arrayContaining(first.stored.nodes));
    expect(changed.stored.nodes.length).toBeGreaterThan(first.stored.nodes.length);
    expect(changed.stored.edges).not.toEqual(first.stored.edges);
    expect(changed.candidate.manifest.retention.inputEvidence.sources).not.toEqual(
      first.candidate.manifest.retention.inputEvidence.sources,
    );

    const recovered = await generation();
    expect(recovered.base.buildTimings.parseMode).toBe('retained-replay');
    expect(recovered.base.parserIdentity).toBe(changed.base.parserIdentity);
    expect(recovered.base.manifestDigest).toBe(changed.base.manifestDigest);
    expect(recovered.stored).toEqual(changed.stored);
    expect(recovered.candidate).toEqual(changed.candidate);
    expect(new Set([first.name, second.name, third.name, changed.name, recovered.name]).size).toBe(
      5,
    );
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 300_000);
