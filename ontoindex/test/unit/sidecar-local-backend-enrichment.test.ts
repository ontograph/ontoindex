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
  resolveActiveIndexGeneration: vi.fn().mockResolvedValue(null),
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
  MARKDOWN_DOCUMENT_ANALYZER_ID,
} from '../../src/core/ingestion/enrichment/index.js';

const tmpDirs: string[] = [];

const { mentionMocks } = vi.hoisted(() => ({ mentionMocks: { findSymbols: vi.fn() } }));

vi.mock(
  '../../src/core/ingestion/enrichment/markdown-graph-identity-provider.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../src/core/ingestion/enrichment/markdown-graph-identity-provider.js')
    >()),
    LbugGraphIdentityProvider: class {
      findSymbols = mentionMocks.findSymbols;
    },
  }),
);

function mentionSidecarState() {
  const state = markdownSidecarState();
  const base = state.enrichments[0];
  const chunk = base.records.find((fact) => fact.kind === 'markdown-chunk')!;
  return {
    ...state,
    enrichments: [
      {
        ...base,
        records: [
          chunk,
          {
            kind: 'markdown-code-mention',
            chunkKey: chunk.chunkKey,
            confidence: 0,
            resolutionStatus: 'unresolved',
            evidence: { text: 'buildPhaseList', lineSpan: { start: 12, end: 12 } },
          },
        ],
      },
    ],
  };
}

