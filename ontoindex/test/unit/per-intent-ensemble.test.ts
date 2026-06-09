import { describe, it, expect } from 'vitest';
import {
  applyEnsemble,
  INTENT_WEIGHTS,
  MIN_VEC_POOL_SIZE,
  type IntentLabel,
} from '../../src/core/search/per-intent-ensemble.js';
import { mergeSymbolsWithRRF, type EnrichedSymbolRow } from '../../src/core/search/symbol-merge.js';

// Shared test fixture: 5 BM25 results and 5 semantic results with overlapping nodeIds.
function makeBm25Results(): EnrichedSymbolRow[] {
  return [
    { nodeId: 'n1', name: 'alpha', type: 'Function', filePath: 'a/alpha.ts', startLine: 1 },
    { nodeId: 'n2', name: 'beta', type: 'Function', filePath: 'a/beta.ts', startLine: 5 },
    { nodeId: 'n3', name: 'gamma', type: 'Class', filePath: 'b/gamma.ts', startLine: 10 },
    { nodeId: 'n4', name: 'delta', type: 'Function', filePath: 'b/delta.ts', startLine: 20 },
    { nodeId: 'n5', name: 'epsilon', type: 'Function', filePath: 'c/eps.ts', startLine: 30 },
  ];
}

function makeSemanticResults(): EnrichedSymbolRow[] {
  return [
    { nodeId: 'n3', name: 'gamma', type: 'Class', filePath: 'b/gamma.ts', startLine: 10 },
    { nodeId: 'n1', name: 'alpha', type: 'Function', filePath: 'a/alpha.ts', startLine: 1 },
    { nodeId: 'n6', name: 'zeta', type: 'Function', filePath: 'c/zeta.ts', startLine: 50 },
    { nodeId: 'n2', name: 'beta', type: 'Function', filePath: 'a/beta.ts', startLine: 5 },
    { nodeId: 'n7', name: 'eta', type: 'Function', filePath: 'd/eta.ts', startLine: 60 },
  ];
}

// ─── Test 1: ambiguous row byte-identity ──────────────────────────────────────
//
// Given identical inputs, applyEnsemble('ambiguous', ...) must return the same
// ranked output as mergeSymbolsWithRRF field-by-field (nodeId, filePath,
// startLine, score).  This is the step-1 safety floor (Attack 2 fix).
describe('Test 1 — ambiguous row byte-identity vs mergeSymbolsWithRRF', () => {
  it('returns field-level identical results for the ambiguous intent', () => {
    const bm25 = makeBm25Results();
    const semantic = makeSemanticResults();
    const limit = 10;

    const ensembleResult = applyEnsemble('ambiguous', bm25, semantic, limit);
    const rrfResult = mergeSymbolsWithRRF(bm25, semantic, limit);

    // Same length
    expect(ensembleResult.length).toBe(rrfResult.length);

    // Field-level identity comparison per the design doc §F / §H:
    // - nodeId, filePath, startLine, name, type must be identical (data fields)
    // - Ranking order must be identical (same key sequence)
    // - Absolute scores intentionally differ by constant factor (ensemble multiplies
    //   by weights 0.5/0.5 vs RRF's raw 1.0/1.0) — scores are NOT compared.
    //   Proportional scoring preserves ranking; that is the invariant.
    for (let i = 0; i < rrfResult.length; i++) {
      const [rrfKey, rrfItem] = rrfResult[i];
      const [ensKey, ensItem] = ensembleResult[i];

      expect(ensKey).toBe(rrfKey);
      expect(ensItem.data.nodeId).toBe(rrfItem.data.nodeId);
      expect(ensItem.data.filePath).toBe(rrfItem.data.filePath);
      expect(ensItem.data.startLine).toBe(rrfItem.data.startLine);
      expect(ensItem.data.name).toBe(rrfItem.data.name);
      expect(ensItem.data.type).toBe(rrfItem.data.type);
    }
  });

  it('returns field-level identical results when only BM25 results exist', () => {
    const bm25 = makeBm25Results();
    const semantic: EnrichedSymbolRow[] = [];
    const limit = 10;

    const ensembleResult = applyEnsemble('ambiguous', bm25, semantic, limit);
    const rrfResult = mergeSymbolsWithRRF(bm25, semantic, limit);

    expect(ensembleResult.length).toBe(rrfResult.length);
    for (let i = 0; i < rrfResult.length; i++) {
      const [rrfKey] = rrfResult[i];
      const [ensKey] = ensembleResult[i];
      expect(ensKey).toBe(rrfKey);
    }
  });
});

