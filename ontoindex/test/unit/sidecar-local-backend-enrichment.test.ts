import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { backendMocks } = vi.hoisted(() => ({
  backendMocks: {
    queryImpl: vi.fn(),
    contextImpl: vi.fn(),
    runImpact: vi.fn(),
    initLbug: vi.fn().mockResolvedValue(undefined),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
    isLbugDbPathReady: vi.fn().mockResolvedValue(true),
    executeParameterized: vi.fn().mockResolvedValue([]),
    listRegisteredRepos: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: backendMocks.initLbug,
  closeLbug: backendMocks.closeLbug,
  isLbugReady: backendMocks.isLbugReady,
  isLbugDbPathReady: backendMocks.isLbugDbPathReady,
  isWriteQuery: vi.fn().mockReturnValue(false),
  executeParameterized: backendMocks.executeParameterized,
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: backendMocks.listRegisteredRepos,
}));

vi.mock('../../src/mcp/local/backend-search.js', () => ({
  query: backendMocks.queryImpl,
}));

vi.mock('../../src/mcp/local/backend-context.js', () => ({
  context: backendMocks.contextImpl,
}));

vi.mock('../../src/mcp/local/backend-impact.js', () => ({
  impactByUid: vi.fn().mockResolvedValue(null),
  runImpact: backendMocks.runImpact,
  isTestFilePath: vi.fn().mockReturnValue(false),
  VALID_RELATION_TYPES: ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'],
  IMPACT_RELATION_CONFIDENCE: {},
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import {
  createMarkdownDocumentEnrichmentQueueRequest,
  createMarkdownSidecarRunnerExecutor,
  getSidecarStorePath,
  LocalSidecarStore,
} from '../../src/core/ingestion/enrichment/index.js';

const tmpDirs: string[] = [];

async function createRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-sidecar-local-backend-'));
  tmpDirs.push(root);
  const repoPath = path.join(root, 'repo');
  const storagePath = path.join(root, 'storage');
  await fs.mkdir(path.join(storagePath, 'lbug'), { recursive: true });
  const entry = {
    name: 'test-project',
    path: repoPath,
    storagePath,
    indexedAt: '2026-05-13T00:00:00.000Z',
    lastCommit: 'abc123',
    stats: { files: 1, nodes: 2, edges: 3, communities: 0, processes: 0 },
  };
  backendMocks.listRegisteredRepos.mockResolvedValue([entry]);
  return entry;
}

async function writeSidecarStore(storagePath: string, contents: unknown): Promise<void> {
  const storePath = path.join(storagePath, 'enrichment', 'sidecar-store.json');
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

function sidecarState() {
  const now = '2026-05-13T00:00:00.000Z';
  return {
    schemaVersion: 1,
    requests: [
      {
        id: 'queued-request',
        repoId: 'test-project',
        sourceIndexId: 'idx-1',
        analyzerId: 'sidecar',
        analyzerVersion: '1.0.0',
        purpose: 'targeted-symbol-lookup',
        scopeHash: 'scope-1',
        priority: 'recent-query',
        status: 'queued',
        durability: 'volatile',
        requestedAt: now,
        updatedAt: now,
        mergedRequestIds: [],
      },
      {
        id: 'running-request',
        repoId: 'test-project',
        sourceIndexId: 'idx-1',
        analyzerId: 'sidecar',
        analyzerVersion: '1.0.0',
        purpose: 'type-aware-resolution',
        scopeHash: 'scope-2',
        priority: 'public-api',
        status: 'running',
        durability: 'persistent',
        requestedAt: now,
        updatedAt: now,
        mergedRequestIds: [],
      },
    ],
    lock: {
      ownerId: 'worker-q',
      pid: 12345,
      startedAt: now,
      heartbeatAt: '2026-05-13T00:00:05.000Z',
      sourceIndexId: 'idx-1',
      analyzerId: 'sidecar',
      leaseExpiresAt: '2026-05-13T00:01:05.000Z',
    },
    enrichments: [
      {
        sourceIndexId: 'idx-1',
        sourceCommitHash: 'abc123',
        analyzerId: 'sidecar',
        analyzerVersion: '1.0.0',
        filePath: 'src/a.ts',
        fileHash: 'hash-a',
        status: 'complete',
        confidence: 0.95,
        records: [{ kind: 'symbol-summary', symbol: 'main', detail: 'stable fact' }],
      },
      {
        sourceIndexId: 'idx-1',
        sourceCommitHash: 'abc123',
        analyzerId: 'sidecar',
        analyzerVersion: '1.0.0',
        filePath: 'src/b.ts',
        fileHash: 'hash-b',
        status: 'partial',
        confidence: 0.9,
        records: [{ kind: 'type-resolution', symbol: 'helper', detail: 'partial fact' }],
      },
      {
        sourceIndexId: 'idx-1',
        sourceCommitHash: 'abc123',
        analyzerId: 'sidecar',
        analyzerVersion: '1.0.0',
        filePath: 'src/low.ts',
        fileHash: 'hash-low',
        status: 'complete',
        confidence: 0.4,
        records: [{ kind: 'symbol-summary', symbol: 'low', detail: 'low confidence fact' }],
      },
      {
        sourceIndexId: 'old-idx',
        sourceCommitHash: 'old123',
        analyzerId: 'sidecar',
        analyzerVersion: '1.0.0',
        filePath: 'src/c.ts',
        fileHash: 'hash-c',
        status: 'complete',
        confidence: 0.99,
        records: [{ kind: 'symbol-summary', symbol: 'old', detail: 'stale fact' }],
      },
    ],
  };
}

function passiveSidecarState() {
  const state = sidecarState();
  return {
    ...state,
    enrichments: [
      {
        sourceIndexId: 'idx-1',
        sourceCommitHash: 'abc123',
        schemaVersion: 1,
        analyzerId: 'axel',
        analyzerVersion: '1.0.0',
        filePath: 'src/a.ts',
        fileHash: 'hash-a',
        status: 'complete',
        confidence: 0.95,
        records: [
          {
            kind: 'semantic-bridge',
            subject: {
              type: 'symbol',
              id: 'Function:src/a.ts:main',
              filePath: 'src/a.ts',
            },
            from: {
              type: 'symbol',
              id: 'Function:src/a.ts:main',
              filePath: 'src/a.ts',
            },
            to: {
              type: 'symbol',
              id: 'Function:src/b.ts:helper',
              filePath: 'src/b.ts',
            },
            bridgeType: 'usage',
            confidence: 0.9,
            evidence: [],
            referencedFiles: [
              { filePath: 'src/a.ts', fileHash: 'hash-a' },
              { filePath: 'src/b.ts', fileHash: 'hash-b' },
            ],
          },
        ],
      },
    ],
  };
}

function markdownSidecarState() {
  const state = passiveSidecarState();
  return {
    ...state,
    enrichments: [
      {
        ...state.enrichments[0],
        records: [
          ...state.enrichments[0].records,
          {
            kind: 'markdown-chunk',
            docPath: 'docs/auth.md',
            fileHash: 'doc-hash',
            sourceCommitHash: 'abc123',
            headingPath: ['Auth', 'Login Flow'],
            lineSpan: { start: 10, end: 18 },
            chunkIndex: 0,
            normalizedAnchor: 'login-flow',
            contentHash: 'chunk-hash',
            chunkKey: 'markdown-chunk:docs/auth.md:doc-hash:Auth/Login Flow:login-flow:chunk-hash',
            excerpt: 'Login flow notes',
          },
        ],
      },
    ],
  };
}

function docsEvidenceSidecarState() {
  const state = passiveSidecarState();
  const base = state.enrichments[0];
  const makeChunk = (index: number, docPath = `docs/m7-${index}.md`) => ({
    kind: 'markdown-chunk',
    docPath,
    fileHash: `doc-hash-${index}`,
    sourceCommitHash: 'abc123',
    headingPath: ['M7', `Section ${index}`],
    lineSpan: { start: index + 1, end: index + 2 },
    chunkIndex: index,
    normalizedAnchor: `section-${index}`,
    contentHash: `chunk-hash-${index}`,
    chunkKey: `markdown-chunk:${docPath}:doc-hash-${index}:M7/Section ${index}:section-${index}:chunk-hash-${index}`,
    excerpt: `M7 docs evidence ${index}`,
  });
  const chunks = Array.from({ length: 12 }, (_, index) => makeChunk(index));
  return {
    ...state,
    enrichments: [
      {
        ...base,
        records: [
          ...base.records,
          ...chunks,
          {
            kind: 'markdown-requirement',
            schemaVersion: 1,
            docPath: 'docs/m7-0.md',
            headingPath: ['M7', 'Section 0'],
            lineSpan: { start: 1, end: 1 },
            sourceChunkKey: chunks[0].chunkKey,
            normalizedKey: 'req-m7-1',
            confidence: 0.95,
            requirementId: 'REQ-M7-1',
            title: 'Query docs evidence',
            source: 'heading',
            evidence: {
              text: 'REQ-M7-1 Query docs evidence',
              raw: 'REQ-M7-1',
              lineSpan: { start: 1, end: 1 },
            },
          },
          {
            kind: 'markdown-api-spec',
            schemaVersion: 1,
            docPath: 'docs/m7-1.md',
            headingPath: ['M7', 'Section 1'],
            lineSpan: { start: 2, end: 2 },
            sourceChunkKey: chunks[1].chunkKey,
            normalizedKey: 'get-/m7',
            confidence: 0.9,
            method: 'GET',
            path: '/m7',
            routeKey: 'GET /m7',
            evidence: { text: 'GET /m7', raw: 'GET /m7', lineSpan: { start: 2, end: 2 } },
          },
          {
            kind: 'markdown-code-mention',
            chunkKey: chunks[2].chunkKey,
            target: { type: 'symbol', id: 'Function:src/a.ts:main', filePath: 'src/a.ts' },
            confidence: 0.7,
            resolutionStatus: 'ambiguous',
            candidates: [
              {
                type: 'symbol',
                id: 'Function:src/a.ts:main',
                filePath: 'src/a.ts',
                confidence: 0.7,
              },
              {
                type: 'symbol',
                id: 'Function:src/a.ts:main2',
                filePath: 'src/a.ts',
                confidence: 0.69,
              },
            ],
            evidence: { text: '`main`', lineSpan: { start: 3, end: 3 } },
          },
        ],
      },
      {
        ...base,
        filePath: 'docs/partial.md',
        fileHash: 'partial-hash',
        status: 'partial',
        records: [makeChunk(12, 'docs/partial.md')],
      },
      {
        ...base,
        filePath: 'docs/stale.md',
        fileHash: 'stale-hash',
        status: 'stale',
        records: [makeChunk(13, 'docs/stale.md')],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMocks.queryImpl.mockResolvedValue({ definitions: [] });
  backendMocks.contextImpl.mockResolvedValue({ symbol: { name: 'main' } });
  backendMocks.runImpact.mockResolvedValue({ impactedCount: 0, risk: 'LOW' });
  backendMocks.initLbug.mockResolvedValue(undefined);
  backendMocks.closeLbug.mockResolvedValue(undefined);
  backendMocks.isLbugReady.mockReturnValue(true);
  backendMocks.isLbugDbPathReady.mockResolvedValue(true);
  backendMocks.executeParameterized.mockResolvedValue([]);
});

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('LocalBackend sidecar enrichment metadata', () => {
  it('decorates query, context, and impact results with available sidecar status', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, sidecarState());
    const backend = new LocalBackend();

    const query = await backend.callTool('query', { query: 'auth' });
    const context = await backend.callTool('context', { name: 'main' });
    const impact = await backend.callTool('impact', { target: 'main', direction: 'upstream' });

    for (const result of [query, context, impact]) {
      expect(result).toMatchObject({
        enrichment: {
          used: false,
          status: 'available',
          recordStatusCounts: {
            complete: 3,
            partial: 1,
            stale: 0,
          },
          requests: {
            queued: 1,
            running: 1,
          },
          lock: {
            ownerId: 'worker-q',
            heartbeatAt: '2026-05-13T00:00:05.000Z',
          },
        },
      });
      expect(result.enrichment).not.toHaveProperty('facts');
      expect(result.enrichment).not.toHaveProperty('factConsumption');
      expect(result.enrichment).not.toHaveProperty('relatedFacts');
      expect(result.enrichment).not.toHaveProperty('relatedSymbols');
      expect(result.enrichment).not.toHaveProperty('summary');
      expect(result).not.toHaveProperty('explanation');
    }
    expect(backendMocks.queryImpl).toHaveBeenCalledTimes(1);
    expect(backendMocks.contextImpl).toHaveBeenCalledTimes(1);
    expect(backendMocks.runImpact).toHaveBeenCalledTimes(1);
  });

  it('keeps primary query fields unchanged when enrichment facts are consumed', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, sidecarState());
    const backend = new LocalBackend();

    const result = await backend.callTool('query', {
      query: 'auth',
      consume_enrichment_facts: true,
    });

    expect(result.definitions).toEqual([]);
    expect(result.enrichment).toMatchObject({
      used: true,
      status: 'available',
      facts: [
        { kind: 'symbol-summary', symbol: 'main' },
        { kind: 'type-resolution', symbol: 'helper' },
      ],
      factConsumption: {
        usedFactCount: 2,
        usedRecordCount: 2,
        rejectedRecordCount: 2,
        rejectionReasons: {
          'low-confidence-rejected': 1,
          'stale-rejected': 1,
        },
      },
    });
    expect(result.enrichment.visibleRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: 'src/low.ts',
          used: false,
          rejectionReason: 'low-confidence-rejected',
        }),
        expect.objectContaining({
          filePath: 'src/c.ts',
          used: false,
          rejectionReason: 'stale-rejected',
        }),
      ]),
    );
  });

  it('keeps passive related fact metadata absent until the explicit query opt-in is complete', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, sidecarState());
    const backend = new LocalBackend();

    const passiveOnly = await backend.callTool('query', {
      query: 'auth',
      include_passive_related_facts: true,
    });
    const factOnly = await backend.callTool('query', {
      query: 'auth',
      consume_enrichment_facts: true,
    });

    for (const result of [passiveOnly, factOnly]) {
      expect(result.definitions).toEqual([]);
      expect(result.enrichment).not.toHaveProperty('relatedFacts');
      expect(result.enrichment).not.toHaveProperty('relatedSymbols');
      expect(result.enrichment).not.toHaveProperty('summary');
      expect(result).not.toHaveProperty('explanation');
    }
  });

  it('adds passive related metadata to MCP query only when both opt-ins are set', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, passiveSidecarState());
    backendMocks.queryImpl.mockResolvedValue({
      processes: [],
      process_symbols: [],
      definitions: [
        {
          id: 'Function:src/a.ts:main',
          name: 'main',
          type: 'function',
          filePath: 'src/a.ts',
        },
      ],
      timing: {},
      query_intent: 'identifier',
    });
    const backend = new LocalBackend();

    const result = await backend.callTool('query', {
      query: 'main',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
    });

    expect(result.definitions).toEqual([
      {
        id: 'Function:src/a.ts:main',
        name: 'main',
        type: 'function',
        filePath: 'src/a.ts',
      },
    ]);
    expect(result.enrichment).toMatchObject({
      relatedFacts: [
        {
          kind: 'semantic-bridge',
          score: 0.99,
          explanation: {
            retriever: 'passive-graph-expansion',
            sourceFactKind: 'semantic-bridge',
            expansionReason: 'exact-subject-match',
          },
        },
      ],
      relatedSymbols: [
        { id: 'Function:src/a.ts:main', filePath: 'src/a.ts' },
        { id: 'Function:src/b.ts:helper', filePath: 'src/b.ts' },
      ],
      summary: {
        passiveFactSelection: {
          candidateCount: 1,
          rejectedRecordCount: 0,
        },
        passiveGraphExpansion: {
          candidateCount: 1,
          expandedFactCount: 1,
        },
      },
    });
    expect(result.explanation).toEqual({
      retrievers: [{ name: 'passive-graph-expansion', factCount: 1, identityCount: 4 }],
    });
  });

  it('keeps Markdown context absent until the explicit MCP query opt-in is complete', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, markdownSidecarState());
    backendMocks.queryImpl.mockResolvedValue({
      processes: [],
      process_symbols: [],
      definitions: [
        {
          id: 'Function:src/a.ts:main',
          name: 'main',
          type: 'function',
          filePath: 'src/a.ts',
        },
      ],
    });
    const backend = new LocalBackend();

    const result = await backend.callTool('query', {
      query: 'main',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
    });

    expect(result.enrichment).not.toHaveProperty('relatedDocs');
    expect(result.enrichment).not.toHaveProperty('relatedChunks');
    expect(result.explanation).toEqual({
      retrievers: [{ name: 'passive-graph-expansion', factCount: 1, identityCount: 4 }],
    });
  });

  it('adds Markdown document metadata to MCP query only with the full opt-in set', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, markdownSidecarState());
    backendMocks.queryImpl.mockResolvedValue({
      processes: [],
      process_symbols: [],
      definitions: [
        {
          id: 'Function:src/a.ts:main',
          name: 'main',
          type: 'function',
          filePath: 'src/a.ts',
        },
      ],
    });
    const backend = new LocalBackend();

    const result = await backend.callTool('query', {
      query: 'main',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });

    expect(result.enrichment.relatedDocs).toEqual([
      expect.objectContaining({
        docPath: 'docs/auth.md',
        fileHash: 'doc-hash',
        sourceCommitHash: 'abc123',
        chunkCount: 1,
        sourcePlane: 'markdown-docs-sidecar',
      }),
    ]);
    expect(result.enrichment.relatedChunks).toEqual([
      expect.objectContaining({
        docPath: 'docs/auth.md',
        headingPath: ['Auth', 'Login Flow'],
        lineSpan: { start: 10, end: 18 },
        normalizedAnchor: 'login-flow',
        contentHash: 'chunk-hash',
        excerpt: 'Login flow notes',
      }),
    ]);
    expect(result.explanation.retrievers).toEqual([
      { name: 'passive-graph-expansion', factCount: 1, identityCount: 4 },
      { name: 'markdown-passive-graph', factCount: 1, docCount: 1, chunkCount: 1 },
    ]);
  });

  it('keeps explicit graph-only policy free of docs expansion', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, markdownSidecarState());
    backendMocks.queryImpl.mockResolvedValue({
      processes: [],
      process_symbols: [],
      definitions: [
        {
          id: 'Function:src/a.ts:main',
          name: 'main',
          type: 'function',
          filePath: 'src/a.ts',
        },
      ],
    });
    const backend = new LocalBackend();

    const result = await backend.callTool('query', {
      query: 'main',
      retrieval_policy: 'graph-only',
    });

    expect(result.definitions).toEqual([
      {
        id: 'Function:src/a.ts:main',
        name: 'main',
        type: 'function',
        filePath: 'src/a.ts',
      },
    ]);
    expect(result.retrievalPolicy).toMatchObject({
      name: 'graph-only',
      docsExpansion: false,
      sourcePlanes: ['graph'],
      pathReasons: ['graph-result'],
    });
    expect(result.enrichment).not.toHaveProperty('relatedDocs');
    expect(result).not.toHaveProperty('relatedDocs');
  });

  it('expands docs through graph-with-passive-docs policy and returns path reasons', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, markdownSidecarState());
    backendMocks.queryImpl.mockResolvedValue({
      processes: [],
      process_symbols: [],
      definitions: [
        {
          id: 'Function:src/a.ts:main',
          name: 'main',
          type: 'function',
          filePath: 'src/a.ts',
        },
      ],
    });
    const backend = new LocalBackend();

    const result = await backend.callTool('query', {
      query: 'main',
      retrieval_policy: 'graph-with-passive-docs',
    });

    expect(result.retrievalPolicy).toMatchObject({
      name: 'graph-with-passive-docs',
      docsExpansion: true,
      passiveExpansion: true,
      sourcePlanes: ['graph', 'sidecar', 'markdown-docs-sidecar'],
      truncation: { truncated: false },
    });
    expect(result.relatedDocs).toEqual([
      expect.objectContaining({
        docPath: 'docs/auth.md',
        sourcePlane: 'markdown-docs-sidecar',
        pathReasons: ['graph-result-to-passive-doc'],
      }),
    ]);
    expect(result.enrichment.relatedChunks[0]).toMatchObject({
      docPath: 'docs/auth.md',
      pathReasons: ['graph-result-to-passive-doc'],
    });
    expect(result.enrichment.relatedSymbols[0]).toMatchObject({
      id: 'Function:src/a.ts:main',
      pathReasons: ['graph-result-to-passive-doc'],
    });
  });

  it('filters requirement and route neighborhoods to matching docs evidence', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, docsEvidenceSidecarState());
    backendMocks.queryImpl.mockResolvedValue({
      processes: [],
      process_symbols: [],
      definitions: [
        {
          id: 'Function:src/a.ts:main',
          name: 'main',
          type: 'function',
          filePath: 'src/a.ts',
        },
      ],
    });
    const backend = new LocalBackend();

    const requirement = await backend.callTool('query', {
      query: 'main',
      retrieval_policy: 'requirement-neighborhood',
    });
    const route = await backend.callTool('query', {
      query: 'main',
      retrieval_policy: 'api-route-neighborhood',
    });

    expect(requirement.retrievalPolicy).toMatchObject({
      name: 'requirement-neighborhood',
      pathReasons: ['graph-result-to-requirement-doc'],
    });
    expect(requirement.relatedDocs).toEqual([
      expect.objectContaining({
        docPath: 'docs/m7-0.md',
        pathReasons: ['graph-result-to-requirement-doc'],
      }),
    ]);
    expect(requirement.enrichment.relatedChunks[0].evidence).toEqual([
      expect.objectContaining({ kind: 'markdown-requirement', requirementId: 'REQ-M7-1' }),
    ]);
    expect(route.retrievalPolicy).toMatchObject({
      name: 'api-route-neighborhood',
      pathReasons: ['graph-result-to-api-route-doc'],
    });
    expect(route.relatedDocs).toEqual([
      expect.objectContaining({
        docPath: 'docs/m7-1.md',
        pathReasons: ['graph-result-to-api-route-doc'],
      }),
    ]);
    expect(route.enrichment.relatedChunks[0].evidence).toEqual([
      expect.objectContaining({ kind: 'markdown-api-spec', routeKey: 'GET /m7' }),
    ]);
  });

  it('returns bounded explicit symbol, route, and process context neighborhoods', async () => {
    await createRepo();
    backendMocks.executeParameterized.mockResolvedValue([
      {
        sourceId: 'Function:src/a.ts:main',
        sourceName: 'main',
        sourceKind: 'Function',
        sourceFilePath: 'src/a.ts',
        targetId: 'Function:src/b.ts:helper',
        targetName: 'helper',
        targetKind: 'Function',
        targetFilePath: 'src/b.ts',
        type: 'CALLS',
      },
    ]);
    const backend = new LocalBackend();

    for (const params of [
      { neighborhood_mode: 'symbol-neighborhood', uid: 'Function:src/a.ts:main' },
      { neighborhood_mode: 'route-neighborhood', route: 'GET /m7' },
      { neighborhood_mode: 'process-neighborhood', process_id: 'Process:login' },
    ]) {
      const result = await backend.callTool('context', { ...params, depth: 2, limit: 1 });
      expect(result).toMatchObject({
        status: 'ok',
        mode: params.neighborhood_mode,
        sourcePlane: 'graph',
        nodes: [expect.objectContaining({ sourcePlane: 'graph' })],
        edges: [expect.objectContaining({ type: 'CALLS', sourcePlane: 'graph' })],
        docsEvidence: [],
        limits: { depth: 2, limit: 1, truncated: true },
      });
    }
  });

  it('returns docs-aware requirement and API-doc neighborhoods only when explicitly requested', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, docsEvidenceSidecarState());
    const backend = new LocalBackend();

    const plain = await backend.callTool('context', { name: 'main' });
    const requirement = await backend.callTool('context', {
      neighborhood_mode: 'requirement-neighborhood',
      requirement_id: 'REQ-M7-1',
    });
    const apiDoc = await backend.callTool('context', {
      neighborhood_mode: 'api-doc-neighborhood',
      api_doc_id: 'GET /m7',
    });

    expect(plain).not.toHaveProperty('docsEvidence');
    expect(requirement.docsEvidence).toEqual([
      expect.objectContaining({
        kind: 'markdown-requirement',
        requirementId: 'REQ-M7-1',
        sourcePlane: 'markdown-docs-sidecar',
      }),
    ]);
    expect(apiDoc.docsEvidence).toEqual([
      expect.objectContaining({
        kind: 'markdown-api-spec',
        routeKey: 'GET /m7',
        sourcePlane: 'markdown-docs-sidecar',
      }),
    ]);
  });

  it('reports unresolved diagnostics for missing docs identities', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, docsEvidenceSidecarState());
    const backend = new LocalBackend();

    const missingRequirement = await backend.callTool('context', {
      neighborhood_mode: 'requirement-neighborhood',
      requirement_id: 'REQ-MISSING',
    });
    const missingApiDoc = await backend.callTool('context', {
      neighborhood_mode: 'api-doc-neighborhood',
      api_doc_id: 'GET /missing',
    });
    const missingDocPath = await backend.callTool('context', {
      neighborhood_mode: 'api-doc-neighborhood',
      doc_path: 'docs/missing.md',
    });

    expect(missingRequirement).toMatchObject({
      status: 'unresolved',
      identity: { status: 'unresolved', type: 'requirement', id: 'REQ-MISSING' },
      diagnostics: expect.arrayContaining([
        'requirement identity not found in docs sidecar: REQ-MISSING',
      ]),
    });
    expect(missingApiDoc).toMatchObject({
      status: 'unresolved',
      identity: { status: 'unresolved', type: 'api-doc', id: 'GET /missing' },
      diagnostics: expect.arrayContaining([
        'api-doc identity not found in docs sidecar: GET /missing',
      ]),
    });
    expect(missingDocPath).toMatchObject({
      status: 'unresolved',
      identity: { status: 'unresolved', type: 'doc', id: 'docs/missing.md' },
      diagnostics: expect.arrayContaining([
        'doc identity not found in docs sidecar: docs/missing.md',
      ]),
    });
  });

  it('preserves stale and ambiguous neighborhood metadata', async () => {
    const repo = await createRepo();
    const state = docsEvidenceSidecarState();
    state.enrichments[0].sourceCommitHash = 'old-commit';
    state.enrichments[0].records.push({
      kind: 'markdown-doc-resolution',
      factKey: 'REQ-M7-1',
      status: 'ambiguous',
      candidates: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      reasons: ['multiple-candidates'],
    });
    await writeSidecarStore(repo.storagePath, state);
    const backend = new LocalBackend();

    const ambiguous = await backend.callTool('context', {
      neighborhood_mode: 'requirement-neighborhood',
      requirement_id: 'REQ-M7-1',
      maxCandidates: 2,
    });

    expect(ambiguous).toMatchObject({
      status: 'ambiguous',
      identity: { status: 'ambiguous', candidateCount: 3, candidates: [{ id: 'a' }, { id: 'b' }] },
      freshness: { status: 'stale', degraded: true, degradedReasons: ['source-commit-mismatch'] },
    });
    expect(ambiguous.docsEvidence[0]).toMatchObject({
      kind: 'markdown-requirement',
      freshness: {
        status: 'stale',
        degraded: true,
        degradedReasons: ['source-commit-mismatch'],
        sourceCommitHash: 'old-commit',
        recordStatus: 'complete',
      },
    });
  });

  it('reports sidecar-missing skip metadata for explicit docs policy', async () => {
    await createRepo();
    const backend = new LocalBackend();

    const result = await backend.callTool('query', {
      query: 'main',
      retrieval_policy: 'graph-with-passive-docs',
    });

    expect(result.retrievalPolicy).toMatchObject({
      name: 'graph-with-passive-docs',
      skipReasons: { 'sidecar-missing': 1 },
    });
    expect(result.enrichment).toMatchObject({
      status: 'unavailable',
      reason: 'missing-store',
    });
  });

  it('exposes runner-persisted Markdown facts through MCP query only with the full opt-in set', async () => {
    const repo = await createRepo();
    const store = new LocalSidecarStore(getSidecarStorePath(repo.storagePath));
    const decision = createMarkdownDocumentEnrichmentQueueRequest({
      enabled: true,
      repoId: repo.name,
      sourceIndexId: 'idx-1',
      scopeHash: 'markdown-scope',
      requestedAt: '2026-05-13T00:00:00.000Z',
    });
    expect(decision.queued).toBe(true);
    if (!decision.queued) {
      throw new Error('expected Markdown sidecar request to be queued');
    }
    const { request } = await store.submitRequest(decision.request);
    const executeMarkdownSidecar = createMarkdownSidecarRunnerExecutor({
      store,
      documents: [
        {
          docPath: 'docs/auth.md',
          sourceCommitHash: repo.lastCommit,
          source: '# Auth\n\n## Login Flow\n\n`main` owns the login flow.\n',
        },
      ],
      resolveCodeMention(mention) {
        if (mention !== 'main') {
          return undefined;
        }
        return {
          target: {
            type: 'symbol',
            id: 'Function:src/a.ts:main',
            filePath: 'src/a.ts',
          },
          confidence: 0.95,
        };
      },
    });
    await executeMarkdownSidecar(request, { heartbeat: async () => true });
    backendMocks.queryImpl.mockResolvedValue({
      processes: [],
      process_symbols: [],
      definitions: [
        {
          id: 'Function:src/a.ts:main',
          name: 'main',
          type: 'function',
          filePath: 'src/a.ts',
        },
      ],
    });
    const backend = new LocalBackend();

    const withoutMarkdownOptIn = await backend.callTool('query', {
      query: 'main',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
    });
    const withMarkdownOptIn = await backend.callTool('query', {
      query: 'main',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });
    const withMarkdownPpr = await backend.callTool('query', {
      query: 'main',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
      include_markdown_ppr: true,
    });

    expect(withoutMarkdownOptIn.enrichment).not.toHaveProperty('relatedDocs');
    expect(withoutMarkdownOptIn.enrichment).not.toHaveProperty('relatedChunks');
    expect(withMarkdownOptIn.enrichment).not.toHaveProperty('markdownPpr');
    expect(withMarkdownOptIn.enrichment.relatedDocs).toEqual([
      expect.objectContaining({
        docPath: 'docs/auth.md',
        sourceCommitHash: repo.lastCommit,
      }),
    ]);
    expect(withMarkdownOptIn.enrichment.relatedChunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          docPath: 'docs/auth.md',
          headingPath: ['Auth', 'Login Flow'],
          excerpt: expect.stringContaining('login flow'),
        }),
      ]),
    );
    expect(withMarkdownOptIn.explanation.retrievers).toEqual([
      { name: 'passive-graph-expansion', factCount: 0, identityCount: 0 },
      { name: 'markdown-passive-graph', factCount: 5, docCount: 1, chunkCount: 2 },
    ]);
    expect(withMarkdownPpr.enrichment.markdownPpr).toMatchObject({
      summary: {
        topK: 8,
        maxHops: 2,
        maxVisitedNodes: 25,
        restartProbability: 0.15,
        degraded: false,
      },
      explanation: {
        retrievers: [
          expect.objectContaining({
            name: 'markdown-passive-graph',
            traversedNodeTypes: expect.arrayContaining(['chunk', 'doc', 'section']),
          }),
        ],
      },
    });
    expect(withMarkdownPpr.enrichment.markdownPpr.rankedIds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'markdown-doc:docs/auth.md', type: 'doc' }),
        expect.objectContaining({ type: 'chunk' }),
      ]),
    );
  });

  it('adds bounded docs evidence metadata to MCP query with the full Markdown opt-in set', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, docsEvidenceSidecarState());
    backendMocks.queryImpl.mockResolvedValue({
      processes: [],
      process_symbols: [],
      definitions: [
        {
          id: 'Function:src/a.ts:main',
          name: 'main',
          type: 'function',
          filePath: 'src/a.ts',
        },
      ],
    });
    const backend = new LocalBackend();

    const result = await backend.callTool('query', {
      query: 'main',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });

    expect(result.definitions).toEqual([
      {
        id: 'Function:src/a.ts:main',
        name: 'main',
        type: 'function',
        filePath: 'src/a.ts',
      },
    ]);
    expect(result.enrichment.relatedDocs).toHaveLength(5);
    expect(result.enrichment.relatedChunks).toHaveLength(10);
    expect(result.enrichment.relatedChunks[0]).toMatchObject({
      sourcePlane: 'markdown-docs-sidecar',
      freshness: [expect.objectContaining({ freshnessReason: 'fresh', used: true })],
    });
    expect(result.enrichment.relatedChunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          docPath: 'docs/m7-0.md',
          evidence: expect.arrayContaining([
            expect.objectContaining({ kind: 'markdown-requirement', requirementId: 'REQ-M7-1' }),
          ]),
        }),
        expect.objectContaining({
          docPath: 'docs/m7-1.md',
          evidence: expect.arrayContaining([
            expect.objectContaining({ kind: 'markdown-api-spec', routeKey: 'GET /m7' }),
          ]),
        }),
      ]),
    );
    expect(result.enrichment.docsEvidence).toMatchObject({
      sourcePlane: 'markdown-docs-sidecar',
      degraded: {
        partialRecordCount: expect.any(Number),
        staleRecordCount: expect.any(Number),
        ambiguousLinkCount: 1,
        staleLinkCount: 0,
      },
      limits: {
        maxRelatedDocs: 5,
        maxRelatedChunks: 10,
        relatedDocsTruncated: true,
        relatedChunksTruncated: true,
        truncated: true,
      },
    });
    expect(result.enrichment.docsEvidence.degraded.partialRecordCount).toBeGreaterThan(0);
    expect(result.enrichment.docsEvidence.degraded.staleRecordCount).toBeGreaterThan(0);
    expect(result.enrichment.docsEvidence.skipReasons).toMatchObject({
      'status-rejected': expect.any(Number),
    });
    expect(result.enrichment.docsEvidence.ambiguousLinks).toEqual([
      expect.objectContaining({
        kind: 'markdown-code-mention',
        resolutionStatus: 'ambiguous',
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: 'Function:src/a.ts:main' }),
        ]),
      }),
    ]);
    expect(result.explanation.retrievers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'markdown-passive-graph',
          truncated: true,
          limits: { maxRelatedDocs: 5, maxRelatedChunks: 10 },
        }),
      ]),
    );
  });

  it('keeps primary context fields unchanged when enrichment facts are consumed', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, sidecarState());
    const backend = new LocalBackend();

    const result = await backend.callTool('context', {
      name: 'main',
      consume_enrichment_facts: true,
      allow_low_confidence: true,
    });

    expect(result.symbol).toEqual({ name: 'main' });
    expect(result.enrichment).toMatchObject({
      used: true,
      facts: [
        { kind: 'symbol-summary', symbol: 'main' },
        { kind: 'type-resolution', symbol: 'helper' },
        { kind: 'symbol-summary', symbol: 'low' },
      ],
      factConsumption: {
        usedFactCount: 3,
        rejectedRecordCount: 1,
        rejectionReasons: { 'stale-rejected': 1 },
      },
    });
  });

  it('adds Markdown document metadata to MCP context only with the full opt-in set', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, markdownSidecarState());
    backendMocks.contextImpl.mockResolvedValue({
      status: 'found',
      symbol: {
        uid: 'Function:src/a.ts:main',
        name: 'main',
        kind: 'Function',
        filePath: 'src/a.ts',
      },
      incoming: {},
      outgoing: {},
      processes: [],
    });
    const backend = new LocalBackend();

    const withoutMarkdownOptIn = await backend.callTool('context', {
      name: 'main',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
    });
    const withMarkdownOptIn = await backend.callTool('context', {
      name: 'main',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });

    expect(withoutMarkdownOptIn.enrichment).not.toHaveProperty('relatedDocs');
    expect(withoutMarkdownOptIn.enrichment).not.toHaveProperty('docsEvidence');
    expect(withMarkdownOptIn.symbol).toMatchObject({
      uid: 'Function:src/a.ts:main',
      filePath: 'src/a.ts',
    });
    expect(withMarkdownOptIn.enrichment.relatedDocs).toEqual([
      expect.objectContaining({
        docPath: 'docs/auth.md',
        sourcePlane: 'markdown-docs-sidecar',
      }),
    ]);
    expect(withMarkdownOptIn.enrichment.docsEvidence).toMatchObject({
      sourcePlane: 'markdown-docs-sidecar',
      limits: {
        truncated: false,
        maxRelatedDocs: 5,
        maxRelatedChunks: 10,
      },
    });
    expect(withMarkdownOptIn.explanation.retrievers).toEqual([
      { name: 'passive-graph-expansion', factCount: 1, identityCount: 4 },
      { name: 'markdown-passive-graph', factCount: 1, docCount: 1, chunkCount: 1 },
    ]);
  });

  it('requires explicit safety-critical opt-in before impact consumes enrichment facts', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, sidecarState());
    const backend = new LocalBackend();

    const strict = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      consume_enrichment_facts: true,
    });
    const allowed = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      consume_enrichment_facts: true,
      allow_safety_critical_enrichment: true,
    });

    expect(strict.risk).toBe('LOW');
    expect(strict.impactedCount).toBe(0);
    expect(strict.enrichment).toMatchObject({
      used: false,
      facts: [],
      factConsumption: {
        usedFactCount: 0,
        rejectionReasons: {
          'safety-critical-opt-in-required': 3,
          'stale-rejected': 1,
        },
      },
    });
    expect(allowed).toMatchObject({
      impactedCount: 0,
      risk: 'LOW',
      enrichment: {
        used: true,
        facts: [{ kind: 'symbol-summary', symbol: 'main' }],
        factConsumption: {
          usedFactCount: 1,
          rejectionReasons: {
            'fresh-partial-rejected': 1,
            'low-confidence-rejected': 1,
            'stale-rejected': 1,
          },
        },
      },
    });
  });

  it('reports unavailable metadata when no sidecar store exists', async () => {
    await createRepo();
    const backend = new LocalBackend();

    const result = await backend.callTool('query', { query: 'auth' });

    expect(result).toMatchObject({
      definitions: [],
      enrichment: {
        used: false,
        status: 'unavailable',
        reason: 'missing-store',
        requests: { queued: 0, running: 0 },
        lock: null,
      },
    });
  });

  it('reports error metadata without failing the read path when the sidecar store is corrupt', async () => {
    const repo = await createRepo();
    const storePath = path.join(repo.storagePath, 'enrichment', 'sidecar-store.json');
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, '{not-json', 'utf8');
    const backend = new LocalBackend();

    const result = await backend.callTool('context', { name: 'main' });

    expect(result).toMatchObject({
      symbol: { name: 'main' },
      enrichment: {
        used: false,
        status: 'error',
        requests: { queued: 0, running: 0 },
        lock: null,
      },
    });
    expect(result.enrichment.error).toContain('not valid JSON');
  });
});
