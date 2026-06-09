import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  createEmptySidecarStoreState,
  createLocalSidecarRunnerCallbacks,
  createMarkdownDocumentEnrichmentQueueRequest,
  createMarkdownSidecarRunnerExecutor,
  createSidecarRequest,
  LocalSidecarStore,
  MARKDOWN_DOCUMENT_ANALYZER_ID,
  runSidecarRunnerOnce,
  type SidecarEnrichmentRequest,
} from '../../src/core/ingestion/enrichment/index.js';

const requestInput = {
  enabled: true,
  repoId: 'repo-1',
  sourceIndexId: 'index-1',
  scopeHash: 'markdown-scope-1',
  requestedAt: '2026-05-14T10:00:00.000Z',
} as const;

describe('Markdown sidecar runner executor', () => {
  it('runs through the shared sidecar runner and persists Markdown facts', async () => {
    const store = new LocalSidecarStore(await tempStorePath());
    const request = createQueuedRequest();
    await store.save({ ...createEmptySidecarStoreState(), requests: [request] });
    const executor = createMarkdownSidecarRunnerExecutor({
      store,
      documents: [{ docPath: 'docs/a.md', sourceCommitHash: 'commit-1', source: '# A' }],
    });
    const callbacks = createLocalSidecarRunnerCallbacks({
      store,
      executeRequest: executor,
      observeThrottle: async () => ({
        logicalCpuCount: 28,
        observedCpuPercent: 4,
        workerCount: 1,
      }),
      ownerId: () => 'markdown-runner',
      pid: () => 1234,
      now: () => '2026-05-14T10:00:30.000Z',
    });

    await expect(
      runSidecarRunnerOnce(callbacks, {
        sourceIndexId: 'index-1',
        analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
        leaseMs: 60_000,
        staleHeartbeatMs: 120_000,
      }),
    ).resolves.toMatchObject({ executed: true, status: 'complete' });

    const state = await store.load();
    expect(state.requests[0]).toMatchObject({ status: 'complete' });
    expect(state.lock).toBeNull();
    expect(state.enrichments).toEqual([
      expect.objectContaining({
        analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
        filePath: 'docs/a.md',
        records: expect.arrayContaining([
          expect.objectContaining({ kind: 'markdown-chunk', docPath: 'docs/a.md' }),
        ]),
      }),
    ]);
  });

  it('produces Markdown facts and persists enrichment records through the sidecar store', async () => {
    const store = new LocalSidecarStore(await tempStorePath());
    const request = createQueuedRequest();
    const executor = createMarkdownSidecarRunnerExecutor({
      store,
      documents: [
        {
          docPath: 'docs/orders.md',
          sourceCommitHash: 'commit-1',
          source: [
            '---',
            'tags: [orders]',
            '---',
            '# Orders',
            '',
            'See [Billing](./billing.md#invoice) and `createInvoice`.',
          ].join('\n'),
        },
      ],
      resolveCodeMention: (mention) =>
        mention === 'createInvoice'
          ? {
              resolutionStatus: 'resolved',
              target: { type: 'symbol', id: 'Function:createInvoice' },
              confidence: 0.9,
            }
          : undefined,
    });

    await expect(executor(request, { heartbeat: async () => true })).resolves.toEqual({
      status: 'complete',
    });

    const state = await store.load();
    expect(state.enrichments).toHaveLength(1);
    expect(state.enrichments[0]).toMatchObject({
      sourceIndexId: 'index-1',
      sourceCommitHash: 'commit-1',
      analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
      analyzerVersion: '1.0.0',
      filePath: 'docs/orders.md',
      status: 'complete',
      confidence: 1,
    });
    expect(state.enrichments[0].records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'markdown-chunk', docPath: 'docs/orders.md' }),
        expect.objectContaining({ kind: 'markdown-link', href: './billing.md#invoice' }),
        expect.objectContaining({ kind: 'markdown-entity', label: 'orders' }),
        expect.objectContaining({
          kind: 'markdown-code-mention',
          resolutionStatus: 'resolved',
          target: { type: 'symbol', id: 'Function:createInvoice', filePath: undefined },
        }),
      ]),
    );
  });

  it('returns partial when heartbeat is lost after persisting a document', async () => {
    const store = new LocalSidecarStore(await tempStorePath());
    const request = createQueuedRequest();
    const executor = createMarkdownSidecarRunnerExecutor({
      store,
      documents: [
        { docPath: 'docs/a.md', sourceCommitHash: 'commit-1', source: '# A' },
        { docPath: 'docs/b.md', sourceCommitHash: 'commit-1', source: '# B' },
      ],
    });

    await expect(executor(request, { heartbeat: async () => false })).resolves.toEqual({
      status: 'partial',
      failureReason: 'markdown sidecar heartbeat lost',
    });

    const state = await store.load();
    expect(state.enrichments.map((record) => record.filePath)).toEqual(['docs/a.md']);
  });

  it('rejects non-Markdown queued work before persisting facts', async () => {
    const store = new LocalSidecarStore(await tempStorePath());
    const executor = createMarkdownSidecarRunnerExecutor({
      store,
      documents: [{ docPath: 'docs/a.md', sourceCommitHash: 'commit-1', source: '# A' }],
    });
    const request = createSidecarRequest({
      repoId: 'repo-1',
      sourceIndexId: 'index-1',
      analyzerId: 'other',
      analyzerVersion: '1.0.0',
      purpose: 'markdown-document-enrichment',
      scopeHash: 'markdown-scope-1',
      priority: 'background-remainder',
      requestedAt: '2026-05-14T10:00:00.000Z',
    });

    await expect(executor(request, { heartbeat: async () => true })).rejects.toThrow(
      'Markdown sidecar runner received non-Markdown request: other',
    );
    await expect(store.load()).resolves.toMatchObject({ enrichments: [] });
  });
});

function createQueuedRequest(): SidecarEnrichmentRequest {
  const decision = createMarkdownDocumentEnrichmentQueueRequest(requestInput);
  if (!decision.queued) throw new Error('expected queued Markdown request');
  return createSidecarRequest(decision.request);
}

async function tempStorePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-markdown-sidecar-'));
  return path.join(dir, 'sidecar-store.json');
}