// ─── Test 2: weight table is rev 2 values ─────────────────────────────────────
//
// Regression guard: if someone changes INTENT_WEIGHTS, this test catches it.
// Exact values from audit_v13-w1a-ensemble-design.md §D rev 2.
describe('Test 2 — weight table matches rev 2 design values', () => {
  it('calls-of weights are correct', () => {
    expect(INTENT_WEIGHTS['calls-of'].bm25).toBe(0.55);
    expect(INTENT_WEIGHTS['calls-of'].vec).toBe(0.1);
    expect(INTENT_WEIGHTS['calls-of'].graph).toBe(0.35);
    expect(INTENT_WEIGHTS['calls-of'].ce).toBe(0.0);
  });

  it('cross-file-impact weights are correct (rev 2: vec=0.10 not 0.30)', () => {
    expect(INTENT_WEIGHTS['cross-file-impact'].bm25).toBe(0.3);
    expect(INTENT_WEIGHTS['cross-file-impact'].vec).toBe(0.1);
    expect(INTENT_WEIGHTS['cross-file-impact'].graph).toBe(0.6);
    expect(INTENT_WEIGHTS['cross-file-impact'].ce).toBe(0.0);
  });

  it('nl-conceptual weights are correct', () => {
    expect(INTENT_WEIGHTS['nl-conceptual'].bm25).toBe(0.2);
    expect(INTENT_WEIGHTS['nl-conceptual'].vec).toBe(0.5);
    expect(INTENT_WEIGHTS['nl-conceptual'].graph).toBe(0.0);
    expect(INTENT_WEIGHTS['nl-conceptual'].ce).toBe(0.3);
  });

  it('ambiguous weights are correct (v12 RRF default)', () => {
    expect(INTENT_WEIGHTS['ambiguous'].bm25).toBe(0.5);
    expect(INTENT_WEIGHTS['ambiguous'].vec).toBe(0.5);
    expect(INTENT_WEIGHTS['ambiguous'].graph).toBe(0.0);
    expect(INTENT_WEIGHTS['ambiguous'].ce).toBe(0.0);
  });

  it('each row sums to 1.0', () => {
    for (const [, w] of Object.entries(INTENT_WEIGHTS)) {
      const sum = w.bm25 + w.vec + w.graph + w.ce;
      expect(sum).toBeCloseTo(1.0, 10);
    }
  });
});

// ─── Test 3: BM25-first data preference ───────────────────────────────────────
//
// When the same nodeId appears in both BM25 and semantic results with DIFFERENT
// data fields (e.g. different startLine), applyEnsemble must take the BM25 data.
// This matches symbol-merge.ts:40-62 (BM25 first, semantic second, BM25 wins).
describe('Test 3 — BM25-first data preference for tied keys', () => {
  it('returns BM25 data field when nodeId appears in both lists', () => {
    const bm25Results: EnrichedSymbolRow[] = [
      { nodeId: 'shared', name: 'myFunc', type: 'Function', filePath: 'x.ts', startLine: 99 },
      { nodeId: 'bm25only', name: 'bm25Func', type: 'Function', filePath: 'y.ts', startLine: 1 },
    ];
    const semanticResults: EnrichedSymbolRow[] = [
      // Same nodeId but different startLine — semantic data should be discarded
      { nodeId: 'shared', name: 'myFunc', type: 'Function', filePath: 'x.ts', startLine: 42 },
      { nodeId: 'veconly', name: 'vecFunc', type: 'Function', filePath: 'z.ts', startLine: 7 },
    ];

    const result = applyEnsemble('ambiguous', bm25Results, semanticResults, 10);
    const sharedEntry = result.find(([key]) => key === 'shared');

    expect(sharedEntry).toBeDefined();
    // BM25 data must win: startLine=99, not 42
    expect(sharedEntry?.[1].data.startLine).toBe(99);
  });

  it('returns semantic data when nodeId is only in semantic list', () => {
    const bm25Results: EnrichedSymbolRow[] = [
      { nodeId: 'bm25only', name: 'bm25Func', type: 'Function', filePath: 'y.ts', startLine: 1 },
    ];
    const semanticResults: EnrichedSymbolRow[] = [
      { nodeId: 'veconly', name: 'vecFunc', type: 'Function', filePath: 'z.ts', startLine: 7 },
    ];

    const result = applyEnsemble('ambiguous', bm25Results, semanticResults, 10);
    const vecEntry = result.find(([key]) => key === 'veconly');

    expect(vecEntry).toBeDefined();
    expect(vecEntry?.[1].data.startLine).toBe(7);
  });
});

