export type GraphFactProvenance = 'extracted' | 'inferred' | 'ambiguous';

export interface GraphFactProvenanceInput {
  relationType?: string;
  confidence?: number;
  evidenceClass?: string;
  authority?: string;
  freshness?: string;
}

const STRUCTURAL_RELATIONS = new Set([
  'CALLS',
  'IMPORTS',
  'CONTAINS',
  'DEFINES',
  'EXTENDS',
  'IMPLEMENTS',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'METHOD_OVERRIDES',
  'METHOD_IMPLEMENTS',
]);

function containsAny(value: string | undefined, tokens: readonly string[]): boolean {
  if (!value) return false;
  const lowerValue = value.toLowerCase();
  return tokens.some((token) => lowerValue.includes(token));
}

export function classifyGraphFactProvenance(input: GraphFactProvenanceInput): GraphFactProvenance {
  if (containsAny(input.freshness, ['stale', 'dirty', 'unknown', 'degraded'])) {
    return 'ambiguous';
  }

  if (containsAny(input.evidenceClass, ['advisory', 'runtime_diagnostic'])) {
    return 'ambiguous';
  }

  if (containsAny(input.authority, ['advisory', 'runtime_diagnostic'])) {
    return 'ambiguous';
  }

  if (
    typeof input.confidence !== 'number' ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0.5
  ) {
    return 'ambiguous';
  }

  const relationType = input.relationType?.toUpperCase();
  if (relationType !== undefined && STRUCTURAL_RELATIONS.has(relationType)) {
    return input.confidence >= 0.85 ? 'extracted' : 'inferred';
  }

  return 'inferred';
}
