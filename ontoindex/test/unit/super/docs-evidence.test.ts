import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn(),
}));

vi.mock('../../../src/storage/git.js', () => ({
  getCurrentCommit: vi.fn(() => 'abc123'),
}));

import { listRegisteredRepos } from '../../../src/storage/repo-manager.js';
import { collectAdvisoryDocsEvidence } from '../../../src/mcp/super/docs-evidence.js';
import { gnDocs } from '../../../src/mcp/super/docs.js';

const mockListRegisteredRepos = vi.mocked(listRegisteredRepos);
const tmpDirs: string[] = [];

async function createRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-docs-evidence-'));
  tmpDirs.push(root);
  const repoPath = path.join(root, 'repo');
  const storagePath = path.join(root, 'storage');
  await fs.mkdir(repoPath, { recursive: true });
  const repo = {
    name: 'test-repo',
    path: repoPath,
    storagePath,
    indexedAt: '2026-05-13T00:00:00.000Z',
    lastCommit: 'abc123',
    stats: { files: 2, nodes: 3, edges: 4 },
  };
  mockListRegisteredRepos.mockResolvedValue([repo]);
  return repo;
}

async function writeSidecarStore(storagePath: string, contents: unknown): Promise<void> {
  const storePath = path.join(storagePath, 'enrichment', 'sidecar-store.json');
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

function state(status: 'complete' | 'stale' = 'complete') {
  return {
    schemaVersion: 1,
    requests: [],
    lock: null,
    enrichments: [
      {
        sourceIndexId: 'idx-1',
        sourceCommitHash: 'abc123',
        analyzerId: 'markdown-document',
        analyzerVersion: '1.0.0',
        filePath: 'docs/api.md',
        fileHash: 'doc-hash',
        status,
        confidence: 0.95,
        records: [
          {
            kind: 'markdown-requirement',
            schemaVersion: 1,
            docPath: 'docs/requirements.md',
            headingPath: ['Requirements'],
            lineSpan: { start: 10, end: 12 },
            sourceChunkKey: 'chunk:req',
            normalizedKey: 'REQ-AUTH-1',
            confidence: 0.95,
            requirementId: 'REQ-AUTH-1',
            title: 'Token parsing',
            source: 'heading',
            evidence: {
              text: 'REQ-AUTH-1 Token parsing',
              raw: 'REQ-AUTH-1',
              lineSpan: { start: 10, end: 12 },
            },
          },
          {
            kind: 'markdown-api-spec',
            schemaVersion: 1,
            docPath: 'docs/api.md',
            headingPath: ['API'],
            lineSpan: { start: 20, end: 20 },
            sourceChunkKey: 'chunk:api',
            normalizedKey: 'GET /tokens',
            confidence: 0.9,
            method: 'GET',
            path: '/tokens',
            routeKey: 'GET /tokens',
            evidence: { text: 'GET /tokens', raw: 'GET /tokens', lineSpan: { start: 20, end: 20 } },
          },
          {
            kind: 'markdown-doc-resolution',
            schemaVersion: 1,
            resolverId: 'markdown-doc-resolver',
            resolverVersion: '1.0.0',
            sourceIndexId: 'idx-1',
            sourceCommitHash: 'abc123',
            graphSchemaVersion: 1,
            docPath: 'docs/requirements.md',
            factKey: 'REQ-AUTH-1',
            factKind: 'markdown-requirement',
            subjectKind: 'requirement',
            resolutionKey: 'req-resolution',
            status: 'resolved',
            confidence: 0.91,
            evidenceKind: 'lexical',
            reasons: ['requirement-linked-symbol'],
            targetGraphIdentity: {
              type: 'symbol',
              id: 'Function:src/auth.ts:parseToken',
              name: 'parseToken',
              filePath: 'src/auth.ts',
              confidence: 0.91,
            },
            candidates: [],
            lineSpan: { start: 10, end: 12 },
          },
          {
            kind: 'markdown-doc-resolution',
            schemaVersion: 1,
            resolverId: 'markdown-doc-resolver',
            resolverVersion: '1.0.0',
            sourceIndexId: 'idx-1',
            sourceCommitHash: 'abc123',
            graphSchemaVersion: 1,
            docPath: 'docs/api.md',
            factKey: 'GET /tokens',
            factKind: 'markdown-api-spec',
            subjectKind: 'route',
            resolutionKey: 'route-resolution',
            status: status === 'stale' ? 'stale' : 'resolved',
            confidence: 0.88,
            evidenceKind: 'graph-structural',
            reasons: status === 'stale' ? ['stale-route-link'] : ['route-linked-api-spec'],
            targetGraphIdentity: {
              type: 'route',
              id: 'Route:GET /tokens',
              filePath: 'src/routes/tokens.ts',
              method: 'GET',
              routePath: '/tokens',
              confidence: 0.88,
            },
            candidates: [],
            lineSpan: { start: 20, end: 20 },
          },
        ],
      },
    ],
  };
}

function traceState(requirementIds: readonly string[]) {
  return {
    schemaVersion: 1,
    requests: [],
    lock: null,
    enrichments: [
      {
        sourceIndexId: 'idx-1',
        sourceCommitHash: 'abc123',
        analyzerId: 'markdown-document',
        analyzerVersion: '1.0.0',
        filePath: 'docs/requirements.md',
        fileHash: 'doc-hash',
        status: 'complete',
        confidence: 0.95,
        records: requirementIds.flatMap((requirementId, index) => [
          {
            kind: 'markdown-requirement',
            schemaVersion: 1,
            docPath: 'docs/requirements.md',
            headingPath: ['Requirements'],
            lineSpan: { start: 10 + index, end: 10 + index },
            sourceChunkKey: `chunk:req:${index}`,
            normalizedKey: requirementId,
            confidence: 0.95,
            requirementId,
            title: `Title ${requirementId}`,
            source: 'heading',
            evidence: {
              text: `${requirementId} Title`,
              raw: requirementId,
              lineSpan: { start: 10 + index, end: 10 + index },
            },
          },
          {
            kind: 'markdown-doc-resolution',
            schemaVersion: 1,
            resolverId: 'markdown-doc-resolver',
            resolverVersion: '1.0.0',
            sourceIndexId: 'idx-1',
            sourceCommitHash: 'abc123',
            graphSchemaVersion: 1,
            docPath: 'docs/requirements.md',
            factKey: requirementId,
            factKind: 'markdown-requirement',
            subjectKind: 'requirement',
            resolutionKey: `req-resolution:${index}`,
            status: 'resolved',
            confidence: 0.91,
            evidenceKind: 'lexical',
            reasons: ['requirement-linked-symbol'],
            targetGraphIdentity: {
              type: 'symbol',
              id: `Function:src/auth.ts:parseToken${index}`,
              name: `parseToken${index}`,
              filePath: 'src/auth.ts',
              confidence: 0.91,
            },
            candidates: [],
            lineSpan: { start: 10 + index, end: 10 + index },
          },
        ]),
      },
    ],
  };
}

describe('collectAdvisoryDocsEvidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('returns requirement-linked docs evidence for a changed symbol', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, state());

    const report = await collectAdvisoryDocsEvidence('test-repo', [
      { nodeId: 'Function:src/auth.ts:parseToken', name: 'parseToken', filePath: 'src/auth.ts' },
    ]);

    expect(report.sidecar.status).toBe('complete');
    expect(report.docEvidence).toEqual([
      expect.objectContaining({
        kind: 'requirement',
        docPath: 'docs/requirements.md',
        requirementId: 'REQ-AUTH-1',
        confidence: 0.91,
      }),
    ]);
    expect(report.relatedDocs[0]).toMatchObject({
      docPath: 'docs/requirements.md',
      freshness: 'fresh',
    });
  });

  it('returns API route evidence for a changed public route file', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, state());

    const report = await collectAdvisoryDocsEvidence('test-repo', [
      { filePath: 'src/routes/tokens.ts', method: 'GET', routePath: '/tokens' },
    ]);

    expect(report.docEvidence[0]).toMatchObject({
      kind: 'api-spec',
      routeKey: 'GET /tokens',
      method: 'GET',
      path: '/tokens',
    });
  });

  it('degrades stale route docs as advisory context without dropping evidence', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, state('stale'));

    const report = await collectAdvisoryDocsEvidence('test-repo', [
      { filePath: 'src/routes/tokens.ts', method: 'GET', routePath: '/tokens' },
    ]);

    expect(report.freshness.stale).toBe(true);
    expect(report.docEvidence[0]).toMatchObject({
      kind: 'route-drift',
      stale: true,
      reasons: ['stale-route-link'],
    });
  });

  it('returns empty advisory metadata when the sidecar is missing', async () => {
    await createRepo();

    const report = await collectAdvisoryDocsEvidence('test-repo', [{ filePath: 'src/missing.ts' }]);

    expect(report.sidecar.status).toBe('missing');
    expect(report.docEvidence).toEqual([]);
    expect(report.relatedDocs).toEqual([]);
    expect(report.limits.truncated).toBe(false);
  });

  it('paginates docs trace output with deterministic cursors', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, traceState(['REQ-1', 'REQ-2', 'REQ-3']));

    const firstPage = await gnDocs('test-repo', { action: 'trace', maxItems: 1 });
    expect(firstPage.responseMode).toBe('full');
    if (!('docsEvidence' in firstPage) || !('cursor' in firstPage))
      throw new Error('expected full report');
    expect(firstPage.docsEvidence).toHaveLength(1);
    expect(firstPage.limits).toMatchObject({ emitted: 1, total: 3, truncated: true, maxItems: 1 });
    expect(firstPage.cursor).toMatchObject({
      offset: 0,
      pageSize: 1,
      returned: 1,
      total: 3,
      hasMore: true,
    });

    const secondPage = await gnDocs('test-repo', {
      action: 'trace',
      maxItems: 5,
      cursor: firstPage.cursor?.next,
    });
    if (!('docsEvidence' in secondPage) || !('cursor' in secondPage))
      throw new Error('expected full report');
    expect(secondPage.docsEvidence).toHaveLength(1);
    expect(secondPage.cursor).toMatchObject({
      offset: 1,
      pageSize: 1,
      returned: 1,
      total: 3,
      hasMore: true,
    });
  });

  it('supports summary and minimal docs trace modes', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, traceState(['REQ-1', 'REQ-2']));

    const summary = await gnDocs('test-repo', { action: 'trace', summary: true, maxItems: 1 });
    expect(summary.responseMode).toBe('summary');
    if (!('docsEvidence' in summary)) throw new Error('expected summary report');
    expect(summary.primaryGraphFacts).toEqual([]);
    expect(summary.docsEvidence[0]).toMatchObject({
      requirementId: 'REQ-1',
      implementationEvidenceCount: 1,
      testCount: 0,
    });

    const minimal = await gnDocs('test-repo', { action: 'trace', minimal: true, maxItems: 1 });
    expect(minimal).toMatchObject({
      responseMode: 'minimal',
      result: {
        sidecarStatus: 'complete',
        emitted: 1,
        total: 2,
        truncated: true,
      },
    });
    expect(minimal.nextAction).toContain('cursor');
    expect('docsEvidence' in minimal).toBe(false);
  });
});