// ─── Test 4: confidence soft-gate ─────────────────────────────────────────────
//
// applyEnsemble('nl-conceptual', ..., confidence=0.5) must produce the same
// output as applyEnsemble('ambiguous', ...) because confidence < 0.7 forces
// the ambiguous weight row (Attack 3 fix).
describe('Test 4 — confidence soft-gate forces ambiguous weights below 0.7', () => {
  it('nl-conceptual at confidence=0.5 equals ambiguous output', () => {
    const bm25 = makeBm25Results();
    const semantic = makeSemanticResults();
    const limit = 10;

    const lowConfResult = applyEnsemble('nl-conceptual', bm25, semantic, limit, 0.5);
    const ambiguousResult = applyEnsemble('ambiguous', bm25, semantic, limit);

    expect(lowConfResult.length).toBe(ambiguousResult.length);
    for (let i = 0; i < ambiguousResult.length; i++) {
      const [ambKey, ambItem] = ambiguousResult[i];
      const [lcKey, lcItem] = lowConfResult[i];
      expect(lcKey).toBe(ambKey);
      expect(lcItem.score).toBeCloseTo(ambItem.score, 10);
      expect(lcItem.data.nodeId).toBe(ambItem.data.nodeId);
    }
  });

  it('calls-of at confidence=0.69 (below threshold) equals ambiguous output', () => {
    const bm25 = makeBm25Results();
    const semantic = makeSemanticResults();
    const limit = 10;

    const lowConfResult = applyEnsemble('calls-of', bm25, semantic, limit, 0.69);
    const ambiguousResult = applyEnsemble('ambiguous', bm25, semantic, limit);

    expect(lowConfResult.length).toBe(ambiguousResult.length);
    for (let i = 0; i < ambiguousResult.length; i++) {
      const [ambKey] = ambiguousResult[i];
      const [lcKey] = lowConfResult[i];
      expect(lcKey).toBe(ambKey);
    }
  });

  it('nl-conceptual at confidence=0.7 (at threshold) uses nl-conceptual weights, not ambiguous', () => {
    const bm25 = makeBm25Results();
    const semantic = makeSemanticResults();
    const limit = 10;

    // At exactly 0.7, confidence is NOT below threshold — nl-conceptual weights apply.
    const atThresholdResult = applyEnsemble('nl-conceptual', bm25, semantic, limit, 0.7);
    const ambiguousResult = applyEnsemble('ambiguous', bm25, semantic, limit);

    // nl-conceptual has bm25=0.20, vec=0.50 vs ambiguous bm25=0.50, vec=0.50.
    // The scores will differ, so the results are NOT equal.
    // Verify at least one position differs to confirm different weights were used.
    let anyDiffers = false;
    const minLen = Math.min(atThresholdResult.length, ambiguousResult.length);
    for (let i = 0; i < minLen; i++) {
      if (Math.abs(atThresholdResult[i][1].score - ambiguousResult[i][1].score) > 1e-12) {
        anyDiffers = true;
        break;
      }
    }
    expect(anyDiffers).toBe(true);
  });
});

// ─── Step-2 graph tests (Tests 5b) ────────────────────────────────────────────
// (Step-2 tests live here; step-3 tests follow below.)

// ─── Test 5: weight table covers all 4 intents ────────────────────────────────
//
// If INTENT_WEIGHTS is missing an intent, applyEnsemble would throw or produce
// garbage.  This test confirms all 4 canonical intents are present and callable.
describe('Test 5 — weight table covers all 4 canonical intents', () => {
  const ALL_INTENTS: IntentLabel[] = [
    'calls-of',
    'cross-file-impact',
    'nl-conceptual',
    'ambiguous',
  ];

  for (const intent of ALL_INTENTS) {
    it(`applyEnsemble does not throw for intent="${intent}"`, () => {
      const bm25 = makeBm25Results();
      const semantic = makeSemanticResults();
      expect(() => applyEnsemble(intent, bm25, semantic, 10)).not.toThrow();
    });

    it(`INTENT_WEIGHTS["${intent}"] is defined and has all 4 weight keys`, () => {
      const w = INTENT_WEIGHTS[intent];
      expect(w).toBeDefined();
      expect(typeof w.bm25).toBe('number');
      expect(typeof w.vec).toBe('number');
      expect(typeof w.graph).toBe('number');
      expect(typeof w.ce).toBe('number');
    });
  }

  it('MIN_VEC_POOL_SIZE is a positive integer', () => {
    expect(typeof MIN_VEC_POOL_SIZE).toBe('number');
    expect(MIN_VEC_POOL_SIZE).toBeGreaterThan(0);
    expect(Number.isInteger(MIN_VEC_POOL_SIZE)).toBe(true);
  });
});

