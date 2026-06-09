import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { CommunitiesOutput } from './communities.js';
import type { GraphNode } from 'ontoindex-shared';

const MAX_COMMUNITY_SUMMARIES = 200;
const MAX_CONCEPT_SUMMARIES_PER_COMMUNITY = 20;
const MAX_PROVENANCE_IDS_PER_SUMMARY = 50;

export interface SummaryTreeNode {
  id: string;
  level: number;
  kind: 'root' | 'community' | 'concept';
  summarizedCommunityIds: string[];
  summarizedConceptIds: string[];
  summarizedNodeIds: string[];
  truncated: boolean;
}

export interface SummaryTreeOutput {
  summaryResult: {
    totalNodes: number;
    depth: number;
    nodes: SummaryTreeNode[];
    truncated: boolean;
    limits: {
      maxCommunitySummaries: number;
      maxConceptSummariesPerCommunity: number;
      maxProvenanceIdsPerSummary: number;
    };
  };
}

export const summaryTreePhase: PipelinePhase<SummaryTreeOutput> = {
  name: 'summary-tree',
  deps: ['communities', 'concepts'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<SummaryTreeOutput> {
    ctx.onProgress({
      phase: 'summary-tree' as any,
      percent: 92,
      message: 'Generating recursive summary tree...',
    });

    const communitiesOut = getPhaseOutput<CommunitiesOutput>(deps, 'communities');
    const allCommunities = [...communitiesOut.communityResult.communities].sort(compareById);

    if (allCommunities.length === 0) {
      return emptySummaryTreeOutput();
    }

    const emittedCommunities = allCommunities.slice(0, MAX_COMMUNITY_SUMMARIES);
    const membershipsByCommunity = groupMemberships(communitiesOut);
    const conceptGroundings = collectConceptGroundings(ctx);
    const summaryNodes: SummaryTreeNode[] = [];
    const emittedConceptIds = new Set<string>();
    let maxDepth = 1;
    let truncated = allCommunities.length > emittedCommunities.length;

    const communityPlans = emittedCommunities.map((comm) => {
      const memberIds = membershipsByCommunity.get(comm.id) ?? [];
      const conceptPlans = conceptGroundings
        .map((concept) => ({
          ...concept,
          groundingIds: concept.groundingIds.filter((id) => memberIds.includes(id)),
        }))
        .filter((concept) => concept.groundingIds.length > 0)
        .sort(compareConceptPlans);
      const emittedConceptPlans = conceptPlans.slice(0, MAX_CONCEPT_SUMMARIES_PER_COMMUNITY);

      if (
        conceptPlans.length > emittedConceptPlans.length ||
        memberIds.length > MAX_PROVENANCE_IDS_PER_SUMMARY
      ) {
        truncated = true;
      }

      emittedConceptPlans.forEach((concept) => emittedConceptIds.add(concept.node.id));

      return {
        comm,
        memberIds,
        conceptPlans,
        emittedConceptPlans,
      };
    });

    const rootId = 'SummaryNode:root';
    addSummaryNode(
      ctx,
      summaryNodes,
      {
        id: rootId,
        level: 0,
        kind: 'root',
        summarizedCommunityIds: emittedCommunities.map((comm) => comm.id),
        summarizedConceptIds: [...emittedConceptIds].sort(),
        summarizedNodeIds: [],
        truncated,
      },
      {
        name: 'Repository Summary Tree',
        depth: 0,
        description:
          'Deterministic recursive summary over detected communities and grounded concepts.',
        omittedCommunityCount: allCommunities.length - emittedCommunities.length,
      },
    );

    for (const plan of communityPlans) {
      const communitySummaryId = summaryId('community', plan.comm.id);
      const communityLabel = plan.comm.heuristicLabel || plan.comm.label;
      const memberProvenance = limitIds(plan.memberIds);

      addSummaryNode(
        ctx,
        summaryNodes,
        {
          id: communitySummaryId,
          level: 1,
          kind: 'community',
          summarizedCommunityIds: [plan.comm.id],
          summarizedConceptIds: plan.emittedConceptPlans.map((concept) => concept.node.id).sort(),
          summarizedNodeIds: memberProvenance.ids,
          truncated:
            plan.conceptPlans.length > plan.emittedConceptPlans.length ||
            plan.memberIds.length > memberProvenance.ids.length,
        },
        {
          name: `Summary for ${communityLabel}`,
          depth: 1,
          description: `Aggregated deterministic summary for community ${communityLabel}.`,
          communityLabel: plan.comm.label,
          heuristicLabel: plan.comm.heuristicLabel,
          cohesion: plan.comm.cohesion,
          symbolCount: plan.comm.symbolCount,
          memberCount: plan.memberIds.length,
          includedMemberCount: memberProvenance.ids.length,
          membersTruncated: plan.memberIds.length > memberProvenance.ids.length,
          conceptCount: plan.conceptPlans.length,
          includedConceptCount: plan.emittedConceptPlans.length,
          conceptsTruncated: plan.conceptPlans.length > plan.emittedConceptPlans.length,
        },
      );
      addSummaryRelationship(ctx, rootId, communitySummaryId);
      addSummaryRelationship(ctx, communitySummaryId, plan.comm.id);

      for (const concept of plan.emittedConceptPlans) {
        const conceptSummaryId = `${communitySummaryId}:concept:${idPart(concept.node.id)}`;
        const groundingProvenance = limitIds(concept.groundingIds);
        maxDepth = 2;

        addSummaryNode(
          ctx,
          summaryNodes,
          {
            id: conceptSummaryId,
            level: 2,
            kind: 'concept',
            summarizedCommunityIds: [plan.comm.id],
            summarizedConceptIds: [concept.node.id],
            summarizedNodeIds: groundingProvenance.ids,
            truncated: concept.groundingIds.length > groundingProvenance.ids.length,
          },
          {
            name: `Concept Summary: ${concept.node.properties.name}`,
            depth: 2,
            description: `Grounded concept summary for ${concept.node.properties.name}.`,
            groundingCount: concept.groundingIds.length,
            includedGroundingCount: groundingProvenance.ids.length,
            groundingsTruncated: concept.groundingIds.length > groundingProvenance.ids.length,
            sourceDocuments: stringArrayProperty(concept.node, 'sourceDocuments'),
            sourceFactKeys: stringArrayProperty(concept.node, 'sourceFactKeys'),
            resolutionKeys: stringArrayProperty(concept.node, 'resolutionKeys'),
            authority: concept.node.properties.authority,
            evidenceClass: concept.node.properties.evidenceClass,
            freshness: concept.node.properties.freshness,
            confidence: concept.node.properties.confidence,
          },
        );
        addSummaryRelationship(ctx, communitySummaryId, conceptSummaryId);
        addSummaryRelationship(ctx, conceptSummaryId, concept.node.id);
      }
    }

    return {
      summaryResult: {
        totalNodes: summaryNodes.length,
        depth: maxDepth,
        nodes: summaryNodes,
        truncated,
        limits: summaryTreeLimits(),
      },
    };
  },
};

interface ConceptGroundingPlan {
  node: GraphNode;
  groundingIds: string[];
}

function emptySummaryTreeOutput(): SummaryTreeOutput {
  return {
    summaryResult: {
      totalNodes: 0,
      depth: 0,
      nodes: [],
      truncated: false,
      limits: summaryTreeLimits(),
    },
  };
}

function summaryTreeLimits(): SummaryTreeOutput['summaryResult']['limits'] {
  return {
    maxCommunitySummaries: MAX_COMMUNITY_SUMMARIES,
    maxConceptSummariesPerCommunity: MAX_CONCEPT_SUMMARIES_PER_COMMUNITY,
    maxProvenanceIdsPerSummary: MAX_PROVENANCE_IDS_PER_SUMMARY,
  };
}

function groupMemberships(communitiesOut: CommunitiesOutput): Map<string, string[]> {
  const membershipsByCommunity = new Map<string, string[]>();
  for (const membership of communitiesOut.communityResult.memberships) {
    const current = membershipsByCommunity.get(membership.communityId) ?? [];
    current.push(membership.nodeId);
    membershipsByCommunity.set(membership.communityId, current);
  }

  for (const [communityId, memberIds] of membershipsByCommunity) {
    membershipsByCommunity.set(communityId, [...new Set(memberIds)].sort());
  }
  return membershipsByCommunity;
}

function collectConceptGroundings(ctx: PipelineContext): ConceptGroundingPlan[] {
  return ctx.graph.nodes
    .filter((node) => node.label === 'Concept')
    .map((node) => ({
      node,
      groundingIds: ctx.graph.relationships
        .filter((rel) => rel.type === 'EXPLAINED_BY' && rel.sourceId === node.id)
        .map((rel) => rel.targetId)
        .sort(),
    }))
    .filter((concept) => concept.groundingIds.length > 0)
    .sort(compareConceptPlans);
}

function addSummaryNode(
  ctx: PipelineContext,
  summaryNodes: SummaryTreeNode[],
  node: SummaryTreeNode,
  properties: Record<string, unknown>,
) {
  ctx.graph.addNode({
    id: node.id,
    label: 'SummaryNode' as any,
    properties: {
      filePath: '',
      level: node.level,
      summaryKind: node.kind,
      summarizedCommunityIds: node.summarizedCommunityIds,
      summarizedConceptIds: node.summarizedConceptIds,
      summarizedNodeIds: node.summarizedNodeIds,
      truncated: node.truncated,
      ...properties,
    } as any,
  });
  summaryNodes.push(node);
}

function addSummaryRelationship(ctx: PipelineContext, sourceId: string, targetId: string) {
  ctx.graph.addRelationship({
    id: `${sourceId}_summarizes_${targetId}`,
    type: 'SUMMARIZES' as any,
    sourceId,
    targetId,
    confidence: 1.0,
    reason: 'recursive-summary-tree',
  });
}

function limitIds(ids: string[]): { ids: string[]; omitted: number } {
  const limitedIds = [...new Set(ids)].sort().slice(0, MAX_PROVENANCE_IDS_PER_SUMMARY);
  return {
    ids: limitedIds,
    omitted: Math.max(0, ids.length - limitedIds.length),
  };
}

function summaryId(kind: string, id: string): string {
  return `SummaryNode:${kind}:${idPart(id)}`;
}

function idPart(id: string): string {
  return encodeURIComponent(id);
}

function stringArrayProperty(node: GraphNode, key: string): string[] {
  const value = node.properties[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string').sort();
}

function compareById<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function compareConceptPlans(left: ConceptGroundingPlan, right: ConceptGroundingPlan): number {
  return left.node.id.localeCompare(right.node.id);
}
