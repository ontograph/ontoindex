import { describe, expect, it } from 'vitest';

import {
  PRIMARY_GRAPH_PROMOTION_GATES,
  evaluatePrimaryGraphPromotionReview,
} from '../../src/core/systems-audit/graph-promotion-review.js';

describe('systems graph promotion review gate', () => {
  it('refuses Resource/Constraint/Lock promotion until all S7 gates are present', () => {
    const decision = evaluatePrimaryGraphPromotionReview({
      completedGates: ['sidecar-release', 'false-positive-baseline'],
      requestedNodeLabels: ['Resource', 'Constraint', 'Lock'],
      requestedEdgeTypes: ['ALLOCATES_RESOURCE', 'HANDS_OFF_RESOURCE', 'CONSTRAINS'],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.missingGates).toEqual([
      'shared-migration',
      'web-fallback',
      'query-context-impact-compatibility',
      'package-migration-tests',
    ]);
    expect(decision.refusedNodeLabels).toEqual(['Resource', 'Constraint', 'Lock']);
    expect(decision.refusedEdgeTypes).toContain('HANDS_OFF_RESOURCE');
  });

  it('requires sidecar release, false-positive baseline, migrations, fallbacks, compatibility, and package tests', () => {
    const decision = evaluatePrimaryGraphPromotionReview({
      completedGates: PRIMARY_GRAPH_PROMOTION_GATES,
      requestedNodeLabels: ['Resource'],
      requestedEdgeTypes: ['CLOSES_RESOURCE'],
    });

    expect(decision.allowed).toBe(true);
    expect(decision.missingGates).toEqual([]);
    expect(decision.refusedNodeLabels).toEqual([]);
    expect(decision.refusedEdgeTypes).toEqual([]);
  });
});
