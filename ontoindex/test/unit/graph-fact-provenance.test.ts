import { describe, expect, it } from 'vitest';
import {
  classifyGraphFactProvenance,
  summarizeRelationshipDistributions,
  type CountableRelationship,
} from '../../src/core/graph/fact-provenance.js';

function visitorFor(rels: CountableRelationship[]) {
  return (visit: (rel: CountableRelationship) => void) => {
    for (const rel of rels) visit(rel);
  };
}

describe('classifyGraphFactProvenance', () => {
  it('classifies high-confidence structural CALLS facts as extracted', () => {
    expect(
      classifyGraphFactProvenance({
        relationType: 'CALLS',
        confidence: 0.9,
      }),
    ).toBe('extracted');
  });

  it('classifies high-confidence unknown relations as inferred', () => {
    expect(
      classifyGraphFactProvenance({
        relationType: 'RELATES_TO',
        confidence: 0.9,
      }),
    ).toBe('inferred');
  });

  it('classifies low-confidence facts as ambiguous', () => {
    expect(
      classifyGraphFactProvenance({
        relationType: 'CALLS',
        confidence: 0.49,
      }),
    ).toBe('ambiguous');
  });

  it('classifies stale freshness as ambiguous', () => {
    expect(
      classifyGraphFactProvenance({
        relationType: 'CALLS',
        confidence: 0.95,
        freshness: 'stale-index',
      }),
    ).toBe('ambiguous');
  });

  it('classifies advisory evidence as ambiguous', () => {
    expect(
      classifyGraphFactProvenance({
        relationType: 'CALLS',
        confidence: 0.95,
        evidenceClass: 'advisory_memory',
      }),
    ).toBe('ambiguous');
  });
});

describe('summarizeRelationshipDistributions', () => {
  it('returns zeroed, empty distributions for an empty graph', () => {
    const result = summarizeRelationshipDistributions(visitorFor([]));
    expect(result).toEqual({
      totalRelationships: 0,
      byType: [],
      byProvenance: { extracted: 0, inferred: 0, ambiguous: 0 },
    });
  });

  it('counts a mixed graph with both distributions summing to the total', () => {
    const rels: CountableRelationship[] = [
      { type: 'CALLS', confidence: 0.9 }, // extracted
      { type: 'CALLS', confidence: 0.9 }, // extracted
      { type: 'CALLS', confidence: 0.6 }, // inferred (structural < 0.85)
      { type: 'RELATES_TO', confidence: 0.9 }, // inferred (non-structural)
      { type: 'CALLS', confidence: 0.4 }, // ambiguous (low confidence)
    ];
    const result = summarizeRelationshipDistributions(visitorFor(rels));

    expect(result.totalRelationships).toBe(5);
    expect(result.byProvenance).toEqual({ extracted: 2, inferred: 2, ambiguous: 1 });

    const typeSum = result.byType.reduce((sum, entry) => sum + entry.count, 0);
    const bandSum =
      result.byProvenance.extracted + result.byProvenance.inferred + result.byProvenance.ambiguous;
    expect(typeSum).toBe(result.totalRelationships);
    expect(bandSum).toBe(result.totalRelationships);
  });

  it('buckets missing/empty relation types under UNKNOWN and undefined confidence as ambiguous', () => {
    const rels: CountableRelationship[] = [
      { confidence: 0.9 }, // missing type
      { type: '', confidence: 0.9 }, // empty type
      { type: 'CALLS' }, // undefined confidence -> ambiguous
    ];
    const result = summarizeRelationshipDistributions(visitorFor(rels));

    expect(result.totalRelationships).toBe(3);
    const unknown = result.byType.find((entry) => entry.type === 'UNKNOWN');
    expect(unknown?.count).toBe(2);
    // All three are ambiguous: no relationType -> non-structural inferred path
    // needs confidence >= 0.5, which holds for the first two, so they are
    // inferred; the CALLS-without-confidence is ambiguous.
    expect(result.byProvenance).toEqual({ extracted: 0, inferred: 2, ambiguous: 1 });
    const typeSum = result.byType.reduce((sum, entry) => sum + entry.count, 0);
    expect(typeSum).toBe(result.totalRelationships);
  });

  it('orders byType deterministically by count desc then type asc', () => {
    const rels: CountableRelationship[] = [
      { type: 'IMPORTS', confidence: 0.9 },
      { type: 'CALLS', confidence: 0.9 },
      { type: 'CALLS', confidence: 0.9 },
      { type: 'CONTAINS', confidence: 0.9 },
      { type: 'CONTAINS', confidence: 0.9 },
    ];
    const result = summarizeRelationshipDistributions(visitorFor(rels));
    expect(result.byType).toEqual([
      { type: 'CALLS', count: 2 },
      { type: 'CONTAINS', count: 2 },
      { type: 'IMPORTS', count: 1 },
    ]);
  });
});
