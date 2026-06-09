export type PrimaryGraphPromotionGate =
  | 'sidecar-release'
  | 'false-positive-baseline'
  | 'shared-migration'
  | 'web-fallback'
  | 'query-context-impact-compatibility'
  | 'package-migration-tests';

export type PromotablePrimaryGraphNodeLabel =
  | 'Resource'
  | 'Constraint'
  | 'State'
  | 'Lock'
  | 'AuditFinding'
  | 'AbiContract';

export type PromotablePrimaryGraphEdgeType =
  | 'ALLOCATES_RESOURCE'
  | 'DUPLICATES_RESOURCE'
  | 'CLOSES_RESOURCE'
  | 'HANDS_OFF_RESOURCE'
  | 'INHERITS_RESOURCE'
  | 'CONSTRAINS';

export interface GraphPromotionReviewInput {
  completedGates: readonly PrimaryGraphPromotionGate[];
  requestedNodeLabels?: readonly PromotablePrimaryGraphNodeLabel[];
  requestedEdgeTypes?: readonly PromotablePrimaryGraphEdgeType[];
}

export interface GraphPromotionReviewDecision {
  allowed: boolean;
  missingGates: PrimaryGraphPromotionGate[];
  refusedNodeLabels: PromotablePrimaryGraphNodeLabel[];
  refusedEdgeTypes: PromotablePrimaryGraphEdgeType[];
  reason: string;
}

export const PRIMARY_GRAPH_PROMOTION_GATES: readonly PrimaryGraphPromotionGate[] = [
  'sidecar-release',
  'false-positive-baseline',
  'shared-migration',
  'web-fallback',
  'query-context-impact-compatibility',
  'package-migration-tests',
];

export const PROMOTABLE_PRIMARY_GRAPH_NODE_LABELS: readonly PromotablePrimaryGraphNodeLabel[] = [
  'Resource',
  'Constraint',
  'State',
  'Lock',
  'AuditFinding',
  'AbiContract',
];

export const PROMOTABLE_PRIMARY_GRAPH_EDGE_TYPES: readonly PromotablePrimaryGraphEdgeType[] = [
  'ALLOCATES_RESOURCE',
  'DUPLICATES_RESOURCE',
  'CLOSES_RESOURCE',
  'HANDS_OFF_RESOURCE',
  'INHERITS_RESOURCE',
  'CONSTRAINS',
];

export function evaluatePrimaryGraphPromotionReview(
  input: GraphPromotionReviewInput,
): GraphPromotionReviewDecision {
  const completed = new Set(input.completedGates);
  const missingGates = PRIMARY_GRAPH_PROMOTION_GATES.filter((gate) => !completed.has(gate));
  const requestedNodeLabels = [
    ...(input.requestedNodeLabels ?? PROMOTABLE_PRIMARY_GRAPH_NODE_LABELS),
  ];
  const requestedEdgeTypes = [...(input.requestedEdgeTypes ?? PROMOTABLE_PRIMARY_GRAPH_EDGE_TYPES)];
  const allowed = missingGates.length === 0;

  return {
    allowed,
    missingGates,
    refusedNodeLabels: allowed ? [] : requestedNodeLabels,
    refusedEdgeTypes: allowed ? [] : requestedEdgeTypes,
    reason: allowed
      ? 'Primary graph promotion gates are satisfied.'
      : `Primary graph promotion refused until gates are present: ${missingGates.join(', ')}.`,
  };
}
