import { describe, expect, it } from 'vitest';
import { composeRetrievalContext } from '../../src/core/search/retrieval-context-composition.js';

describe('composeRetrievalContext', () => {
  it('normalizes tiers and records duplicate and invalid-score warnings', () => {
    const report = composeRetrievalContext({
      candidates: [
        {
          id: 'a',
          label: 'repo',
          kind: 'module',
          tier: 0,
          source: 'bm25',
          score: 1.5,
          freshness: 'fresh',
          communityId: 'core',
          altitude: 'local',
          provenance: [],
          relatedSymbols: [],
        },
        {
          id: 'a',
          label: 'same-id',
          kind: 'module',
          tier: 'repo',
          source: 'graph',
          score: 3.1,
          freshness: 'stale',
          communityId: 'core',
          altitude: 'bridge',
          provenance: [],
          relatedSymbols: [],
        },
        {
          id: 'b',
          label: 'weird',
          kind: 'symbol',
          tier: 7,
          source: 'graph',
          // invalid score
          score: null,
          freshness: 'stale',
          communityId: 'core',
          altitude: 'global',
        },
      ],
    });

    expect(report.candidates).toHaveLength(2);
    expect(report.candidates[0]).toMatchObject({ id: 'a', tier: 0, source: 'graph', score: 3.1 });
    expect(report.candidates[1]).toMatchObject({ id: 'b', tier: 3, score: 0 });
    expect(report.warnings).toContain('Duplicate candidate id "a" was merged.');
    expect(report.warnings).toContain('Unknown tier "7" for candidate "b"; defaulting to 3.');
    expect(report.warnings).toContain('Invalid score for candidate "b"; defaulting to 0.');
  });

  it('sorts candidates deterministically by tier, score, id, then label', () => {
    const report = composeRetrievalContext({
      candidates: [
        { id: 'zzz', tier: 2, label: 'z', kind: 'symbol', source: 's2', score: 2 },
        { id: 'aaa', tier: 1, label: 'a', kind: 'file', source: 's1', score: 1 },
        { id: 'bbb', tier: 1, label: 'b', kind: 'file', source: 's1', score: 2 },
      ],
    });

    expect(report.candidates.map((candidate) => candidate.id)).toEqual(['bbb', 'aaa', 'zzz']);
  });

  it('sorts and limits provenance steps deterministically', () => {
    const report = composeRetrievalContext({
      limits: { maxProvenanceStepsPerCandidate: 2 },
      candidates: [
        {
          id: 'p1',
          tier: 2,
          kind: 'symbol',
          source: 'graph',
          score: 1,
          freshness: 'fresh',
          communityId: 'search',
          altitude: 'bridge',
          provenance: [
            { action: 'z', source: 'alpha', target: 'C', sequence: 20 },
            { action: 'a', source: 'alpha', target: 'A' },
            { action: 'b', source: 'alpha', target: 'B', sequence: 10 },
            { action: 'c', source: 'beta', target: 'D' },
          ],
        },
      ],
    });

    expect(report.candidates[0].provenance).toEqual([
      { source: 'alpha', action: 'b', target: 'B', sequence: 10, freshness: 'unknown' },
      { source: 'alpha', action: 'z', target: 'C', sequence: 20, freshness: 'unknown' },
    ]);
    expect(report.truncated.provenanceSteps).toBe(true);
  });

  it('sorts related symbols by relation type, score, id, and label, then enforces limits', () => {
    const report = composeRetrievalContext({
      limits: { maxRelatedSymbolsPerCandidate: 2 },
      candidates: [
        {
          id: 'r1',
          tier: 2,
          kind: 'symbol',
          source: 'graph',
          score: 2,
          freshness: 'fresh',
          communityId: 'search',
          altitude: 'bridge',
          relatedSymbols: [
            { id: 'x', label: 'x', relationType: 'calls', score: 1 },
            { id: 'a', label: 'a', relationType: 'calls', score: 3 },
            { id: 'm', label: 'm', relationType: 'imports', score: 9 },
            { id: 'b', label: 'b', relationType: 'calls', score: 3 },
          ],
        },
      ],
    });

    expect(report.candidates[0].relatedSymbols.map((symbol) => symbol.id)).toEqual(['a', 'b']);
    expect(report.truncated.relatedSymbols).toBe(true);
  });

  it('merges duplicate candidates by id and aggregates provenance and related metadata', () => {
    const report = composeRetrievalContext({
      candidates: [
        {
          id: 'dup',
          label: 'first',
          kind: 'symbol',
          tier: 2,
          source: 'bm25',
          score: 1,
          freshness: 'fresh',
          communityId: 'c1',
          altitude: 'local',
          provenance: [{ source: 'bm25', action: 'seen', sequence: 2 }],
          relatedSymbols: [{ id: 'x', label: 'x', relationType: 'calls', score: 1 }],
        },
        {
          id: 'dup',
          label: 'first',
          kind: 'symbol',
          tier: 2,
          source: 'graph',
          score: 4,
          freshness: 'fresh',
          communityId: 'c1',
          altitude: 'local',
          provenance: [{ source: 'graph', action: 'linked', sequence: 1 }],
          relatedSymbols: [{ id: 'y', label: 'y', relationType: 'imports', score: 2 }],
        },
      ],
    });

    expect(report.observed.candidates).toBe(1);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].score).toBe(4);
    expect(report.candidates[0].source).toBe('graph');
    expect(report.candidates[0].provenance.map((step) => step.source)).toEqual(['graph', 'bm25']);
    expect(report.candidates[0].relatedSymbols.map((symbol) => symbol.id)).toEqual(['x', 'y']);
  });

  it('counts by tier, kind, source, freshness, community, and altitude deterministically', () => {
    const report = composeRetrievalContext({
      candidates: [
        { id: 'a', tier: 0, kind: 'file', source: 'bm25', score: 1, freshness: 'fresh', communityId: 'one', altitude: 'local' },
        { id: 'b', tier: 1, kind: 'file', source: 'bm25', score: 2, freshness: 'fresh', communityId: 'one', altitude: 'bridge' },
        { id: 'c', tier: 2, kind: 'symbol', source: 'graph', score: 3, freshness: 'stale', communityId: 'two', altitude: 'global' },
        { id: 'd', tier: 3, kind: 'fragment', source: 'graph', score: 4, freshness: 'degraded', communityId: 'two', altitude: 'global' },
      ],
    });

    expect(report.byTier).toEqual({
      0: 1,
      1: 1,
      2: 1,
      3: 1,
    });
    expect(report.byKind).toEqual({ file: 2, symbol: 1, fragment: 1 });
    expect(report.bySource).toEqual({ bm25: 2, graph: 2 });
    expect(report.byFreshness).toEqual({
      fresh: 2,
      stale: 1,
      degraded: 1,
      unknown: 0,
    });
    expect(report.byCommunity).toEqual({ one: 2, two: 2 });
    expect(report.byAltitude).toEqual({ local: 1, bridge: 1, global: 2 });
  });

  it('truncates candidates to the configured limit and exposes truncation flags', () => {
    const report = composeRetrievalContext({
      limits: { maxCandidates: 2 },
      candidates: [
        { id: 'a', tier: 0, kind: 'file', source: 'bm25', score: 1, freshness: 'fresh', communityId: 'x', altitude: 'local' },
        { id: 'b', tier: 1, kind: 'file', source: 'bm25', score: 2, freshness: 'fresh', communityId: 'x', altitude: 'local' },
        { id: 'c', tier: 2, kind: 'symbol', source: 'graph', score: 3, freshness: 'fresh', communityId: 'x', altitude: 'local' },
      ],
    });

    expect(report.truncated.candidates).toBe(true);
    expect(report.emitted.candidates).toBe(2);
    expect(report.observed.candidates).toBe(3);
  });

  it('warns for dangling related-symbol references', () => {
    const report = composeRetrievalContext({
      candidates: [
        {
          id: 'a',
          tier: 2,
          kind: 'symbol',
          source: 'bm25',
          score: 1,
          freshness: 'fresh',
          communityId: 'x',
          altitude: 'local',
          relatedSymbols: [{ id: 'missing', label: 'missing', relationType: 'calls', score: 1 }],
        },
      ],
    });

    expect(report.warnings).toContain('Dangling related-symbol reference "missing" in candidate "a".');
  });

  it('does not warn for explicitly external related-symbol references', () => {
    const report = composeRetrievalContext({
      candidates: [
        {
          id: 'a',
          tier: 2,
          kind: 'symbol',
          source: 'bm25',
          score: 1,
          freshness: 'fresh',
          communityId: 'x',
          altitude: 'local',
          relatedSymbols: [
            { id: 'external', label: 'external', relationType: 'calls', score: 1, source: 'external-source' },
          ],
        },
      ],
    });

    expect(report.warnings).toEqual([]);
  });

  it('retains related-symbol metadata across duplicate candidates when relation keys differ', () => {
    const report = composeRetrievalContext({
      candidates: [
        {
          id: 'dup',
          tier: 2,
          kind: 'symbol',
          source: 'bm25',
          score: 1,
          freshness: 'fresh',
          communityId: 'c1',
          altitude: 'local',
          relatedSymbols: [
            { id: 'x', label: 'x', relationType: 'calls', score: 1, source: 'bm25' },
            { id: 'x', label: 'x', relationType: 'imports', score: 1, source: 'bm25' },
          ],
        },
        {
          id: 'dup',
          tier: 2,
          kind: 'symbol',
          source: 'bm25',
          score: 2,
          freshness: 'fresh',
          communityId: 'c1',
          altitude: 'local',
          relatedSymbols: [{ id: 'x', label: 'x2', relationType: 'calls', score: 5, source: 'graph' }],
        },
      ],
    });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].relatedSymbols).toHaveLength(3);
    expect(report.candidates[0].relatedSymbols.map((symbol) => symbol.relationType)).toEqual([
      'calls',
      'calls',
      'imports',
    ]);
  });

  it('enforces warning limits with a warning truncation flag', () => {
    const report = composeRetrievalContext({
      limits: { maxWarnings: 2 },
      candidates: [
        { id: 'a', tier: 10, kind: 'symbol', source: 'bm25', score: NaN, freshness: 'fresh', communityId: 'x', altitude: 'local' },
        { id: 'a', tier: 'bad-tier', kind: 'symbol', source: 'bm25', score: NaN, freshness: 'fresh', communityId: 'x', altitude: 'local' },
        { id: 'b', tier: 10, kind: 'symbol', source: 'bm25', score: NaN, freshness: 'fresh', communityId: 'x', altitude: 'local' },
      ],
    });

    expect(report.truncated.warnings).toBe(true);
    expect(report.warnings.length).toBe(3);
  });

  it('returns empty-safe report for empty input', () => {
    const report = composeRetrievalContext();

    expect(report).toEqual({
      limits: {
        maxCandidates: 64,
        maxRelatedSymbolsPerCandidate: 8,
        maxProvenanceStepsPerCandidate: 8,
        maxWarnings: 128,
      },
      observed: { candidates: 0, relatedSymbols: 0, provenanceSteps: 0, warnings: 0 },
      emitted: { candidates: 0, relatedSymbols: 0, provenanceSteps: 0 },
      byTier: { 0: 0, 1: 0, 2: 0, 3: 0 },
      byKind: {},
      bySource: {},
      byFreshness: { fresh: 0, stale: 0, degraded: 0, unknown: 0 },
      byCommunity: {},
      byAltitude: { local: 0, bridge: 0, global: 0 },
      truncated: { candidates: false, relatedSymbols: false, provenanceSteps: false, warnings: false },
      candidates: [],
      warnings: [],
    });
  });
});
