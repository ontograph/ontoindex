import { describe, expect, it } from 'vitest';
import { gnTraceBoundary } from '../../../src/mcp/super/trace-boundary.js';
import type {
  BoundaryTraceFact,
  BoundaryTraceReport,
} from '../../../src/core/systems-audit/boundary-trace.js';

const trace = async (params: Parameters<typeof gnTraceBoundary>[1]) =>
  (await gnTraceBoundary('fixture', params)) as BoundaryTraceReport;
const facts: BoundaryTraceFact[] = [
  {
    kind: 'send',
    mechanism: 'SCM_RIGHTS',
    resourceInstanceId: 'fd:a',
    processId: 'sender',
    handle: 3,
  },
  {
    kind: 'receive',
    mechanism: 'SCM_RIGHTS',
    resourceInstanceId: 'fd:a',
    processId: 'receiver',
    handle: 7,
  },
];

describe('boundary trace public inputs', () => {
  it('normalizes exec and rejects conflicting aliases', async () => {
    const result = await trace({
      mechanism: 'exec',
      kind: 'exec-close-on-exec',
      facts: [
        { kind: 'exec', processId: 1 },
        { kind: 'open', processId: 1, resourceInstanceId: 'fd:a' },
      ],
    });
    expect(result.segments[0]?.mechanism).toBe('exec-close-on-exec');
    await expect(trace({ mechanism: 'exec', kind: 'fork' })).rejects.toThrow('same boundary');
  });

  it('reports absent evidence and source-only requests without echoing source', async () => {
    expect((await trace({})).status).toBe('unresolved');
    const result = await trace({ source: 'private source text' });
    expect(result.status).toBe('unresolved');
    expect(result.skipReasons).toContain('source-analysis-unavailable');
    expect(JSON.stringify(result)).not.toContain('private source text');
    expect((await trace({ facts, source: 'private source text' })).warnings).toContainEqual(
      expect.stringContaining('not analyzed'),
    );
  });

  it('filters explicit process endpoints without accepting missing or coerced identities', async () => {
    expect((await trace({ facts, start: 'sender', end: 'receiver' })).segments).toHaveLength(1);
    expect((await trace({ facts, start: 'other' })).status).toBe('unresolved');
    expect(
      (
        await trace({
          facts: [{ kind: 'pidfd_getfd', resourceInstanceId: 'fd:a', processId: 1 }],
          start: '1',
        })
      ).segments,
    ).toEqual([]);
    expect(
      (await trace({ facts: [{ kind: 'pidfd_getfd', resourceInstanceId: 'fd:a' }], start: 1 }))
        .segments,
    ).toEqual([]);
  });

  it('selects the requested SCM receiver before pairing facts', async () => {
    const result = await trace({
      end: 'receiver',
      facts: [
        facts[0]!,
        { ...facts[1]!, processId: 'wrong' },
        { kind: 'receive', mechanism: 'SCM_RIGHTS', resourceInstanceId: 'fd:a' },
        facts[1]!,
      ],
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.receiverProcessId).toBe('receiver');
    expect(result.status).toBe('ok');
  });

  it('applies output limits after endpoint filtering and preserves acquisition truncation', async () => {
    const duplicates = Array.from({ length: 101 }, (_, index) => ({
      kind: 'pidfd_getfd',
      resourceInstanceId: `fd:${index}`,
      processId: index,
    }));
    expect(
      (await trace({ facts: duplicates.slice(0, 4), start: 3, maxSegments: 1 })).limits,
    ).toEqual({
      truncated: false,
      maxSegments: 1,
      emitted: 1,
      total: 1,
      totalIsExact: true,
      totalScope: 'matching-segments',
    });
    const result = await trace({ facts: duplicates, start: 100 });
    expect(result.status).toBe('partial');
    expect(result.limits.truncated).toBe(true);
    expect(result.segments).toEqual([]);
    expect(result.limits).toMatchObject({
      total: 0,
      totalIsExact: false,
      totalScope: 'acquired-matching-segments',
    });
    const matching = await trace({ facts: duplicates });
    expect(matching.limits).toMatchObject({
      total: 100,
      totalIsExact: false,
      totalScope: 'acquired-matching-segments',
    });
    expect(matching.warnings).toContainEqual(
      expect.stringContaining('truncated before endpoint filtering'),
    );
    const mixed = await trace({
      facts: duplicates.map((fact) => ({ ...fact, processId: fact.processId % 2 })),
      start: 1,
    });
    expect(mixed.limits).toMatchObject({
      total: 50,
      totalIsExact: false,
      totalScope: 'acquired-matching-segments',
    });
    expect(mixed.status).toBe('partial');
  });

  it.each([
    { facts: Array.from({ length: 257 }, () => ({ kind: 'open' })) },
    { facts: [{ kind: 'open', unknown: true }] },
    { facts: [{ kind: 'open', handle: Infinity }] },
    { facts: [{ kind: 'open', line: 0 }] },
    { facts: [{ kind: 'open', filePath: 'x'.repeat(1025) }] },
    { facts: [{ kind: 'open', flags: Array(33).fill('x') }] },
    { facts: [{ kind: 'open', flags: ['x'.repeat(129)] }] },
    { maxSegments: 0 },
    { maxSegments: 101 },
    { maxSegments: 1.5 },
  ])('rejects malformed bounded inputs %#', async (params) => {
    await expect(trace(params)).rejects.toThrow();
  });
});
