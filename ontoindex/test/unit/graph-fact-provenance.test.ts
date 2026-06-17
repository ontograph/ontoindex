import { describe, expect, it } from 'vitest';
import { classifyGraphFactProvenance } from '../../src/core/graph/fact-provenance.js';

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
