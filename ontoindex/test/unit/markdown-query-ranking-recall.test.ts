import { describe, expect, it } from 'vitest';

import { produceMarkdownSidecarFacts } from '../../src/core/ingestion/enrichment/markdown-sidecar-producer.js';
import type { MarkdownChunkFact } from '../../src/core/ingestion/enrichment/markdown-document-facts.js';
import {
  scoreMarkdownChunks,
  type MarkdownRankableChunk,
} from '../../src/core/ingestion/enrichment/markdown-query-ranking.js';

const documents = [
  {
    docPath: 'docs/architecture.md',
    source:
      '# Architecture\n\n## How to add a new phase\n\nCreate a pipeline phase file, export it, and add it to buildPhaseList.\n',
  },
  {
    docPath: 'docs/runbook.md',
    source:
      '# Runbook\n\n## Index out of date\n\nRun analyze when the index is stale after a commit.\n',
  },
  {
    docPath: 'docs/embeddings.md',
    source:
      '# Embeddings\n\n## Enable embeddings\n\nPass --embeddings to analyze to generate vectors for semantic search.\n',
  },
  {
    docPath: 'docs/testing.md',
    source: '# Testing\n\n## Commands\n\nRun vitest for unit tests and integration tests.\n',
  },
  {
    docPath: 'docs/security.md',
    source:
      '# Security\n\n## Reporting a vulnerability\n\nEmail the maintainers privately before disclosure.\n',
  },
  {
    docPath: 'docs/locks.md',
    source:
      '# Locks\n\n## Database busy\n\nA LadybugDB lock means another process holds the database.\n',
  },
  {
    docPath: '.memory-bank/archive/old-plan.md',
    source:
      '# Old Plan\n\n## Phase tasks\n\nPipeline phase pipeline phase task: add a new phase. Run analyze. Run vitest.\n',
  },
  {
    docPath: '.memory-bank/audit_session-2026-01-01-x.md',
    source: '# Audit\n\n## Notes\n\nEmbeddings and analyze were checked. Database lock seen.\n',
  },
];

const chunks: MarkdownRankableChunk[] = documents.flatMap(({ docPath, source }) =>
  produceMarkdownSidecarFacts({ docPath, source, sourceCommitHash: 'test' })
    .filter((fact): fact is MarkdownChunkFact => fact.kind === 'markdown-chunk')
    .map(({ chunkKey, docPath, headingPath, excerpt }) => ({
      chunkKey,
      docPath,
      headingPath,
      excerpt,
    })),
);

const queries = [
  { query: 'how to add a new pipeline phase', expectedDocPath: 'docs/architecture.md' },
  { query: 'index is stale', expectedDocPath: 'docs/runbook.md' },
  { query: 'enable embeddings for semantic search', expectedDocPath: 'docs/embeddings.md' },
  { query: 'run unit tests', expectedDocPath: 'docs/testing.md' },
  { query: 'report a security vulnerability', expectedDocPath: 'docs/security.md' },
  { query: 'database busy lock', expectedDocPath: 'docs/locks.md' },
  { query: 'buildPhaseList', expectedDocPath: 'docs/architecture.md' },
  { query: 'generate vectors', expectedDocPath: 'docs/embeddings.md' },
  { query: 'kubernetes helm chart' },
  { query: 'quarterly revenue forecast' },
];

describe('Markdown query-ranking recall corpus', () => {
  it('ranks the expected document first for at least six labelled queries', () => {
    let rankOneCount = 0;

    for (const { query, expectedDocPath } of queries) {
      const scores = scoreMarkdownChunks(query, chunks);
      if (!expectedDocPath) {
        console.log(`${query} -> no match`);
        expect(scores.size).toBe(0);
        continue;
      }

      const bestScoreByDocument = new Map<string, number>();
      for (const chunk of chunks) {
        if (!chunk.chunkKey) continue;
        const score = scores.get(chunk.chunkKey);
        if (score !== undefined) {
          bestScoreByDocument.set(
            chunk.docPath,
            Math.max(bestScoreByDocument.get(chunk.docPath) ?? 0, score),
          );
        }
      }

      const rankedDocuments = [...bestScoreByDocument].sort((left, right) => right[1] - left[1]);
      const rank =
        rankedDocuments.findIndex(([docPath]) => docPath === expectedDocPath) + 1 || undefined;
      console.log(`${query} -> ${rank ?? 'not found'}`);
      if (rank === 1) rankOneCount += 1;
    }

    expect(rankOneCount).toBeGreaterThanOrEqual(6);
  });
});
