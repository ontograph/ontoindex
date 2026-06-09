import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { conceptsPhase } from '../../src/core/ingestion/pipeline-phases/concepts.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createEnrichmentRecord } from '../../src/core/ingestion/enrichment/enrichment-record.js';
import type { MarkdownDocumentFact } from '../../src/core/ingestion/enrichment/markdown-document-facts.js';
import {
  createEmptySidecarStoreState,
  getSidecarStorePath,
  saveSidecarStoreState,
} from '../../src/core/ingestion/enrichment/sidecar-store.js';
import { generateId } from '../../src/lib/utils.js';
import { createTempDir } from '../helpers/test-db.js';

describe('conceptsPhase', () => {
  it('materializes docs Concept nodes and provenance edges to existing graph nodes', async () => {
    const tmp = await createTempDir('concepts-phase-');
    try {
      const repoPath = path.join(tmp.dbPath, 'repo');
      const graph = createKnowledgeGraph();
      const docNodeId = generateId('File', 'docs/native-concepts.md');
      const symbolNodeId = 'Function:src/index.ts:main:1';

      graph.addNode({
        id: docNodeId,
        label: 'File',
        properties: { name: 'native-concepts.md', filePath: 'docs/native-concepts.md' },
      });
      graph.addNode({
        id: symbolNodeId,
        label: 'Function',
        properties: {
          name: 'main',
          filePath: 'src/index.ts',
          startLine: 1,
          endLine: 3,
          isExported: true,
        },
      });

      const facts = markdownConceptFacts(symbolNodeId);
      const state = createEmptySidecarStoreState();
      state.enrichments = [
        createEnrichmentRecord({
          sourceIndexId: 'idx-test',
          sourceCommitHash: 'commit-test',
          analyzerId: 'markdown-docs-test',
          analyzerVersion: '1.0.0',
          filePath: 'docs/native-concepts.md',
          fileHash: 'doc-hash',
          status: 'complete',
          records: facts,
        }),
      ];
      await saveSidecarStoreState(getSidecarStorePath(path.join(repoPath, '.ontoindex')), state);

      await conceptsPhase.execute(
        {
          repoPath,
          graph,
          onProgress: () => undefined,
          pipelineStart: Date.now(),
        },
        new Map(),
      );

      const concept = graph.nodes.find((node) => node.label === 'Concept');
      expect(concept).toBeDefined();
      expect(concept!.properties).toMatchObject({
        name: 'Native Concepts',
        filePath: 'docs/native-concepts.md',
        sourceDocuments: ['docs/native-concepts.md'],
        sourceFactKeys: expect.arrayContaining(['chunk:native-concepts', 'entity:native-concepts']),
        authority: 'advisory',
        evidenceClass: 'docs_evidence',
        freshness: 'unknown',
      });

      const conceptEdges = graph.relationships.filter((rel) => rel.sourceId === concept!.id);
      expect(conceptEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetId: docNodeId,
            type: 'EXPLAINED_BY',
            confidence: 1,
            reason: 'docs-concept-grounding',
          }),
          expect.objectContaining({
            targetId: symbolNodeId,
            type: 'EXPLAINED_BY',
            confidence: 0.8,
            reason: 'docs-symbol-grounding',
          }),
        ]),
      );
      expect(conceptEdges.some((rel) => rel.targetId === 'Function:missing')).toBe(false);
    } finally {
      await tmp.cleanup();
    }
  });
});

function markdownConceptFacts(symbolNodeId: string): MarkdownDocumentFact[] {
  return [
    {
      kind: 'markdown-chunk',
      docPath: 'docs/native-concepts.md',
      fileHash: 'doc-hash',
      sourceCommitHash: 'commit-test',
      headingPath: ['Native Concepts'],
      lineSpan: { start: 1, end: 4 },
      chunkIndex: 0,
      normalizedAnchor: 'native-concepts',
      contentHash: 'chunk-hash',
      chunkKey: 'chunk:native-concepts',
      excerpt: 'Native Concepts explain the main entry point.',
    },
    {
      kind: 'markdown-entity',
      entityKey: 'entity:native-concepts',
      label: 'Native Concepts',
      normalizedLabel: 'native-concepts',
      entityType: 'concept',
      sourceChunkKey: 'chunk:native-concepts',
      evidence: { text: 'Native Concepts', lineSpan: { start: 1, end: 1 } },
    },
    {
      kind: 'markdown-code-mention',
      chunkKey: 'chunk:native-concepts',
      target: { type: 'symbol', id: symbolNodeId, filePath: 'src/index.ts' },
      confidence: 0.9,
      resolutionStatus: 'resolved',
      evidence: { text: 'main', lineSpan: { start: 2, end: 2 } },
    },
    {
      kind: 'markdown-code-mention',
      chunkKey: 'chunk:native-concepts',
      target: { type: 'symbol', id: 'Function:missing', filePath: 'src/missing.ts' },
      confidence: 0.7,
      resolutionStatus: 'unresolved',
      evidence: { text: 'missing', lineSpan: { start: 3, end: 3 } },
    },
  ];
}
