import { describe, expect, it } from 'vitest';
import {
  createMarkdownDocumentEnrichmentQueueRequest,
  createSidecarRequest,
  MARKDOWN_DOCUMENT_ANALYZER_ID,
  MARKDOWN_DOCUMENT_DEFAULT_ANALYZER_VERSION,
  SidecarRequestPool,
} from '../../src/core/ingestion/enrichment/index.js';

const baseInput = {
  enabled: true,
  repoId: 'repo-1',
  sourceIndexId: 'index-1',
  scopeHash: 'markdown-scope-1',
  requestedAt: '2026-05-14T10:00:00.000Z',
} as const;

describe('Markdown document enrichment queue request', () => {
  it('does not create a request when Markdown sidecar enrichment is disabled', () => {
    expect(createMarkdownDocumentEnrichmentQueueRequest({ ...baseInput, enabled: false })).toEqual({
      queued: false,
      reason: 'disabled',
    });
  });

  it('creates a persistent markdown-document-enrichment request only when explicitly enabled', () => {
    const decision = createMarkdownDocumentEnrichmentQueueRequest(baseInput);

    expect(decision).toEqual({
      queued: true,
      request: {
        repoId: 'repo-1',
        sourceIndexId: 'index-1',
        analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
        analyzerVersion: MARKDOWN_DOCUMENT_DEFAULT_ANALYZER_VERSION,
        purpose: 'markdown-document-enrichment',
        scopeHash: 'markdown-scope-1',
        priority: 'background-remainder',
        requestedAt: '2026-05-14T10:00:00.000Z',
        expiresAt: undefined,
        durability: 'persistent',
        sessionId: undefined,
      },
    });
  });

  it('is accepted by the existing sidecar request pool and coalesces matching requests', () => {
    const first = createMarkdownDocumentEnrichmentQueueRequest(baseInput);
    const second = createMarkdownDocumentEnrichmentQueueRequest({
      ...baseInput,
      requestedAt: '2026-05-14T10:01:00.000Z',
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
      analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
      purpose: 'markdown-document-enrichment',
      status: 'queued',
      durability: 'persistent',
      mergedRequestIds: [createSidecarRequest(second.request).id],
    });
  });

  it('rejects blank identity fields before queue insertion', () => {
    expect(() =>
      createMarkdownDocumentEnrichmentQueueRequest({ ...baseInput, repoId: '  ' }),
    ).toThrow('repoId must be a non-empty string');
    expect(() =>
      createMarkdownDocumentEnrichmentQueueRequest({ ...baseInput, sourceIndexId: '  ' }),
    ).toThrow('sourceIndexId must be a non-empty string');
    expect(() =>
      createMarkdownDocumentEnrichmentQueueRequest({ ...baseInput, scopeHash: '  ' }),
    ).toThrow('scopeHash must be a non-empty string');
  });
});