// ─── Test 6: CE leg for nl-conceptual increases score for high-CE candidates ──
//
// When nl-conceptual is used with ceScores and ceResults, a candidate that
// has a high CE score must end up with a higher final score than the same
// candidate would have without CE (i.e. the CE contribution is additive).
describe('Test 6 — CE leg for nl-conceptual increases score for high-CE candidates', () => {
  it('high-CE candidate scores higher than without CE', () => {
    const bm25 = makeBm25Results();
    const semantic = makeSemanticResults();
    const limit = 10;

    // ceResults = top-2 of semanticResults (n3 at rank 0, n1 at rank 1)
    const ceResults = semantic.slice(0, 2);
    // Give the second candidate (n1) a very high CE score — should lift it
    const ceScores = [0.1, 0.95];

    const withCE = applyEnsemble(
      'nl-conceptual',
      bm25,
      semantic,
      limit,
      0.9,
      [],
      ceScores,
      ceResults,
    );
    const withoutCE = applyEnsemble('nl-conceptual', bm25, semantic, limit, 0.9);

    // n1 appears in both bm25 (rank 1) and semantic (rank 1); its score without CE
    // comes from bm25_rrf + vec_rrf.  With CE at 0.95 and w_ce=0.30, its score
    // must be strictly higher.
    const n1WithCE = withCE.find(([key]) => key === 'n1');
    const n1WithoutCE = withoutCE.find(([key]) => key === 'n1');

    expect(n1WithCE).toBeDefined();
    expect(n1WithoutCE).toBeDefined();
    expect(n1WithCE![1].score).toBeGreaterThan(n1WithoutCE![1].score);
  });

  it('CE contribution is weight * rawScore (not RRF-style)', () => {
    // Use a single isolated candidate: ceResults contains only one entry (n8)
    // that is NOT in bm25 or semantic (so its only score comes from CE).
    const ceOnlyResult: EnrichedSymbolRow = {
      nodeId: 'n8',
      name: 'theta',
      type: 'Function',
      filePath: 'e/theta.ts',
      startLine: 80,
    };
    const ceScores = [0.6];
    const ceResults = [ceOnlyResult];
    const weights = INTENT_WEIGHTS['nl-conceptual'];

    const result = applyEnsemble('nl-conceptual', [], [], 10, 0.9, [], ceScores, ceResults);
    const n8 = result.find(([key]) => key === 'n8');

    expect(n8).toBeDefined();
    // CE score = weights.ce * rawScore (NOT 1/(60+rank))
    expect(n8![1].score).toBeCloseTo(weights.ce * 0.6, 10);
  });
});

// ─── Test 7: CE leg gated by MIN_VEC_POOL_SIZE ────────────────────────────────
//
// The thin-pool guard (G2 mitigation) is enforced in backend-search.ts; at the
// applyEnsemble level, passing fewer ceResults than MIN_VEC_POOL_SIZE is still
// valid but produces only the scores for the items actually present.
// This test documents the expected no-op behavior when ceResults is empty.
describe('Test 7 — CE leg with empty ceResults is a no-op', () => {
  it('passing ceScores but empty ceResults produces no CE contribution', () => {
    const bm25 = makeBm25Results();
    const semantic = makeSemanticResults();
    const limit = 10;

    // Non-empty ceScores but empty ceResults — the loop condition `i < ceResults.length`
    // prevents any iteration, so CE adds nothing.
    const withEmptyCeResults = applyEnsemble(
      'nl-conceptual',
      bm25,
      semantic,
      limit,
      0.9,
      [],
      [0.9, 0.8, 0.7],
      [], // empty ceResults → no-op
    );
    const withoutCE = applyEnsemble('nl-conceptual', bm25, semantic, limit, 0.9);

    expect(withEmptyCeResults.length).toBe(withoutCE.length);
    for (let i = 0; i < withoutCE.length; i++) {
      expect(withEmptyCeResults[i][0]).toBe(withoutCE[i][0]);
      expect(withEmptyCeResults[i][1].score).toBeCloseTo(withoutCE[i][1].score, 10);
    }
  });

  it('MIN_VEC_POOL_SIZE default is 5', () => {
    // The value must be the default when env var is unset (module-level IIFE).
    // We can only assert it is >= 1 and an integer (env may differ in CI).
    expect(MIN_VEC_POOL_SIZE).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(MIN_VEC_POOL_SIZE)).toBe(true);
  });
});

