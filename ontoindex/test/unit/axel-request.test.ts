import { describe, expect, it } from 'vitest';
import {
  AXEL_ANALYZER_ID,
  AXEL_DEFAULT_ANALYZER_VERSION,
  createAxelEnrichmentQueueRequest,
  createSidecarRequest,
  SidecarRequestPool,
} from '../../src/core/ingestion/enrichment/index.js';

const baseInput = {
  enabled: true,
  repoId: 'repo-1',
  sourceIndexId: 'index-1',
  scopeHash: 'scope-hash-1',
  requestedAt: '2026-05-13T10:00:00.000Z',
} as const;

describe('Axel enrichment queue request', () => {
  it('does not create a request when Axel enrichment is disabled', () => {
    expect(createAxelEnrichmentQueueRequest({ ...baseInput, enabled: false })).toEqual({
      queued: false,
      reason: 'disabled',
    });
  });

  it('creates a volatile architecture-enrichment request only when explicitly enabled', () => {
    const decision = createAxelEnrichmentQueueRequest(baseInput);

    expect(decision).toEqual({
      queued: true,
      request: {
        repoId: 'repo-1',
        sourceIndexId: 'index-1',
        analyzerId: AXEL_ANALYZER_ID,
        analyzerVersion: AXEL_DEFAULT_ANALYZER_VERSION,
        purpose: 'architecture-enrichment',
        scopeHash: 'scope-hash-1',
        priority: 'background-remainder',
        requestedAt: '2026-05-13T10:00:00.000Z',
        expiresAt: undefined,
        durability: 'volatile',
        sessionId: undefined,
      },
    });
  });

  it('is accepted by the existing sidecar request pool and coalesces matching requests', () => {
    const first = createAxelEnrichmentQueueRequest(baseInput);
    const second = createAxelEnrichmentQueueRequest({
      ...baseInput,
      requestedAt: '2026-05-13T10:01:00.000Z',
      sessionId: 'session-1',
    });
    if (!first.queued || !second.queued) throw new Error('expected queued requests');

    const pool = new SidecarRequestPool();
    const queued = pool.submit(first.request);
    const merged = pool.submit(second.request);

    expect(queued.status).toBe('queued');
    expect(merged.status).toBe('merged');
    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0]).toMatchObject({
      analyzerId: AXEL_ANALYZER_ID,
      purpose: 'architecture-enrichment',
      status: 'queued',
      durability: 'volatile',
      mergedRequestIds: [createSidecarRequest(second.request).id],
    });
  });

  it('rejects blank identity fields before queue insertion', () => {
    expect(() => createAxelEnrichmentQueueRequest({ ...baseInput, repoId: '  ' })).toThrow(
      'repoId must be a non-empty string',
    );
    expect(() => createAxelEnrichmentQueueRequest({ ...baseInput, sourceIndexId: '  ' })).toThrow(
      'sourceIndexId must be a non-empty string',
    );
    expect(() => createAxelEnrichmentQueueRequest({ ...baseInput, scopeHash: '  ' })).toThrow(
      'scopeHash must be a non-empty string',
    );
  });
});