describe('MR2- Markdown mention backend wiring', () => {
  beforeEach(() => {
    mentionMocks.findSymbols.mockReset().mockResolvedValue([
      {
        type: 'symbol',
        id: 'Function:src/x.ts:buildPhaseList',
        name: 'buildPhaseList',
        filePath: 'src/x.ts',
        startLine: 10,
        confidence: 0.9,
      },
    ]);
  });

  const options = {
    query: 'login',
    consume_enrichment_facts: true,
    include_passive_related_facts: true,
    include_markdown_context: true,
  };

  it('MR2-A attaches resolved graph targets to returned chunk evidence', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, mentionSidecarState());
    const result = await new LocalBackend().callTool('query', options);
    expect(result.enrichment.relatedChunks).toHaveLength(1);
    expect(result.enrichment.relatedChunks[0].evidence).toEqual([
      expect.objectContaining({
        mention: 'buildPhaseList',
      }),
    ]);
    expect(result.enrichment.relatedChunks[0].evidence[0]).not.toHaveProperty('graphResolution');
    expect(result.enrichment.mentionTargets.buildPhaseList).toEqual({
      status: 'resolved',
      targets: [
        {
          id: 'Function:src/x.ts:buildPhaseList',
          name: 'buildPhaseList',
          filePath: 'src/x.ts',
          startLine: 10,
        },
      ],
    });
    expect(mentionMocks.findSymbols).toHaveBeenCalledTimes(1);
    expect(result.enrichment.mentionResolution).toMatchObject({ status: 'ok', lookups: 1 });
  });

  it('MR2-B preserves chunk keys and order when the provider throws', async () => {
    const repo = await createRepo();
    const state = mentionSidecarState();
    const base = state.enrichments[0];
    const chunk = base.records[0];
    const secondChunk = { ...chunk, chunkKey: `${chunk.chunkKey}:second`, chunkIndex: 1 };
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: [{ ...base, records: [chunk, secondChunk] }],
    });
    const backend = new LocalBackend();
    const baseline = await backend.callTool('query', options);
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: [{ ...base, records: [...base.records, secondChunk] }],
    });
    mentionMocks.findSymbols.mockRejectedValue(new Error('graph unavailable'));
    const result = await backend.callTool('query', options);
    expect(baseline.enrichment.relatedChunks).toHaveLength(2);
    expect(result.enrichment.relatedChunks.map((value: any) => value.chunkKey)).toEqual(
      baseline.enrichment.relatedChunks.map((value: any) => value.chunkKey),
    );
    expect(['skipped', 'partial']).toContain(result.enrichment.mentionResolution?.status);
    expect(result.enrichment.mentionResolution).toMatchObject({ lookups: expect.any(Number) });
    expect(result.enrichment.mentionTargets ?? {}).toEqual({});
  });

  it('MR2-C does not look up mentions belonging to chunks outside the returned set', async () => {
    const repo = await createRepo();
    const state = mentionSidecarState();
    const base = state.enrichments[0];
    const chunk = base.records[0];
    const hiddenChunk = { ...chunk, chunkKey: `${chunk.chunkKey}:hidden`, chunkIndex: 20 };
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: [
        {
          ...base,
          records: [
            ...Array.from({ length: 11 }, (_, index) => ({
              ...chunk,
              chunkKey: `returned-${index}`,
              chunkIndex: index,
            })),
            hiddenChunk,
            { ...base.records[1], chunkKey: hiddenChunk.chunkKey },
          ],
        },
      ],
    });
    const result = await new LocalBackend().callTool('query', options);
    expect(result.enrichment.relatedChunks).toHaveLength(10);
    expect(result.enrichment.relatedChunks.map((value: any) => value.chunkKey)).not.toContain(
      hiddenChunk.chunkKey,
    );
    expect(mentionMocks.findSymbols).not.toHaveBeenCalled();
    expect(result.enrichment.mentionResolution).toMatchObject({ status: 'ok', lookups: 0 });
  });

  it('MR2-D does not look up mentions without Markdown context opt-in', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, mentionSidecarState());
    const { include_markdown_context: _includeMarkdownContext, ...withoutMarkdown } = options;
    const result = await new LocalBackend().callTool('query', withoutMarkdown);
    expect(mentionMocks.findSymbols).not.toHaveBeenCalled();
    expect(result.enrichment).not.toHaveProperty('mentionResolution');
  });

  it('MR4-A returns one map entry for the same mention on two chunks', async () => {
    const repo = await createRepo();
    const state = mentionSidecarState();
    const base = state.enrichments[0];
    const chunk = base.records[0];
    const secondChunk = { ...chunk, chunkKey: `${chunk.chunkKey}:second`, chunkIndex: 1 };
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: [
        {
          ...base,
          records: [
            ...base.records,
            secondChunk,
            { ...base.records[1], chunkKey: secondChunk.chunkKey },
          ],
        },
      ],
    });
    const result = await new LocalBackend().callTool('query', options);
    expect(result.enrichment.relatedChunks).toHaveLength(2);
    for (const returnedChunk of result.enrichment.relatedChunks) {
      expect(returnedChunk.evidence).toEqual([
        expect.objectContaining({ mention: 'buildPhaseList' }),
      ]);
      expect(returnedChunk.evidence[0]).not.toHaveProperty('graphResolution');
    }
    expect(Object.keys(result.enrichment.mentionTargets)).toEqual(['buildPhaseList']);
    expect(result.enrichment.mentionTargets.buildPhaseList.status).toBe('resolved');
    expect(mentionMocks.findSymbols).toHaveBeenCalledTimes(1);
  });

  it('MR4-B omits unresolved mentions from the map', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, mentionSidecarState());
    mentionMocks.findSymbols.mockResolvedValue([]);
    const result = await new LocalBackend().callTool('query', options);
    expect(result.enrichment.relatedChunks[0].evidence).toEqual([
      expect.objectContaining({ mention: 'buildPhaseList' }),
    ]);
    expect(result.enrichment.mentionTargets ?? {}).toEqual({});
    expect(mentionMocks.findSymbols).toHaveBeenCalledTimes(1);
    expect(result.enrichment.mentionResolution).toMatchObject({ status: 'ok', lookups: 1 });
  });

  it('MR4-C bounds the map to 40 entries for 60 distinct returned mentions', async () => {
    const repo = await createRepo();
    const state = mentionSidecarState();
    const base = state.enrichments[0];
    const chunks = Array.from({ length: 10 }, (_, index) => ({
      ...base.records[0],
      chunkKey: `mention-cap-${index}`,
      chunkIndex: index,
    }));
    const mentions = chunks.flatMap((chunk, chunkIndex) =>
      Array.from({ length: 6 }, (_, index) => ({
        ...base.records[1],
        chunkKey: chunk.chunkKey,
        evidence: { text: `buildPhase${chunkIndex * 6 + index}`, lineSpan: { start: 12, end: 12 } },
      })),
    );
    mentionMocks.findSymbols.mockImplementation(async ({ mention: name }: { mention: string }) => [
      {
        type: 'symbol',
        id: `Function:src/x.ts:${name}`,
        name,
        filePath: 'src/x.ts',
        startLine: 10,
        confidence: 0.9,
      },
    ]);
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: [{ ...base, records: [...chunks, ...mentions] }],
    });
    const result = await new LocalBackend().callTool('query', options);
    expect(result.enrichment.relatedChunks).toHaveLength(10);
    const returnedMentions = new Set(
      result.enrichment.relatedChunks.flatMap((chunk: any) =>
        chunk.evidence.map((evidence: any) => evidence.mention),
      ),
    );
    expect(returnedMentions.size).toBe(60);
    const targets = Object.entries(result.enrichment.mentionTargets);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.length).toBeLessThanOrEqual(40);
    for (const [mention, resolution] of targets) {
      expect(returnedMentions.has(mention)).toBe(true);
      expect(resolution).toMatchObject({
        status: 'resolved',
        targets: [expect.objectContaining({ name: mention })],
      });
    }
  });
});

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