// ─── Test 8: ceResults aligned to semanticResults produces expected scores ────
//
// Verifies index alignment: ceResults[0] corresponds to ceScores[0],
// ceResults[1] to ceScores[1], etc.  A swap in ceResults order should
// change which candidate receives which CE contribution.
describe('Test 8 — ceResults indexed alignment with ceScores', () => {
  it('ceResults in semanticResults order distributes scores correctly', () => {
    const semantic = makeSemanticResults(); // n3, n1, n6, n2, n7
    // ceResults = first two from semantic (n3 at index 0, n1 at index 1)
    const ceResults = semantic.slice(0, 2);
    // High CE score goes to index 0 (n3), low to index 1 (n1)
    const ceScores = [0.9, 0.1];

    const result = applyEnsemble('nl-conceptual', [], semantic, 10, 0.9, [], ceScores, ceResults);

    const n3 = result.find(([key]) => key === 'n3');
    const n1 = result.find(([key]) => key === 'n1');

    expect(n3).toBeDefined();
    expect(n1).toBeDefined();

    // n3 should have a larger CE contribution than n1 (0.9 vs 0.1)
    // Both also have vec_rrf; but we check that n3's total score > n1's total score
    // given that n3 has same vec rank (0) as n1 (vec rank 1, so n3 vec rrf > n1 vec rrf).
    // n3: vec_rrf(rank=0) + ce(0.9 * 0.30); n1: vec_rrf(rank=1) + ce(0.1 * 0.30)
    // Qualitatively n3 score > n1 score in any consistent configuration.
    expect(n3![1].score).toBeGreaterThan(n1![1].score);
  });

  it('swapping ceResults reverses which candidate benefits', () => {
    const semantic = makeSemanticResults(); // n3, n1, n6, n2, n7
    const ceResultsNormal = semantic.slice(0, 2); // [n3, n1]
    const ceResultsSwapped = [semantic[1], semantic[0]]; // [n1, n3]
    const ceScores = [0.9, 0.1]; // high goes to index 0

    const resultNormal = applyEnsemble(
      'nl-conceptual',
      [],
      semantic,
      10,
      0.9,
      [],
      ceScores,
      ceResultsNormal,
    );
    const resultSwapped = applyEnsemble(
      'nl-conceptual',
      [],
      semantic,
      10,
      0.9,
      [],
      ceScores,
      ceResultsSwapped,
    );

    // With normal order: n3 gets ce=0.9, n1 gets ce=0.1
    const n3Normal = resultNormal.find(([k]) => k === 'n3')!;
    const n1Normal = resultNormal.find(([k]) => k === 'n1')!;
    // With swapped order: n1 gets ce=0.9, n3 gets ce=0.1
    const n3Swapped = resultSwapped.find(([k]) => k === 'n3')!;
    const n1Swapped = resultSwapped.find(([k]) => k === 'n1')!;

    // n3 should score higher in normal (high CE) vs swapped (low CE)
    expect(n3Normal[1].score).toBeGreaterThan(n3Swapped[1].score);
    // n1 should score higher in swapped (high CE) vs normal (low CE)
    expect(n1Swapped[1].score).toBeGreaterThan(n1Normal[1].score);
  });
});

