import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import lbug from '@ladybugdb/core';
import { expect, it, vi } from 'vitest';
import { initializeWorkspaceParserRuntime } from '../../src/core/tree-sitter/parser-identity.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import type { AnalyzeRepoInput } from '../../src/core/ingestion/runtime/analyze-runtime.js';
import type { ScopeRetentionCandidateManifest } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';

function snapshot(graph: KnowledgeGraph) {
  return {
    nodes: structuredClone(graph.nodes).sort((left, right) => left.id.localeCompare(right.id)),
    relationships: structuredClone(graph.relationships).sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

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

const fixtures: Array<{
  language: string;
  main: string;
  files: Record<string, string>;
  addition: string;
}> = [
  {
    language: 'typescript',
    main: 'src/main.ts',
    files: {
      'src/util.ts': 'export function helper() { return 1; }\n',
      'src/main.ts':
        "import { helper } from './util';\nexport function entry() { return helper(); }\n",
    },
    addition: 'export function added() { return entry(); }\n',
  },
  {
    language: 'javascript',
    main: 'src/main.js',
    files: {
      'src/util.js': 'export function helper() { return 1; }\n',
      'src/main.js':
        "import { helper } from './util';\nexport function entry() { return helper(); }\n",
    },
    addition: 'export function added() { return entry(); }\n',
  },
  {
    language: 'python',
    main: 'src/first.py',
    files: {
      'src/first.py': 'def first():\n    first()\ndef second():\n    first()\nsecond()\n',
      'src/other.py': 'def other():\n    other()\ndef entry():\n    other()\nentry()\n',
    },
    addition: 'def added():\n    second()\n',
  },
  {
    language: 'cpp',
    main: 'src/first.cpp',
    files: {
      'src/first.cpp': 'void first() { first(); }\nvoid second() { first(); second(); }\n',
      'src/other.cpp': 'void other() { other(); }\nvoid entry() { other(); entry(); }\n',
    },
    addition: 'void added() { second(); }\n',
  },
  {
    language: 'rust',
    main: 'src/first.rs',
    files: {
      'src/first.rs': 'pub fn first() { second(); first(); }\nfn second() { first(); second(); }\n',
      'src/other.rs': 'pub fn other() { entry(); other(); }\nfn entry() { other(); entry(); }\n',
    },
    addition: 'fn added() { second(); }\n',
  },
];

it.sequential.each(fixtures)(
  '$language replays complete real workspace candidates twice and falls back once per changed input',
  async (fixture) => {
    // Parser runtime initialization must precede loading the analyzer or parser implementation.
    const startupIdentity = await initializeWorkspaceParserRuntime();
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    const { runPipelineFromRepo } = await import('../../src/core/ingestion/pipeline.js');
    const parseImplementation =
      await import('../../src/core/ingestion/pipeline-phases/parse-impl.js');
    const { loadScopeRetentionCandidate } =
      await import('../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js');
    const { getStoragePaths } = await import('../../src/storage/repo-manager.js');
    const { closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-roundtrip-'));
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    const request = () => ({
      deadline: Date.now() + 120_000,
      artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
    });
    const parser = vi.spyOn(parseImplementation, 'runChunkedParseAndResolve');
    try {
      await fs.mkdir(path.join(repo, 'src'), { recursive: true });
      await fs.mkdir(home);
      await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
      vi.stubEnv('ONTOINDEX_HOME', home);
      for (const [filePath, source] of Object.entries(fixture.files)) {
        await fs.writeFile(path.join(repo, filePath), source);
      }
      git('init', '-q');
      // Keep the captured inventory source-only without adding an unsupported .gitignore input.
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
      const overlay = path.join(storagePath, 'overlay');
      const analyzeRepo = vi.fn(({ repoPath, onProgress, options }: AnalyzeRepoInput) =>
        runPipelineFromRepo(repoPath, onProgress, { ...options, skipWorkers: true }),
      );
      async function generation() {
        const result = await runFullAnalysis(
          repo,
          { workspaceGraph: true, skipNativeClose: true },
          { onProgress: () => {} },
          {
            analyzeRuntime: { analyzeRepo },
            scopeRetention: request(),
          },
        );
        const name = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
        const directory = path.join(overlay, name);
        // Pins for both replay admission and publication must be gone on return.
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
        expect(result.pipelineResult).toBeDefined();
        const graph = result.pipelineResult!.graph;
        const stored = await storedGraph(path.join(directory, 'lbug'));
        expect(stored).toEqual({
          nodes: graph.nodes.map((node) => node.id).sort(),
          edges: graph.relationships
            .map((edge) => JSON.stringify([edge.sourceId, edge.targetId, edge.type]))
            .sort(),
        });
        const base = JSON.parse(await fs.readFile(path.join(directory, 'base.json'), 'utf8'));
        expect(base).toMatchObject({
          capability: 'workspace-graph',
          coverage: 'complete',
          parserIdentity: startupIdentity,
        });
        expect(base.buildTimings.parseMode).toBe(result.pipelineResult!.parseMode);
        const candidate = await loadScopeRetentionCandidate(
          directory,
          {
            identity: {
              sourceManifestDigest: base.manifestDigest,
              targetCommit: base.head,
              baseGenerationId: base.baseGenerationId,
            },
            parserCodeIdentity: startupIdentity,
          },
          request(),
        );
        const manifest: ScopeRetentionCandidateManifest = candidate.manifest;
        expect(manifest.retention.inputEvidence.parserCodeIdentity).toBe(startupIdentity);
        return { name, graph: snapshot(graph), stored, base, manifest };
      }

      const first = await generation();
      expect(parser).toHaveBeenCalledTimes(1);
      expect(first.base.buildTimings.parseMode).toBe('full');
      expect(first.manifest).toMatchObject({
        coverage: { complete: true },
        retention: {
          inputEvidence: { complete: true },
          graphNodesCaptured: true,
          graphRelationshipsCaptured: true,
        },
      });
      parser.mockClear();
      const second = await generation();
      expect(parser).not.toHaveBeenCalled();
      expect(second.base.buildTimings.parseMode).toBe('retained-replay');
      const third = await generation();
      expect(parser).not.toHaveBeenCalled();
      expect(third.base.buildTimings.parseMode).toBe('retained-replay');
      expect(new Set([first.name, second.name, third.name]).size).toBe(3);
      for (const replay of [second, third]) {
        expect(replay.graph).toEqual(first.graph);
        expect(replay.stored).toEqual(first.stored);
        expect(replay.manifest).toEqual(first.manifest);
        expect(replay.base.manifestDigest).toBe(first.base.manifestDigest);
      }

      let previous = third;
      for (const change of ['source', 'configuration'] as const) {
        if (change === 'source') {
          await fs.appendFile(path.join(repo, fixture.main), fixture.addition);
        } else {
          await fs.writeFile(
            path.join(repo, 'tsconfig.json'),
            '{"compilerOptions":{"baseUrl":"."}}\n',
          );
        }
        parser.mockClear();
        const fallback = await generation();
        expect(parser).toHaveBeenCalledTimes(1);
        expect(fallback.base.buildTimings.parseMode).toBe('full');
        expect(fallback.base.manifestDigest).not.toBe(previous.base.manifestDigest);
        parser.mockClear();
        const fresh = await runPipelineFromRepo(repo, () => {}, {
          skipWorkers: true,
          profile: 'full',
          capturedWorkspace: { captureRoot: repo, canonicalRepoPath: await fs.realpath(repo) },
        });
        expect(parser).toHaveBeenCalledTimes(1);
        expect(fresh.parseMode).toBe('full');
        expect(fallback.graph).toEqual(snapshot(fresh.graph));
        expect(fallback.stored).toEqual({
          nodes: fresh.graph.nodes.map((node) => node.id).sort(),
          edges: fresh.graph.relationships
            .map((edge) => JSON.stringify([edge.sourceId, edge.targetId, edge.type]))
            .sort(),
        });
        // Config files can make parser inventory incomplete; do not rewrite retained evidence.
        if (change === 'source') {
          expect(fallback.manifest.retention.inputEvidence.complete).toBe(true);
          parser.mockClear();
          const recovered = await generation();
          expect(parser).not.toHaveBeenCalled();
          expect(recovered.base.buildTimings.parseMode).toBe('retained-replay');
          expect(recovered.name).not.toBe(fallback.name);
          expect(recovered.graph).toEqual(fallback.graph);
          expect(recovered.stored).toEqual(fallback.stored);
          expect(recovered.manifest).toEqual(fallback.manifest);
          expect(recovered.base.manifestDigest).toBe(fallback.base.manifestDigest);
          previous = recovered;
        } else {
          previous = fallback;
        }
      }
      expect(analyzeRepo).toHaveBeenCalledTimes(6);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      try {
        await closeLbug();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  },
  240_000,
);
