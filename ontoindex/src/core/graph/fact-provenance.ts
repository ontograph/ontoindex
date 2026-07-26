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

/** Relation-type name paired with how many relationships carried it. */
export interface RelationshipTypeCount {
  type: string;
  count: number;
}

/** Counts of relationships in each provenance band. */
export interface RelationshipProvenanceBandCounts {
  extracted: number;
  inferred: number;
  ambiguous: number;
}

/**
 * Bounded aggregate distributions derived from a built graph's relationships.
 *
 * Both `byType` (summed over its `count` values) and the three
 * `byProvenance` bands sum exactly to `totalRelationships`. The vocabularies
 * are fixed (a bounded relation-type union plus three provenance bands), so
 * the aggregate size never grows with repository cardinality.
 */
export interface RelationshipDistributions {
  totalRelationships: number;
  byType: RelationshipTypeCount[];
  byProvenance: RelationshipProvenanceBandCounts;
}

/** Relationship shape needed for counting: only type and confidence. */
export interface CountableRelationship {
  type?: string;
  confidence?: number;
}

/** Bucket for relationships with a missing or empty relation type. */
const UNKNOWN_RELATION_TYPE = 'UNKNOWN';

/**
 * Aggregate bounded relation-type and provenance-band counts in a single pass.
 *
 * `visitEach` is a callback registrar (e.g. `graph.forEachRelationship`) so
 * this makes exactly one pass over existing relationships and retains only
 * aggregate maps — never per-edge provenance. Provenance reuses
 * `classifyGraphFactProvenance` unchanged, passing only `relationType` and
 * `confidence`, so it matches impact-kernel classification byte-for-byte.
 */
export function summarizeRelationshipDistributions(
  visitEach: (visit: (rel: CountableRelationship) => void) => void,
): RelationshipDistributions {
  const typeCounts = new Map<string, number>();
  const byProvenance: RelationshipProvenanceBandCounts = {
    extracted: 0,
    inferred: 0,
    ambiguous: 0,
  };
  let totalRelationships = 0;

  visitEach((rel) => {
    totalRelationships++;
    const type =
      typeof rel.type === 'string' && rel.type.length > 0 ? rel.type : UNKNOWN_RELATION_TYPE;
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    const band = classifyGraphFactProvenance({
      relationType: rel.type,
      confidence: rel.confidence,
    });
    byProvenance[band]++;
  });

  const byType = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.type.localeCompare(b.type)));

  return { totalRelationships, byType, byProvenance };
}
