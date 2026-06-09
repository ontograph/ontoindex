export type MarkdownDocumentPprNodeType =
  | 'doc'
  | 'section'
  | 'chunk'
  | 'entity'
  | 'link'
  | 'mention';

export interface MarkdownDocumentPprNode {
  id: string;
  type: MarkdownDocumentPprNodeType | string;
  stale?: boolean;
}

export interface MarkdownDocumentPprEdge {
  from: string;
  to: string;
  type: string;
  weight?: number;
}

export type MarkdownDocumentPprSkipReason =
  | 'seed-not-found'
  | 'seed-type-not-allowed'
  | 'stale-fact'
  | 'edge-type-not-allowed'
  | 'node-type-not-allowed'
  | 'max-hops-exceeded'
  | 'max-visited-nodes-exceeded'
  | 'invalid-edge-weight';

export interface MarkdownDocumentPprOptions {
  seedIds: readonly string[];
  allowedNodeTypes: readonly MarkdownDocumentPprNodeType[];
  topK: number;
  maxHops: number;
  maxVisitedNodes: number;
  restartProbability: number;
  iterations?: number;
}

export interface MarkdownDocumentPprResult {
  rankedIds: Array<{
    id: string;
    type: MarkdownDocumentPprNodeType;
    score: number;
  }>;
  skipped: Array<{
    id?: string;
    edgeType?: string;
    reason: MarkdownDocumentPprSkipReason;
    detail?: string;
  }>;
  summary: {
    seedIds: string[];
    topK: number;
    maxHops: number;
    maxVisitedNodes: number;
    restartProbability: number;
    visitedCount: number;
    degraded: boolean;
    degradedReasons: Partial<Record<MarkdownDocumentPprSkipReason, number>>;
  };
  explanation: {
    retrievers: Array<{
      name: 'markdown-passive-graph';
      seedIds: string[];
      traversedNodeTypes: MarkdownDocumentPprNodeType[];
      restartProbability: number;
      visitedCount: number;
      skipped: MarkdownDocumentPprResult['skipped'];
    }>;
  };
}

const AUTHORITY_EDGE_TYPES = new Set([
  'call',
  'calls',
  'import',
  'imports',
  'reference',
  'references',
  'impact',
  'impacts',
  'ownership',
  'owns',
]);

const DOCUMENT_EDGE_TYPES = new Set([
  'contains',
  'has-section',
  'has-chunk',
  'mentions',
  'cites',
  'links-to',
  'same-doc',
  'same-section',
  'has-entity',
  'entity-source',
  'mention-source',
  'documents',
  'describes',
]);

