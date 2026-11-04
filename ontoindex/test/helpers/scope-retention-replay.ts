import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, vi } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { persistScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import { loadScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';

export const retentionRequest = () => ({
  deadline: Date.now() + 60_000,
  artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
});

export function graphSnapshot(graph: KnowledgeGraph) {
  return {
    nodes: structuredClone(graph.nodes).sort((a, b) => a.id.localeCompare(b.id)),
    relationships: structuredClone(graph.relationships).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

const identity = {
  sourceManifestDigest: 'a'.repeat(64),
  targetCommit: 'head',
  baseGenerationId: null,
};

export const retentionIdentity = identity;

export async function runRetainedReplayParity({
  files,
  options,
  onRetained,
}: {
  files: Record<string, string>;
  options: (repo: string) => object;
  onRetained?: (
    handle: Parameters<
      NonNullable<Parameters<typeof runPipelineFromRepo>[2]['scopeRetention']>['consume']
    >[0],
    generation: string,
  ) => void | Promise<void>;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-retained-parity-'));
  const repo = path.join(root, 'repo');
  const generation = path.join(root, 'generation');
  fs.mkdirSync(repo);
  fs.mkdirSync(generation);
  const preserve = vi.fn(async () => {});
  try {
    for (const [file, source] of Object.entries(files))
      fs.writeFileSync(path.join(repo, file), source);
    let expected: Parameters<typeof loadScopeRetentionCandidate>[1] | undefined;
    const pipelineOptions = options(repo);
    const full = await runPipelineFromRepo(repo, () => {}, {
      ...pipelineOptions,
      scopeRetention: {
        ...retentionRequest(),
        consume: async (handle) => {
          await onRetained?.(handle, generation);
          expected = { identity, parserCodeIdentity: handle.inputEvidence.parserCodeIdentity };
          const manifest = await persistScopeRetentionCandidate(
            handle,
            generation,
            identity,
            retentionRequest(),
          );
          expect(manifest.retention.status).toBe('retained');
        },
      },
    });
    expect(expected).toBeDefined();
    const candidate = await loadScopeRetentionCandidate(generation, expected, retentionRequest());
    const replay = await runPipelineFromRepo(repo, () => {}, {
      ...options(repo),
      scopeReplay: { candidate, request: retentionRequest(), preserve },
    });
    return {
      full,
      replay,
      candidate,
      repo,
      preserve,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Test-only materialization of tiny verified fixtures; this is not a runtime admission API. */
export async function loadPersistedReplayFamilies(
  generationPath: string,
  expected: Parameters<typeof loadScopeRetentionCandidate>[1],
) {
  const { families } = await loadScopeRetentionCandidate(generationPath, expected, {
    deadline: Date.now() + 60_000,
  });
  return families;
}

export type ReplayFamilies = Awaited<ReturnType<typeof loadPersistedReplayFamilies>>;
