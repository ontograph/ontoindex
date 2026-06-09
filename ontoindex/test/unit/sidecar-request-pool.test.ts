import { describe, expect, it } from 'vitest';
import {
  SidecarRequestPool,
  createSidecarRequest,
  createSidecarRequestKey,
  decideQueryTriggeredSidecarRequest,
  defaultDurabilityForPriority,
  selectNextSidecarRequest,
  type SidecarEnrichmentRequest,
  type SidecarRequestPriority,
} from '../../src/core/ingestion/enrichment/index.js';

const baseInput = {
  repoId: 'repo-1',
  sourceIndexId: 'index-1',
  analyzerId: 'ts-type-aware',
  analyzerVersion: '1.0.0',
  purpose: 'type-aware-resolution' as const,
  scopeHash: 'scope-a',
  priority: 'changed-files' as const,
  requestedAt: '2026-05-13T00:00:00.000Z',
};

describe('sidecar request pool', () => {
  it('builds the ADR dedupe key from index, analyzer, purpose, and scope hash', () => {
    expect(createSidecarRequestKey(baseInput)).toBe(
      'index-1:ts-type-aware:1.0.0:type-aware-resolution:scope-a',
    );
  });

  it('defaults explicit non-background work to persistent and background remainder to volatile', () => {
    expect(defaultDurabilityForPriority('user-requested')).toBe('persistent');
    expect(defaultDurabilityForPriority('recent-query')).toBe('persistent');
    expect(defaultDurabilityForPriority('background-remainder')).toBe('volatile');
  });

  it('rejects unsupported enum values from persisted request input', () => {
    expect(() => createSidecarRequest({ ...baseInput, purpose: 'quality' as never })).toThrow(
      'purpose has unsupported value: quality',
    );
    expect(() => createSidecarRequest({ ...baseInput, priority: 'urgent' as never })).toThrow(
      'priority has unsupported value: urgent',
    );
    expect(() => createSidecarRequest({ ...baseInput, status: 'pending' as never })).toThrow(
      'status has unsupported value: pending',
    );
  });

  it('deduplicates active compatible requests and preserves stronger durability and priority', () => {
    const pool = new SidecarRequestPool();

    const first = pool.submit({
      ...baseInput,
      id: 'first',
      priority: 'background-remainder',
      durability: 'volatile',
    });
    const second = pool.submit({
      ...baseInput,
      id: 'second',
      priority: 'user-requested',
      durability: 'persistent',
      requestedAt: '2026-05-13T00:00:05.000Z',
    });

    expect(first.status).toBe('queued');
    expect(second.status).toBe('merged');
    expect(pool.list()).toHaveLength(1);
    expect(second.request.priority).toBe('user-requested');
    expect(second.request.durability).toBe('persistent');
    expect(second.request.mergedRequestIds).toEqual(['second']);
  });

  it('orders queued work by ADR priority and FIFO within the same priority', () => {
    const requests = [
      makeRequest('background', 'background-remainder', '2026-05-13T00:00:00.000Z'),
      makeRequest('public-api-newer', 'public-api', '2026-05-13T00:00:02.000Z'),
      makeRequest('public-api-older', 'public-api', '2026-05-13T00:00:01.000Z'),
      makeRequest('recent-query', 'recent-query', '2026-05-13T00:00:00.000Z'),
    ];

    expect(selectNextSidecarRequest(requests)?.id).toBe('public-api-older');
  });

  it('skips non-queued and expired requests', () => {
    const selected = selectNextSidecarRequest(
      [
        makeRequest('running', 'user-requested', '2026-05-13T00:00:00.000Z', {
          status: 'running',
        }),
        makeRequest('expired', 'unresolved-calls', '2026-05-13T00:00:00.000Z', {
          expiresAt: '2026-05-13T00:00:10.000Z',
        }),
        makeRequest('fresh', 'changed-files', '2026-05-13T00:00:00.000Z', {
          expiresAt: '2026-05-13T00:00:30.000Z',
        }),
      ],
      { now: '2026-05-13T00:00:20.000Z' },
    );

    expect(selected?.id).toBe('fresh');
  });

  it('selects a still-fresh lower-priority batch after bounded high-priority count', () => {
    const selected = selectNextSidecarRequest(
      [
        makeRequest('user', 'user-requested', '2026-05-13T00:00:00.000Z'),
        makeRequest('background', 'background-remainder', '2026-05-13T00:00:00.000Z', {
          expiresAt: '2026-05-13T00:01:00.000Z',
        }),
      ],
      {
        now: '2026-05-13T00:00:30.000Z',
        highPrioritySelectionsSinceLowerPriority: 5,
        maxHighPrioritySelections: 5,
      },
    );

    expect(selected?.id).toBe('background');
  });

  it('supports query-triggered coalescing by repo, session, analyzer, and scope', () => {
    const existing = createSidecarRequest({
      ...baseInput,
      id: 'query-1',
      priority: 'recent-query',
      sessionId: 'session-1',
    });

    expect(
      decideQueryTriggeredSidecarRequest({
        now: '2026-05-13T00:00:10.000Z',
        existingRequests: [existing],
        repoId: 'repo-1',
        sessionId: 'session-1',
        analyzerId: 'ts-type-aware',
        scopeHash: 'scope-a',
      }),
    ).toEqual({
      allowed: false,
      reason: 'coalesced',
      coalescedWithRequestId: 'query-1',
    });
  });

  it('rate-limits repeated query-triggered requests per repo, session, and analyzer', () => {
    const existing = [0, 1, 2].map((offset) =>
      createSidecarRequest({
        ...baseInput,
        id: `query-${offset}`,
        priority: 'recent-query',
        scopeHash: `scope-${offset}`,
        sessionId: 'session-1',
        requestedAt: new Date(Date.parse('2026-05-13T00:00:00.000Z') + offset * 1_000),
      }),
    );

    const decision = decideQueryTriggeredSidecarRequest({
      now: '2026-05-13T00:00:10.000Z',
      existingRequests: existing,
      repoId: 'repo-1',
      sessionId: 'session-1',
      analyzerId: 'ts-type-aware',
      scopeHash: 'new-scope',
      policy: { windowMs: 60_000, maxRequests: 3 },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('rate-limited');
    expect(decision.retryAfterMs).toBe(50_000);
  });
});

function makeRequest(
  id: string,
  priority: SidecarRequestPriority,
  requestedAt: string,
  overrides: Partial<SidecarEnrichmentRequest> = {},
): SidecarEnrichmentRequest {
  return createSidecarRequest({
    ...baseInput,
    id,
    scopeHash: id,
    priority,
    requestedAt,
    ...overrides,
  });
}