function rankingSidecarState() {
  const state = passiveSidecarState();
  const base = state.enrichments[0];
  const chunk = (docPath: string, heading: string[], excerpt: string, index: number) => ({
    kind: 'markdown-chunk',
    docPath,
    fileHash: `rank-doc-hash-${index}`,
    sourceCommitHash: 'abc123',
    headingPath: heading,
    lineSpan: { start: 1, end: 5 },
    chunkIndex: 0,
    normalizedAnchor: `rank-${index}`,
    contentHash: `rank-chunk-hash-${index}`,
    chunkKey: `markdown-chunk:${docPath}:rank-doc-hash-${index}:${heading.join('/')}:rank-${index}:rank-chunk-hash-${index}`,
    excerpt,
  });
  const filler = Array.from({ length: 11 }, (_, index) =>
    chunk(
      `docs/a${String(index).padStart(2, '0')}.md`,
      ['Notes', `Topic ${index}`],
      `General notes about storage topic ${index}.`,
      index,
    ),
  );
  const archived = chunk(
    '.memory-bank/archive/old-plan.md',
    ['Old Plan', 'Phase tasks'],
    'Pipeline phase pipeline phase task: add a new phase to the pipeline.',
    11,
  );
  const onTopic = chunk(
    'docs/zz-architecture.md',
    ['Architecture', 'How to add a new phase'],
    'Create a pipeline phase file, export it, and add it to buildPhaseList.',
    12,
  );
  return {
    ...state,
    enrichments: [{ ...base, records: [...base.records, ...filler, archived, onTopic] }],
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

describe('FC Markdown per-chunk fact cap', () => {
  const options = {
    query: 'login',
    consume_enrichment_facts: true,
    include_passive_related_facts: true,
    include_markdown_context: true,
  };

  function fixture(mentionCount: number, linkCount = 0, chunkCount = 1) {
    const state = markdownSidecarState();
    const base = state.enrichments[0];
    const chunk = base.records.find((fact) => fact.kind === 'markdown-chunk')!;
    const chunks = Array.from({ length: chunkCount }, (_, index) => ({
      ...chunk,
      chunkKey: `${chunk.chunkKey}:${index}`,
      chunkIndex: index,
    }));
    const mentions = Array.from({ length: mentionCount }, (_, index) => ({
      kind: 'markdown-test-mention',
      schemaVersion: 1,
      docPath: chunk.docPath,
      headingPath: chunk.headingPath,
      lineSpan: { start: 12, end: 12 },
      sourceChunkKey: chunks[0].chunkKey,
      mention: `test/unit/login-${index}.test.ts`,
      normalizedKey: `login-test-${index}`,
      confidence: 0.85,
      resolvable: true,
      evidence: {
        text: `test/unit/login-${index}.test.ts`,
        raw: `test/unit/login-${index}.test.ts`,
        lineSpan: { start: 12, end: 12 },
      },
      targetPath: `test/unit/login-${index}.test.ts`,
    }));
    const links = Array.from({ length: linkCount }, (_, index) => ({
      kind: 'markdown-link',
      fromChunkKey: chunks[0].chunkKey,
      href: `login-${index}.md`,
      text: `Login ${index}`,
      lineSpan: { start: 13, end: 13 },
      toDocPath: `login-${index}.md`,
    }));
    return {
      state: {
        ...state,
        enrichments: [
          {
            ...base,
            analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
            filePath: chunk.docPath,
            fileHash: chunk.fileHash,
            records: [...chunks, ...mentions, ...links],
          },
        ],
      },
      chunks,
      mentions,
      links,
    };
  }

  it('FC-A retains the first 25 of 60 test mentions on one returned chunk', async () => {
    const repo = await createRepo();
    const { state, mentions } = fixture(60);
    await writeSidecarStore(repo.storagePath, state);
    const result = await new LocalBackend().callTool('query', options);

    expect(result.enrichment.relatedChunks).toHaveLength(1);
    expect(
      result.enrichment.facts.filter((fact: any) => fact.kind === 'markdown-test-mention'),
    ).toEqual(mentions.slice(0, 25));
    expect(result.enrichment.factsBound).toMatchObject({
      perChunkKindLimit: 25,
      omittedByChunkCap: 35,
      truncated: true,
    });
  });

  it('FC-B independently caps test mentions and links on the same chunk', async () => {
    const repo = await createRepo();
    const { state, mentions, links, chunks } = fixture(30, 30);
    await writeSidecarStore(repo.storagePath, state);
    const result = await new LocalBackend().callTool('query', options);

    expect(result.enrichment.facts).toEqual([
      ...chunks,
      ...mentions.slice(0, 25),
      ...links.slice(0, 25),
    ]);
    expect(
      result.enrichment.facts.filter((fact: any) => fact.kind !== 'markdown-chunk'),
    ).toHaveLength(50);
    expect(result.enrichment.factsBound).toMatchObject({
      perChunkKindLimit: 25,
      omittedByChunkCap: 10,
      truncated: true,
    });
  });

  it('FC-C preserves all 10 test mentions below the cap', async () => {
    const repo = await createRepo();
    const { state, chunks, mentions } = fixture(10);
    await writeSidecarStore(repo.storagePath, state);
    const result = await new LocalBackend().callTool('query', options);

    expect(result.enrichment.facts).toEqual([...chunks, ...mentions]);
    expect(result.enrichment.factsBound).toMatchObject({
      perChunkKindLimit: 25,
      omittedByChunkCap: 0,
      truncated: false,
    });
  });

  it('FC-D preserves returned chunk count, keys, and order when extra facts are capped', async () => {
    const repo = await createRepo();
    const backend = new LocalBackend();
    await writeSidecarStore(repo.storagePath, fixture(0, 0, 12).state);
    const baseline = await backend.callTool('query', options);
    await writeSidecarStore(repo.storagePath, fixture(60, 30, 12).state);
    const result = await backend.callTool('query', options);

    expect(baseline.enrichment.relatedChunks).toHaveLength(10);
    expect(result.enrichment.relatedChunks).toHaveLength(baseline.enrichment.relatedChunks.length);
    expect(result.enrichment.relatedChunks.map((chunk: any) => chunk.chunkKey)).toEqual(
      baseline.enrichment.relatedChunks.map((chunk: any) => chunk.chunkKey),
    );
    expect(result.enrichment.factsBound.omittedByChunkCap).toBe(40);
  });
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
      query: 'login flow',
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
      query: 'login flow',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
    });
    const withMarkdownOptIn = await backend.callTool('query', {
      query: 'login flow',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });
    const withMarkdownPpr = await backend.callTool('query', {
      query: 'login flow',
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
      { name: 'markdown-passive-graph', factCount: 5, docCount: 1, chunkCount: 1 },
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
      query: 'M7 docs evidence',
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
      },
    });
    expect(result.enrichment.reason).toContain('not valid JSON');
  });

  it('GR1-A ranks the on-topic Markdown chunk first for a matching query', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, rankingSidecarState());
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
      query: 'how to add a new pipeline phase',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });
    expect(result.enrichment.relatedChunks[0].docPath).toBe('docs/zz-architecture.md');
    expect(result.enrichment.relatedChunks[1].docPath).toBe('.memory-bank/archive/old-plan.md');
    expect(result.enrichment.relatedChunks).toHaveLength(2);
    expect(result.enrichment.relatedDocs[0].docPath).toBe('docs/zz-architecture.md');
  });

  it('GR1-B returns no Markdown chunks when the query matches nothing', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, rankingSidecarState());
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
      query: 'docker compose deployment',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });
    expect(result.enrichment.relatedChunks).toEqual([]);
    expect(result.enrichment.relatedDocs).toEqual([]);
  });

  it.each(['!!! ... ???', 'the to and'])(
    'keeps path-order context for zero-token query %s',
    async (query) => {
      const repo = await createRepo();
      await writeSidecarStore(repo.storagePath, rankingSidecarState());
      const backend = new LocalBackend();
      const options = {
        consume_enrichment_facts: true,
        include_passive_related_facts: true,
        include_markdown_context: true,
      };
      const empty = await backend.callTool('query', { ...options, query: '' });
      const result = await backend.callTool('query', { ...options, query });
      expect(result.enrichment.relatedChunks.length).toBeGreaterThan(0);
      expect(result.enrichment.relatedChunks).toEqual(empty.enrichment.relatedChunks);
      expect(result.enrichment.relatedDocs).toEqual(empty.enrichment.relatedDocs);
    },
  );

  it('caps context without throwing for more than 150,000 matching chunks', async () => {
    const repo = await createRepo();
    const state = markdownSidecarState();
    const base = state.enrichments[0];
    const chunk = base.records.find((fact) => fact.kind === 'markdown-chunk')!;
    const chunks = Array.from({ length: 150_001 }, (_, index) => ({
      ...chunk,
      chunkKey: `chunk-${index}`,
      chunkIndex: index,
      headingPath: ['Login'],
      excerpt: 'login',
    }));
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: Array.from({ length: 151 }, (_, index) => ({
        ...base,
        filePath: `src/chunks-${index}.ts`,
        records: chunks.slice(index * 1_000, (index + 1) * 1_000),
      })),
    });
    const backend = new LocalBackend();
    const result = await backend.callTool('query', {
      query: 'login',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });
    expect(result.enrichment.error).toBeUndefined();
    expect(result.enrichment.relatedChunks).toHaveLength(10);
    expect(result.enrichment.relatedDocs).toEqual([
      expect.objectContaining({ docPath: chunk.docPath, chunkCount: chunks.length }),
    ]);
  }, 20_000);

  it('GR1-C keeps the Markdown context response below the byte budget', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, rankingSidecarState());
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
      query: 'how to add a new pipeline phase',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });
    expect(JSON.stringify(result).length).toBeLessThan(200_000);
  });

  it('GR26-A preserves non-Markdown records with matching, unmatched, or absent chunks', async () => {
    const repo = await createRepo();
    const state = markdownSidecarState();
    const base = state.enrichments[0];
    const chunk = base.records.find((fact) => fact.kind === 'markdown-chunk')!;
    const codeRecord = { ...base, records: [base.records[0]] };
    const markdownRecord = {
      ...base,
      analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
      filePath: chunk.docPath,
      fileHash: chunk.fileHash,
      records: [chunk],
    };
    const backend = new LocalBackend();

    for (const scenario of [
      { query: 'login', records: [codeRecord, markdownRecord], markdownCount: 1 },
      {
        query: 'docker compose deployment',
        records: [codeRecord, markdownRecord],
        markdownCount: 0,
      },
      { query: 'login', records: [codeRecord], markdownCount: 0 },
    ]) {
      await writeSidecarStore(repo.storagePath, { ...state, enrichments: scenario.records });
      const result = await backend.callTool('query', {
        query: scenario.query,
        consume_enrichment_facts: true,
        include_passive_related_facts: true,
        include_markdown_context: true,
      });

      expect(result.enrichment.visibleRecords).toHaveLength(1 + scenario.markdownCount);
      expect(result.enrichment.visibleRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ analyzerId: base.analyzerId, filePath: base.filePath }),
        ]),
      );
      expect(result.enrichment.facts).toContainEqual(codeRecord.records[0]);
      expect(result.enrichment.relatedChunks).toHaveLength(scenario.markdownCount);
      expect(result.enrichment).not.toHaveProperty('keptDocPaths');
    }
  });

  it('GR26-B keeps all six Markdown record summaries beyond the five-doc preview', async () => {
    const repo = await createRepo();
    const state = docsEvidenceSidecarState();
    const base = state.enrichments[0];
    const chunks = base.records.filter((fact) => fact.kind === 'markdown-chunk').slice(0, 6);
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: chunks.map((chunk) => ({
        ...base,
        analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
        filePath: chunk.docPath,
        fileHash: chunk.fileHash,
        records: [chunk],
      })),
    });
    const backend = new LocalBackend();
    const result = await backend.callTool('query', {
      query: 'M7 docs evidence',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });

    expect(result.enrichment.facts).toEqual(chunks);
    expect(result.enrichment.relatedChunks).toHaveLength(6);
    expect(result.enrichment.relatedDocs).toHaveLength(5);
    expect(result.enrichment.visibleRecords.map((record: any) => record.filePath)).toEqual(
      chunks.map((chunk) => chunk.docPath),
    );
  });

  it('GR26-C counts only retained chunks for each document', async () => {
    const repo = await createRepo();
    const state = markdownSidecarState();
    const base = state.enrichments[0];
    const chunk = base.records.find((fact) => fact.kind === 'markdown-chunk')!;
    const chunks = ['cache', 'logs'].map((topic, index) => ({
      ...chunk,
      headingPath: [topic],
      excerpt: topic,
      chunkIndex: index,
      chunkKey: `${chunk.chunkKey}:${topic}`,
    }));
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: [{ ...base, records: chunks }],
    });
    const backend = new LocalBackend();
    const result = await backend.callTool('query', {
      query: 'cache',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });

    expect(result.enrichment.relatedChunks).toEqual([
      expect.objectContaining({ chunkKey: chunks[0].chunkKey }),
    ]);
    expect(result.enrichment.relatedDocs).toHaveLength(1);
    expect(result.enrichment.relatedDocs[0].chunkCount).toBe(1);
  });

  it('GR26-D reports truncation only when facts or record summaries are removed', async () => {
    const repo = await createRepo();
    const state = markdownSidecarState();
    const base = state.enrichments[0];
    const chunk = base.records.find((fact) => fact.kind === 'markdown-chunk')!;
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: [{ ...base, records: [chunk] }],
    });
    const backend = new LocalBackend();
    for (const [query, truncated] of [
      ['login', false],
      ['docker compose deployment', true],
    ] as const) {
      const result = await backend.callTool('query', {
        query,
        consume_enrichment_facts: true,
        include_passive_related_facts: true,
        include_markdown_context: true,
      });

      expect(result.enrichment.facts).toEqual(truncated ? [] : [chunk]);
      expect(result.enrichment.factsBound).toEqual({
        totalFactCount: 1,
        totalVisibleRecordCount: 1,
        truncated,
        perChunkKindLimit: 25,
        omittedByChunkCap: 0,
      });
      expect(result.enrichment.visibleRecords).toHaveLength(1);
    }
  });

  it('GR27-A deduplicates freshness for multiple matching chunks from one document', async () => {
    const repo = await createRepo();
    const state = markdownSidecarState();
    const base = state.enrichments[0];
    const chunk = base.records.find((fact) => fact.kind === 'markdown-chunk')!;
    const chunks = [0, 1, 2].map((index) => ({
      ...chunk,
      headingPath: ['Auth', `Login Flow ${index}`],
      chunkIndex: index,
      normalizedAnchor: `login-flow-${index}`,
      contentHash: `chunk-hash-${index}`,
      chunkKey: `${chunk.chunkKey}:${index}`,
      excerpt: `Login flow notes ${index}`,
    }));
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: [
        {
          ...base,
          analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
          filePath: chunk.docPath,
          fileHash: chunk.fileHash,
          records: chunks,
        },
      ],
    });
    const backend = new LocalBackend();
    const result = await backend.callTool('query', {
      query: 'login flow',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });
    const freshness = result.enrichment.relatedDocs[0].freshness;

    expect(result.enrichment.relatedDocs[0].chunkCount).toBe(3);
    expect(new Set(freshness.map((fact: any) => JSON.stringify(fact))).size).toBe(freshness.length);
    expect(freshness).toHaveLength(1);
  });

  it('GR27-B caps related chunks and visible Markdown records to returned documents', async () => {
    const repo = await createRepo();
    const state = docsEvidenceSidecarState();
    const base = state.enrichments[0];
    const chunks = base.records.filter((fact) => fact.kind === 'markdown-chunk').slice(0, 12);
    const codeRecord = { ...base, records: [base.records[0]] };
    const markdownRecords = chunks.map((chunk) => ({
      ...base,
      analyzerId: MARKDOWN_DOCUMENT_ANALYZER_ID,
      filePath: chunk.docPath,
      fileHash: chunk.fileHash,
      records: [chunk],
    }));
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: [codeRecord, ...markdownRecords],
    });
    const backend = new LocalBackend();
    const result = await backend.callTool('query', {
      query: 'M7 docs evidence',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });
    const returnedDocPaths = result.enrichment.relatedChunks.map((chunk: any) => chunk.docPath);
    const visiblePaths = new Set(
      result.enrichment.visibleRecords.map((record: any) => record.filePath),
    );
    const expectedVisiblePaths = new Set([base.filePath, ...returnedDocPaths]);
    const cappedOutDocPaths = chunks
      .map((chunk) => chunk.docPath)
      .filter((docPath) => !returnedDocPaths.includes(docPath));

    expect(result.enrichment.relatedChunks).toHaveLength(10);
    expect(visiblePaths).toEqual(expectedVisiblePaths);
    expect(cappedOutDocPaths).toHaveLength(2);
    for (const docPath of cappedOutDocPaths) {
      expect(visiblePaths.has(docPath)).toBe(false);
    }
  });

  it('GR25-B drops unresolved code mentions from facts but preserves chunk evidence', async () => {
    const repo = await createRepo();
    const state = docsEvidenceSidecarState();
    const base = state.enrichments[0];
    const chunk = base.records.find((fact) => fact.kind === 'markdown-chunk')!;
    const ambiguousMention = {
      ...base.records.find((fact) => fact.kind === 'markdown-code-mention')!,
      chunkKey: chunk.chunkKey,
    };
    const unresolvedMention = {
      ...ambiguousMention,
      confidence: 0,
      resolutionStatus: 'unresolved',
      candidates: [],
    };
    await writeSidecarStore(repo.storagePath, {
      ...state,
      enrichments: [{ ...base, records: [chunk, unresolvedMention, ambiguousMention] }],
    });
    const backend = new LocalBackend();
    const result = await backend.callTool('query', {
      query: 'M7 docs evidence',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });

    expect(result.enrichment.facts).toEqual([chunk, ambiguousMention]);
    expect(result.enrichment.relatedChunks).toHaveLength(1);
    expect(result.enrichment.relatedChunks[0].evidence).toEqual([
      expect.objectContaining({ kind: 'markdown-code-mention', resolutionStatus: 'unresolved' }),
      expect.objectContaining({ kind: 'markdown-code-mention', resolutionStatus: 'ambiguous' }),
    ]);
  });

  it('GR25-C keeps unmatched chunks and docs with graph-with-passive-docs policy', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, markdownSidecarState());
    const backend = new LocalBackend();
    const result = await backend.callTool('query', {
      query: 'docker compose deployment',
      retrieval_policy: 'graph-with-passive-docs',
    });

    expect(result.enrichment.relatedChunks).toEqual([
      expect.objectContaining({ docPath: 'docs/auth.md', excerpt: 'Login flow notes' }),
    ]);
    expect(result.enrichment.relatedDocs).toEqual([
      expect.objectContaining({ docPath: 'docs/auth.md', chunkCount: 1 }),
    ]);
    expect(result.relatedDocs).toEqual(result.enrichment.relatedDocs);
  });

  it('GR25-A bounds Markdown facts to the returned chunks', async () => {
    const repo = await createRepo();
    await writeSidecarStore(repo.storagePath, rankingSidecarState());
    const backend = new LocalBackend();
    const result = await backend.callTool('query', {
      query: 'how to add a new pipeline phase',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
    });

    const keys = new Set(result.enrichment.relatedChunks.map((chunk: any) => chunk.chunkKey));
    const markdownFacts = result.enrichment.facts.filter((fact: any) =>
      fact.kind.startsWith('markdown-'),
    );
    expect(markdownFacts.length).toBeGreaterThan(0);
    for (const fact of markdownFacts) {
      expect(keys.has(fact.chunkKey ?? fact.sourceChunkKey ?? fact.fromChunkKey)).toBe(true);
    }
    expect(result.enrichment.factsBound.totalFactCount).toBeGreaterThan(
      result.enrichment.facts.length,
    );
  });
});

