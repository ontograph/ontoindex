import { describe, expect, it } from 'vitest';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { summaryTreePhase } from '../../src/core/ingestion/pipeline-phases/summary-tree.js';
import type { CommunitiesOutput } from '../../src/core/ingestion/pipeline-phases/communities.js';
import type {
  PhaseResult,
  PipelineContext,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';

describe('summaryTreePhase', () => {
  it('builds a deterministic multi-level summary tree over communities and concepts', async () => {
    const graph = createKnowledgeGraph();
    addSymbol(graph, 'Function:auth.ts:login', 'login', 'src/auth.ts');
    addSymbol(graph, 'Function:routes.ts:route', 'route', 'src/routes.ts');
    addConcept(
      graph,
      'Concept:auth-flow',
      'Auth Flow',
      ['docs/auth.md'],
      ['Function:auth.ts:login'],
    );
    addConcept(
      graph,
      'Concept:routing',
      'Routing',
      ['docs/routes.md'],
      ['Function:routes.ts:route'],
    );

    const result = await summaryTreePhase.execute(
      makeCtx(graph),
      makeDeps({
        communities: [
          {
            id: 'Community:routes',
            label: 'Routes',
            heuristicLabel: 'Routing',
            cohesion: 0.7,
            symbolCount: 1,
          },
          {
            id: 'Community:auth',
            label: 'Auth',
            heuristicLabel: 'Authentication',
            cohesion: 0.9,
            symbolCount: 1,
          },
        ],
        memberships: [
          { nodeId: 'Function:routes.ts:route', communityId: 'Community:routes' },
          { nodeId: 'Function:auth.ts:login', communityId: 'Community:auth' },
        ],
      }),
    );

    expect(result.summaryResult).toMatchObject({
      totalNodes: 5,
      depth: 2,
      limits: {
        maxCommunitySummaries: 200,
        maxConceptSummariesPerCommunity: 20,
        maxProvenanceIdsPerSummary: 50,
      },
      truncated: false,
    });
    expect(result.summaryResult.nodes.map((node) => node.id)).toEqual([
      'SummaryNode:root',
      'SummaryNode:community:Community%3Aauth',
      'SummaryNode:community:Community%3Aauth:concept:Concept%3Aauth-flow',
      'SummaryNode:community:Community%3Aroutes',
      'SummaryNode:community:Community%3Aroutes:concept:Concept%3Arouting',
    ]);

    const root = graph.getNode('SummaryNode:root');
    expect(root?.properties).toMatchObject({
      name: 'Repository Summary Tree',
      level: 0,
      depth: 0,
      summaryKind: 'root',
      summarizedCommunityIds: ['Community:auth', 'Community:routes'],
      summarizedConceptIds: ['Concept:auth-flow', 'Concept:routing'],
      truncated: false,
    });

    const authSummary = graph.getNode('SummaryNode:community:Community%3Aauth');
    expect(authSummary?.properties).toMatchObject({
      name: 'Summary for Authentication',
      level: 1,
      depth: 1,
      summaryKind: 'community',
      summarizedCommunityIds: ['Community:auth'],
      summarizedConceptIds: ['Concept:auth-flow'],
      memberCount: 1,
      includedMemberCount: 1,
      membersTruncated: false,
    });

    const conceptSummary = graph.getNode(
      'SummaryNode:community:Community%3Aauth:concept:Concept%3Aauth-flow',
    );
    expect(conceptSummary?.properties).toMatchObject({
      name: 'Concept Summary: Auth Flow',
      level: 2,
      depth: 2,
      summaryKind: 'concept',
      summarizedCommunityIds: ['Community:auth'],
      summarizedConceptIds: ['Concept:auth-flow'],
      summarizedNodeIds: ['Function:auth.ts:login'],
      sourceDocuments: ['docs/auth.md'],
    });

    expect(graph.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'SummaryNode:root_summarizes_SummaryNode:community:Community%3Aauth',
          sourceId: 'SummaryNode:root',
          targetId: 'SummaryNode:community:Community%3Aauth',
          type: 'SUMMARIZES',
          reason: 'recursive-summary-tree',
        }),
        expect.objectContaining({
          id: 'SummaryNode:community:Community%3Aauth_summarizes_Community:auth',
          sourceId: 'SummaryNode:community:Community%3Aauth',
          targetId: 'Community:auth',
          type: 'SUMMARIZES',
          reason: 'recursive-summary-tree',
        }),
        expect.objectContaining({
          id: 'SummaryNode:community:Community%3Aauth:concept:Concept%3Aauth-flow_summarizes_Concept:auth-flow',
          sourceId: 'SummaryNode:community:Community%3Aauth:concept:Concept%3Aauth-flow',
          targetId: 'Concept:auth-flow',
          type: 'SUMMARIZES',
          reason: 'recursive-summary-tree',
        }),
      ]),
    );
  });

  it('keeps summary ids and order stable regardless of input ordering', async () => {
    const first = await runOrderingCase(['Community:b', 'Community:a'], ['Concept:z', 'Concept:a']);
    const second = await runOrderingCase(
      ['Community:a', 'Community:b'],
      ['Concept:a', 'Concept:z'],
    );

    expect(first.nodeIds).toEqual(second.nodeIds);
    expect(first.relationshipIds).toEqual(second.relationshipIds);
  });

  it('returns an empty result when community detection found no communities', async () => {
    const graph = createKnowledgeGraph();
    addSymbol(graph, 'Function:auth.ts:login', 'login', 'src/auth.ts');
    addConcept(
      graph,
      'Concept:auth-flow',
      'Auth Flow',
      ['docs/auth.md'],
      ['Function:auth.ts:login'],
    );

    const result = await summaryTreePhase.execute(
      makeCtx(graph),
      makeDeps({ communities: [], memberships: [] }),
    );

    expect(result.summaryResult).toMatchObject({
      totalNodes: 0,
      depth: 0,
      nodes: [],
      truncated: false,
    });
    expect(graph.nodes.filter((node) => node.label === ('SummaryNode' as any))).toHaveLength(0);
  });

  it('integrates with materialized Concept graph nodes without requiring concept phase output', async () => {
    const graph = createKnowledgeGraph();
    addSymbol(graph, 'Function:index.ts:main', 'main', 'src/index.ts');
    addConcept(
      graph,
      'Concept:native-concepts',
      'Native Concepts',
      ['docs/native-concepts.md'],
      ['Function:index.ts:main'],
    );

    const deps = makeDeps({
      communities: [
        {
          id: 'Community:main',
          label: 'Main',
          heuristicLabel: 'Main Entry',
          cohesion: 1,
          symbolCount: 1,
        },
      ],
      memberships: [{ nodeId: 'Function:index.ts:main', communityId: 'Community:main' }],
    });
    deps.set('concepts', { phaseName: 'concepts', output: undefined, durationMs: 0 });

    const result = await summaryTreePhase.execute(makeCtx(graph), deps);

    expect(result.summaryResult.nodes.map((node) => node.id)).toEqual([
      'SummaryNode:root',
      'SummaryNode:community:Community%3Amain',
      'SummaryNode:community:Community%3Amain:concept:Concept%3Anative-concepts',
    ]);
    expect(
      graph.getNode('SummaryNode:community:Community%3Amain:concept:Concept%3Anative-concepts')
        ?.properties,
    ).toMatchObject({
      summarizedConceptIds: ['Concept:native-concepts'],
      sourceDocuments: ['docs/native-concepts.md'],
      sourceFactKeys: ['fact:Concept:native-concepts'],
      authority: 'advisory',
      evidenceClass: 'docs_evidence',
    });
  });
});