export function runMarkdownDocumentPpr(
  nodes: readonly MarkdownDocumentPprNode[],
  edges: readonly MarkdownDocumentPprEdge[],
  options: MarkdownDocumentPprOptions,
): MarkdownDocumentPprResult {
  const topK = normalizePositiveInteger(options.topK, 'topK');
  const maxHops = normalizeNonNegativeInteger(options.maxHops, 'maxHops');
  const maxVisitedNodes = normalizePositiveInteger(options.maxVisitedNodes, 'maxVisitedNodes');
  const restartProbability = normalizeRestartProbability(options.restartProbability);
  const iterations = options.iterations ?? 12;
  const allowedTypes = new Set(options.allowedNodeTypes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const skipped: MarkdownDocumentPprResult['skipped'] = [];
  const degradedReasons: Partial<Record<MarkdownDocumentPprSkipReason, number>> = {};
  const visited = new Set<string>();
  const frontier: Array<{ id: string; hop: number }> = [];
  const acceptedSeedIds: string[] = [];

  for (const seedId of unique(options.seedIds).sort()) {
    const node = nodeById.get(seedId);
    if (node === undefined) {
      addSkip(skipped, degradedReasons, { id: seedId, reason: 'seed-not-found' });
      continue;
    }
    if (!isAllowedNode(node, allowedTypes)) {
      addSkip(skipped, degradedReasons, { id: seedId, reason: 'seed-type-not-allowed' });
      continue;
    }
    if (node.stale === true) {
      addSkip(skipped, degradedReasons, { id: seedId, reason: 'stale-fact' });
      continue;
    }
    acceptedSeedIds.push(seedId);
    if (visited.size < maxVisitedNodes) {
      visited.add(seedId);
      frontier.push({ id: seedId, hop: 0 });
    }
  }

  const outgoing = buildOutgoing(edges);
  for (let index = 0; index < frontier.length; index += 1) {
    const current = frontier[index];
    if (current.hop >= maxHops) {
      addSkip(skipped, degradedReasons, { id: current.id, reason: 'max-hops-exceeded' });
      continue;
    }

    for (const edge of outgoing.get(current.id) ?? []) {
      const target = nodeById.get(edge.to);
      if (isAuthorityEdge(edge.type) || !DOCUMENT_EDGE_TYPES.has(edge.type)) {
        addSkip(skipped, degradedReasons, {
          id: edge.to,
          edgeType: edge.type,
          reason: 'edge-type-not-allowed',
        });
        continue;
      }
      if (!Number.isFinite(edge.weight ?? 1) || (edge.weight ?? 1) <= 0) {
        addSkip(skipped, degradedReasons, {
          id: edge.to,
          edgeType: edge.type,
          reason: 'invalid-edge-weight',
        });
        continue;
      }
      if (target === undefined || !isAllowedNode(target, allowedTypes)) {
        addSkip(skipped, degradedReasons, {
          id: edge.to,
          edgeType: edge.type,
          reason: 'node-type-not-allowed',
          detail: target?.type,
        });
        continue;
      }
      if (target.stale === true) {
        addSkip(skipped, degradedReasons, { id: target.id, reason: 'stale-fact' });
        continue;
      }
      if (visited.has(target.id)) continue;
      if (visited.size >= maxVisitedNodes) {
        addSkip(skipped, degradedReasons, {
          id: target.id,
          edgeType: edge.type,
          reason: 'max-visited-nodes-exceeded',
        });
        continue;
      }
      visited.add(target.id);
      frontier.push({ id: target.id, hop: current.hop + 1 });
    }
  }

  const scores = scoreVisitedNodes(visited, outgoing, nodeById, allowedTypes, {
    restartProbability,
    iterations,
    seedIds: acceptedSeedIds,
  });
  const rankedIds = [...visited]
    .map((id) => ({
      id,
      type: nodeById.get(id)?.type as MarkdownDocumentPprNodeType,
      score: scores.get(id) ?? 0,
    }))
    .filter((item) => item.type !== undefined)
    .sort(compareRanked)
    .slice(0, topK)
    .map((item) => ({ ...item, score: roundScore(item.score) }));
  const traversedNodeTypes = unique(
    [...visited]
      .map((id) => nodeById.get(id)?.type)
      .filter((type): type is MarkdownDocumentPprNodeType => type !== undefined),
  ).sort();

  return {
    rankedIds,
    skipped,
    summary: {
      seedIds: acceptedSeedIds,
      topK,
      maxHops,
      maxVisitedNodes,
      restartProbability,
      visitedCount: visited.size,
      degraded: skipped.length > 0,
      degradedReasons,
    },
    explanation: {
      retrievers: [
        {
          name: 'markdown-passive-graph',
          seedIds: acceptedSeedIds,
          traversedNodeTypes,
          restartProbability,
          visitedCount: visited.size,
          skipped,
        },
      ],
    },
  };
}

function buildOutgoing(
  edges: readonly MarkdownDocumentPprEdge[],
): Map<string, MarkdownDocumentPprEdge[]> {
  const outgoing = new Map<string, MarkdownDocumentPprEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  for (const list of outgoing.values()) {
    list.sort((left, right) =>
      [left.type, left.to, String(left.weight ?? 1)]
        .join('\0')
        .localeCompare([right.type, right.to, String(right.weight ?? 1)].join('\0')),
    );
  }
  return outgoing;
}

function scoreVisitedNodes(
  visited: Set<string>,
  outgoing: Map<string, MarkdownDocumentPprEdge[]>,
  nodeById: Map<string, MarkdownDocumentPprNode>,
  allowedTypes: Set<MarkdownDocumentPprNodeType>,
  options: { restartProbability: number; iterations: number; seedIds: readonly string[] },
): Map<string, number> {
  const ids = [...visited].sort();
  const seedMass = new Map<string, number>();
  for (const seedId of options.seedIds) {
    if (visited.has(seedId)) {
      seedMass.set(seedId, 1 / options.seedIds.length);
    }
  }
  let scores = new Map(ids.map((id) => [id, seedMass.get(id) ?? 0]));

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const next = new Map(
      ids.map((id) => [id, options.restartProbability * (seedMass.get(id) ?? 0)]),
    );
    for (const id of ids) {
      const score = scores.get(id) ?? 0;
      const allowedEdges = (outgoing.get(id) ?? []).filter((edge) => {
        const target = nodeById.get(edge.to);
        return (
          visited.has(edge.to) &&
          !isAuthorityEdge(edge.type) &&
          DOCUMENT_EDGE_TYPES.has(edge.type) &&
          target !== undefined &&
          isAllowedNode(target, allowedTypes) &&
          target.stale !== true &&
          Number.isFinite(edge.weight ?? 1) &&
          (edge.weight ?? 1) > 0
        );
      });
      const totalWeight = allowedEdges.reduce((sum, edge) => sum + (edge.weight ?? 1), 0);
      if (allowedEdges.length === 0 || totalWeight <= 0) {
        next.set(id, (next.get(id) ?? 0) + (1 - options.restartProbability) * score);
        continue;
      }
      for (const edge of allowedEdges) {
        const share = ((edge.weight ?? 1) / totalWeight) * (1 - options.restartProbability) * score;
        next.set(edge.to, (next.get(edge.to) ?? 0) + share);
      }
    }
    scores = next;
  }
  return scores;
}

function isAllowedNode(
  node: MarkdownDocumentPprNode,
  allowedTypes: Set<MarkdownDocumentPprNodeType>,
): node is MarkdownDocumentPprNode & { type: MarkdownDocumentPprNodeType } {
  return allowedTypes.has(node.type as MarkdownDocumentPprNodeType);
}

function isAuthorityEdge(edgeType: string): boolean {
  return AUTHORITY_EDGE_TYPES.has(edgeType.toLowerCase());
}

function compareRanked(
  left: { id: string; type: MarkdownDocumentPprNodeType; score: number },
  right: { id: string; type: MarkdownDocumentPprNodeType; score: number },
): number {
  if (right.score !== left.score) return right.score - left.score;
  if (left.type !== right.type) return left.type.localeCompare(right.type);
  return left.id.localeCompare(right.id);
}

function addSkip(
  skipped: MarkdownDocumentPprResult['skipped'],
  degradedReasons: Partial<Record<MarkdownDocumentPprSkipReason, number>>,
  skip: MarkdownDocumentPprResult['skipped'][number],
): void {
  skipped.push(skip);
  degradedReasons[skip.reason] = (degradedReasons[skip.reason] ?? 0) + 1;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function roundScore(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function normalizeRestartProbability(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error('restartProbability must be greater than 0 and less than 1');
  }
  return value;
}