describe('LocalBackend semantic max_tokens', () => {
  beforeEach(() => {
    backendMocks.queryImpl.mockReset();
  });

  it('trims primary results when max_tokens is set', async () => {
    await createRepo();
    backendMocks.queryImpl.mockResolvedValue({
      definitions: Array.from({ length: 10 }, (_, index) => ({
        name: `d${index}`,
        filePath: 'src/a.ts',
        content: 'x'.repeat(400),
      })),
    });

    const result = await new LocalBackend().callTool('query', {
      query: 'auth',
      max_tokens: 300,
    });

    expect(result.definitions.length).toBeGreaterThanOrEqual(1);
    expect(result.definitions.length).toBeLessThan(10);
    expect(result.budget.truncated).toBe(true);
    expect(result.budget.max_tokens).toBe(300);
  });

  it('leaves results unchanged without max_tokens', async () => {
    await createRepo();
    backendMocks.queryImpl.mockResolvedValue({
      definitions: Array.from({ length: 10 }, (_, index) => ({
        name: `d${index}`,
        filePath: 'src/a.ts',
        content: 'x'.repeat(400),
      })),
    });

    const result = await new LocalBackend().callTool('query', { query: 'auth' });

    expect(result.definitions).toHaveLength(10);
    expect(result).not.toHaveProperty('budget');
  });
});