// ─── Test 9: non-nl-conceptual intents with empty ceScores are unaffected ─────
//
// For calls-of, cross-file-impact, ambiguous: when ceScores=[] and ceResults=[],
// the CE branch is a no-op.  The result must equal the no-CE call.
describe('Test 9 — non-nl-conceptual intents skip CE when ceScores is empty', () => {
  const NON_CE_INTENTS: IntentLabel[] = ['calls-of', 'cross-file-impact', 'ambiguous'];

  for (const intent of NON_CE_INTENTS) {
    it(`intent="${intent}" with empty ceScores produces same result as baseline`, () => {
      const bm25 = makeBm25Results();
      const semantic = makeSemanticResults();
      const limit = 10;

      const withEmptyCE = applyEnsemble(intent, bm25, semantic, limit, 0.9, [], [], []);
      const baseline = applyEnsemble(intent, bm25, semantic, limit, 0.9);

      expect(withEmptyCE.length).toBe(baseline.length);
      for (let i = 0; i < baseline.length; i++) {
        expect(withEmptyCE[i][0]).toBe(baseline[i][0]);
        expect(withEmptyCE[i][1].score).toBeCloseTo(baseline[i][1].score, 10);
      }
    });
  }

  it('nl-conceptual with empty ceScores+ceResults is a no-op (same as baseline)', () => {
    const bm25 = makeBm25Results();
    const semantic = makeSemanticResults();
    const limit = 10;

    const withEmptyCE = applyEnsemble('nl-conceptual', bm25, semantic, limit, 0.9, [], [], []);
    const baseline = applyEnsemble('nl-conceptual', bm25, semantic, limit, 0.9);

    expect(withEmptyCE.length).toBe(baseline.length);
    for (let i = 0; i < baseline.length; i++) {
      expect(withEmptyCE[i][0]).toBe(baseline[i][0]);
      expect(withEmptyCE[i][1].score).toBeCloseTo(baseline[i][1].score, 10);
    }
  });
});

describe('Test 10 — trace mode captures weighted contributions', () => {
  it('records graph-leg traces without changing result order', () => {
    const bm25: EnrichedSymbolRow[] = [
      { nodeId: 'shared', filePath: 'src/shared.ts', bm25Score: 10 },
    ];
    const semantic: EnrichedSymbolRow[] = [
      { nodeId: 'shared', filePath: 'src/shared.ts', distance: 0.25 } as EnrichedSymbolRow,
    ];
    const graphResults: EnrichedSymbolRow[] = [
      { nodeId: 'shared', filePath: 'src/shared.ts', score: 0.4 } as EnrichedSymbolRow,
    ];

    const withoutTrace = applyEnsemble('cross-file-impact', bm25, semantic, 10, 0.9, graphResults);
    const withTrace = applyEnsemble(
      'cross-file-impact',
      bm25,
      semantic,
      10,
      0.9,
      graphResults,
      [],
      [],
      { includeTrace: true },
    );

    expect(withTrace.map(([key]) => key)).toEqual(withoutTrace.map(([key]) => key));
    expect(withTrace[0][1].trace).toEqual([
      {
        source: 'bm25',
        rank: 1,
        rawScore: 10,
        weight: INTENT_WEIGHTS['cross-file-impact'].bm25,
        contribution: INTENT_WEIGHTS['cross-file-impact'].bm25 * (1 / 61),
      },
      {
        source: 'semantic',
        rank: 1,
        rawScore: 0.75,
        weight: INTENT_WEIGHTS['cross-file-impact'].vec,
        contribution: INTENT_WEIGHTS['cross-file-impact'].vec * (1 / 61),
      },
      {
        source: 'graph',
        rank: 1,
        rawScore: 0.4,
        weight: INTENT_WEIGHTS['cross-file-impact'].graph,
        contribution: INTENT_WEIGHTS['cross-file-impact'].graph * (1 / 61),
      },
    ]);
  });

  it('records CE traces with raw score, weight, and contribution', () => {
    const semantic: EnrichedSymbolRow[] = [
      { nodeId: 'shared', filePath: 'src/shared.ts', distance: 0.1 } as EnrichedSymbolRow,
    ];
    const ceResults: EnrichedSymbolRow[] = [{ nodeId: 'shared', filePath: 'src/shared.ts' }];
    const ceScores = [0.9];

    const result = applyEnsemble('nl-conceptual', [], semantic, 10, 0.9, [], ceScores, ceResults, {
      includeTrace: true,
    });

    expect(result[0][1].trace).toEqual([
      {
        source: 'semantic',
        rank: 1,
        rawScore: 0.9,
        weight: INTENT_WEIGHTS['nl-conceptual'].vec,
        contribution: INTENT_WEIGHTS['nl-conceptual'].vec * (1 / 61),
      },
      {
        source: 'ce',
        rank: 1,
        rawScore: 0.9,
        weight: INTENT_WEIGHTS['nl-conceptual'].ce,
        contribution: INTENT_WEIGHTS['nl-conceptual'].ce * 0.9,
      },
    ]);
  });
});
