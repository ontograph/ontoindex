import { describe, expect, it } from 'vitest';
import type { QueryBudgetSnapshot } from '../../src/core/runtime/query-budget.js';
import {
  createAnytimeResultEnvelope,
  type AnytimeResultEnvelope,
} from '../../src/core/runtime/anytime-result-envelope.js';

describe('anytime result envelope', () => {
  it('builds a complete envelope for fully complete slices', () => {
    const payload = { rows: ['a', 'b'] };
    const envelope = createAnytimeResultEnvelope({
      slices: [
        {
          lane: 'graph',
          completeness: 'complete',
          emittedCount: 2,
          payload,
          exhaustedResources: [],
          diagnostics: [],
        },
      ],
    });

    expect(envelope.isPartial).toBe(false);
    expect(envelope.slices[0].payload).toBe(payload);
    expect(envelope.summary).toEqual({
      totalSlices: 1,
      totalDiagnostics: 0,
      byLane: [{ lane: 'graph', count: 1 }],
      byCompleteness: [{ completeness: 'complete', count: 1 }],
      byExhaustedResource: [],
      bySeverity: [],
    });
    expect(envelope.truncation).toEqual({ omittedSlices: 0, omittedDiagnostics: 0 });
  });

  it('derives partiality from non-complete slices', () => {
    const envelope = createAnytimeResultEnvelope({
      slices: [
        {
          lane: 'graph',
          completeness: 'partial',
          emittedCount: 3,
          payload: {},
          exhaustedResources: [],
        },
        {
          lane: 'docs',
          completeness: 'complete',
          emittedCount: 1,
          payload: {},
          exhaustedResources: [],
        },
      ],
    });

    expect(envelope.isPartial).toBe(true);
  });

  it('derives partiality from exhausted resources', () => {
    const envelope = createAnytimeResultEnvelope({
      slices: [
        {
          lane: 'vector',
          completeness: 'complete',
          emittedCount: 8,
          payload: {},
          exhaustedResources: ['time', 'nodes'],
        },
      ],
    });

    expect(envelope.isPartial).toBe(true);
    expect(envelope.summary.byExhaustedResource).toEqual([
      { resource: 'nodes', count: 1 },
      { resource: 'time', count: 1 },
    ]);
  });

  it('accepts unknown as an explicit exhausted resource', () => {
    const envelope = createAnytimeResultEnvelope({
      slices: [
        {
          lane: 'virtual-source',
          completeness: 'complete',
          emittedCount: 1,
          payload: {},
          exhaustedResources: ['unknown'],
        },
      ],
    });

    expect(envelope.isPartial).toBe(true);
    expect(envelope.summary.byExhaustedResource).toEqual([{ resource: 'unknown', count: 1 }]);
    expect(envelope.diagnostics).toEqual([]);
  });

  it('derives partiality from truncated budget snapshot', () => {
    const budget: QueryBudgetSnapshot = {
      truncated: true,
      truncatedReasons: ['timeout'],
      degradedReasons: [],
    };
    const envelope = createAnytimeResultEnvelope({
      budgetSnapshot: budget,
      slices: [
        {
          lane: 'semantic-frontier',
          completeness: 'complete',
          emittedCount: 1,
          payload: {},
          exhaustedResources: [],
        },
      ],
    });

    expect(envelope.isPartial).toBe(true);
  });

  it('summarizes slices and diagnostics deterministically', () => {
    const envelope: AnytimeResultEnvelope = createAnytimeResultEnvelope({
      slices: [
        {
          lane: 'docs',
          completeness: 'skipped',
          emittedCount: 1,
          payload: {},
          exhaustedResources: [],
          diagnostics: [{ code: 'd', message: 'doc warning', severity: 'warning' }],
        },
        {
          lane: 'graph',
          completeness: 'failed',
          emittedCount: 2,
          payload: {},
          exhaustedResources: ['nodes', 'bytes'],
          diagnostics: [{ code: 'd', message: 'graph error', severity: 'error' }],
        },
        {
          lane: 'lexical',
          completeness: 'partial',
          emittedCount: 1,
          payload: {},
          exhaustedResources: ['nodes'],
          diagnostics: [{ code: 'd', message: 'lex info', severity: 'info' }],
        },
      ],
    });

    expect(envelope.summary).toEqual({
      totalSlices: 3,
      totalDiagnostics: 3,
      byLane: [
        { lane: 'docs', count: 1 },
        { lane: 'graph', count: 1 },
        { lane: 'lexical', count: 1 },
      ],
      byCompleteness: [
        { completeness: 'failed', count: 1 },
        { completeness: 'partial', count: 1 },
        { completeness: 'skipped', count: 1 },
      ],
      byExhaustedResource: [
        { resource: 'bytes', count: 1 },
        { resource: 'nodes', count: 2 },
      ],
      bySeverity: [
        { severity: 'error', count: 1 },
        { severity: 'info', count: 1 },
        { severity: 'warning', count: 1 },
      ],
    });
  });

  it('records duplicate slice ids as warnings', () => {
    const envelope = createAnytimeResultEnvelope({
      slices: [
        {
          id: 'dup-1',
          lane: 'graph',
          completeness: 'complete',
          emittedCount: 1,
          payload: {},
          exhaustedResources: [],
        },
        {
          id: 'dup-1',
          lane: 'graph',
          completeness: 'complete',
          emittedCount: 2,
          payload: {},
          exhaustedResources: [],
        },
      ],
    });

    expect(envelope.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'duplicate-slice-id',
          sliceId: 'dup-1',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('reports invalid lane completeness and resource values', () => {
    const envelope = createAnytimeResultEnvelope({
      slices: [
        {
          lane: 'unknown-lane',
          completeness: 'bad-state',
          emittedCount: 1,
          payload: {},
          exhaustedResources: ['not-real-resource'],
        },
      ],
    });

    expect(envelope.isPartial).toBe(true);
    expect(envelope.summary.byLane).toEqual([{ lane: 'unknown', count: 1 }]);
    expect(envelope.summary.byExhaustedResource).toEqual([{ resource: 'unknown', count: 1 }]);
    expect(envelope.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-lane' }),
        expect.objectContaining({ code: 'invalid-completeness' }),
        expect.objectContaining({ code: 'invalid-exhausted-resource' }),
      ]),
    );
  });

  it('applies max diagnostics limit with truncation diagnostics', () => {
    const envelope = createAnytimeResultEnvelope({
      maxDiagnostics: 4,
      slices: [
        {
          lane: 'graph',
          completeness: 'complete',
          emittedCount: 1,
          payload: {},
          exhaustedResources: [],
          diagnostics: [
            { code: 'a', message: 'warn 1', severity: 'warning' },
            { code: 'b', message: 'warn 2', severity: 'warning' },
            { code: 'c', message: 'warn 3', severity: 'warning' },
          ],
        },
        {
          lane: 'graph',
          completeness: 'complete',
          emittedCount: 1,
          payload: {},
          exhaustedResources: [],
          diagnostics: [
            { code: 'd', message: 'warn 4', severity: 'warning' },
            { code: 'e', message: 'warn 5', severity: 'warning' },
          ],
        },
      ],
    });

    expect(envelope.truncation.omittedDiagnostics).toBe(2);
    expect(envelope.diagnostics).toHaveLength(4);
    expect(envelope.diagnostics.at(-1)).toMatchObject({
      code: 'max-diagnostics-truncated',
      message: 'diagnostics capped at 4; 2 omitted',
    });
  });

  it('applies max slice limit with truncation diagnostics', () => {
    const envelope = createAnytimeResultEnvelope({
      maxSlices: 2,
      slices: [
        { lane: 'graph', completeness: 'complete', emittedCount: 1, payload: {}, exhaustedResources: [] },
        { lane: 'graph', completeness: 'complete', emittedCount: 1, payload: {}, exhaustedResources: [] },
        { lane: 'graph', completeness: 'complete', emittedCount: 1, payload: {}, exhaustedResources: [] },
      ],
    });

    expect(envelope.slices).toHaveLength(2);
    expect(envelope.truncation.omittedSlices).toBe(1);
    expect(envelope.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'max-slices-truncated',
          message: 'slices capped at 2; 1 omitted',
        }),
      ]),
    );
  });

  it('does not mutate caller input arrays', () => {
    const payload = { name: 'graph-slice' };
    const userSlices = [
      {
        lane: 'graph',
        completeness: 'complete',
        emittedCount: 1,
        payload,
        exhaustedResources: ['time'],
        diagnostics: [
          { code: 'a', message: 'hello', severity: 'warning' },
        ],
      },
      {
        lane: 'docs',
        completeness: 'complete',
        emittedCount: 0,
        payload: { name: 'docs-slice' },
        exhaustedResources: ['bytes'],
      },
    ];
    const userSlicesClone = structuredClone(userSlices);

    const envelope = createAnytimeResultEnvelope({
      slices: userSlices,
      maxSlices: 10,
      maxDiagnostics: 10,
    });

    expect(userSlices).toEqual(userSlicesClone);
    expect(envelope.slices[0].payload).toBe(payload);
  });
});
