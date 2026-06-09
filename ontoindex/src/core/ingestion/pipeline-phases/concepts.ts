/**
 * Phase: concepts
 *
 * Promotes docs concepts to first-class Concept nodes in the graph.
 *
 * @deps    markdown, communities
 * @reads   graph, LocalSidecarStore
 * @writes  graph (Concept nodes, EXPLAINED_BY edges)
 */

import path from 'node:path';
import type { PipelinePhase, PipelineContext } from './types.js';
import { deriveMarkdownConceptClusters } from '../enrichment/markdown-concept-clusters.js';
import { LocalSidecarStore, getSidecarStorePath } from '../enrichment/sidecar-store.js';
import { generateId } from '../../../lib/utils.js';
import type { MarkdownDocumentFact } from '../enrichment/markdown-document-facts.js';
import type { NodeLabel } from 'ontoindex-shared';

const GROUNDABLE_CONCEPT_LABELS = new Set<NodeLabel>([
  'File',
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Variable',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
]);

export const conceptsPhase: PipelinePhase = {
  name: 'concepts',
  deps: ['markdown', 'communities'],

  async execute(ctx: PipelineContext): Promise<void> {
    ctx.onProgress({
      phase: 'concepts' as any,
      percent: 90,
      message: 'Promoting documentation concepts to graph...',
    });

    // 1. Load enrichment facts from sidecar store
    const storagePath = path.join(ctx.repoPath, '.ontoindex');
    const storePath = getSidecarStorePath(storagePath);
    const store = new LocalSidecarStore(storePath);
    const state = await store.load();

    const allFacts: MarkdownDocumentFact[] = state.enrichments.flatMap(
      (e) => e.records as MarkdownDocumentFact[],
    );

    if (allFacts.length === 0) {
      return;
    }

    // 2. Derive concept clusters
    const { concepts } = deriveMarkdownConceptClusters({
      facts: allFacts,
      maxConcepts: 200, // Bounded
    });

    // 3. Materialize Concept nodes and EXPLAINED_BY relationships.
    for (const concept of concepts) {
      const conceptNodeId = generateId('Concept', concept.id);
      const primarySourceDocument = concept.sourceDocuments[0] ?? '';

      ctx.graph.addNode({
        id: conceptNodeId,
        label: 'Concept',
        properties: {
          name: concept.label,
          filePath: primarySourceDocument,
          aliases: concept.aliases,
          sourceDocuments: concept.sourceDocuments,
          sourceFactKeys: concept.sourceFactKeys,
          resolutionKeys: concept.resolutionKeys,
          authority: concept.authority,
          confidence: concept.confidence,
          evidenceClass: concept.evidenceClass,
          freshness: concept.freshness,
        },
      });

      // (c:Concept)-[:EXPLAINED_BY]->(f:File)
      for (const docPath of concept.sourceDocuments) {
        const fileNodeId = generateId('File', docPath);
        if (ctx.graph.getNode(fileNodeId)) {
          ctx.graph.addRelationship({
            id: generateId('Rel', `${conceptNodeId}_explained_by_${fileNodeId}`),
            type: 'EXPLAINED_BY',
            sourceId: conceptNodeId,
            targetId: fileNodeId,
            confidence: 1.0,
            reason: 'docs-concept-grounding',
          });
        }
      }

      // (c:Concept)-[:EXPLAINED_BY]->(s:Symbol)
      for (const identity of concept.linkedGraphIdentities) {
        const targetNode = ctx.graph.getNode(identity.id);
        if (targetNode === undefined || !GROUNDABLE_CONCEPT_LABELS.has(targetNode.label)) {
          continue;
        }
        ctx.graph.addRelationship({
          id: generateId('Rel', `${conceptNodeId}_explained_by_${identity.id}`),
          type: 'EXPLAINED_BY',
          sourceId: conceptNodeId,
          targetId: identity.id,
          confidence: identity.confidence ?? 0.8,
          reason: 'docs-symbol-grounding',
        });
      }
    }
  },
};