async function runOrderingCase(communityOrder: string[], conceptOrder: string[]) {
  const graph = createKnowledgeGraph();
  addSymbol(graph, 'Function:a.ts:handler', 'handlerA', 'src/a.ts');
  addSymbol(graph, 'Function:b.ts:handler', 'handlerB', 'src/b.ts');

  for (const conceptId of conceptOrder) {
    addConcept(
      graph,
      conceptId,
      conceptId.replace('Concept:', 'Concept '),
      [`docs/${conceptId}.md`],
      [conceptId === 'Concept:a' ? 'Function:a.ts:handler' : 'Function:b.ts:handler'],
    );
  }

  const communities = communityOrder.map((id) => ({
    id,
    label: id.replace('Community:', 'Community '),
    heuristicLabel: id.replace('Community:', 'Heuristic '),
    cohesion: 0.5,
    symbolCount: 1,
  }));
  const memberships = communityOrder.map((communityId) => ({
    communityId,
    nodeId: communityId === 'Community:a' ? 'Function:a.ts:handler' : 'Function:b.ts:handler',
  }));

  const result = await summaryTreePhase.execute(
    makeCtx(graph),
    makeDeps({ communities, memberships }),
  );
  return {
    nodeIds: result.summaryResult.nodes.map((node) => node.id),
    relationshipIds: graph.relationships
      .filter((rel) => rel.reason === 'recursive-summary-tree')
      .map((rel) => rel.id)
      .sort(),
  };
}

function makeCtx(graph: KnowledgeGraph): PipelineContext {
  return {
    repoPath: '/repo',
    graph,
    onProgress: () => undefined,
    pipelineStart: Date.now(),
  };
}

function makeDeps(output: CommunitiesOutput['communityResult']): Map<string, PhaseResult<unknown>> {
  return new Map([
    [
      'communities',
      {
        phaseName: 'communities',
        output: { communityResult: output },
        durationMs: 0,
      },
    ],
  ]);
}

function addSymbol(graph: KnowledgeGraph, id: string, name: string, filePath: string) {
  graph.addNode({
    id,
    label: 'Function',
    properties: { name, filePath },
  });
}

function addConcept(
  graph: KnowledgeGraph,
  id: string,
  name: string,
  sourceDocuments: string[],
  targets: string[],
) {
  graph.addNode({
    id,
    label: 'Concept',
    properties: {
      name,
      filePath: sourceDocuments[0] ?? '',
      sourceDocuments,
      sourceFactKeys: [`fact:${id}`],
      authority: 'advisory',
      evidenceClass: 'docs_evidence',
      freshness: 'unknown',
    },
  });

  for (const target of targets) {
    graph.addRelationship({
      id: `${id}_explained_by_${target}`,
      sourceId: id,
      targetId: target,
      type: 'EXPLAINED_BY',
      confidence: 1,
      reason: 'docs-symbol-grounding',
    });
  }
}
