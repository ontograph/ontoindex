import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  contentHashForNode,
  EMBEDDING_TEXT_VERSION,
} from '../../src/core/embeddings/embedding-pipeline.js';
import { generateEmbeddingText } from '../../src/core/embeddings/text-generator.js';
import type { EmbeddableNode, EmbeddingProgress } from '../../src/core/embeddings/types.js';
import { DEFAULT_EMBEDDING_CONFIG, EMBEDDABLE_LABELS } from '../../src/core/embeddings/types.js';
import { STALE_HASH_SENTINEL } from '../../src/core/lbug/schema.js';

const CLASS_CHUNK_SIZE = 90;
const CLASS_OVERLAP = 10;

// ────────────────────────────────────────────────────────────────────────────
// contentHashForNode
// ────────────────────────────────────────────────────────────────────────────
describe('contentHashForNode', () => {
  const makeNode = (overrides: Partial<EmbeddableNode> = {}): EmbeddableNode => ({
    id: 'Function:foo:src/main.ts',
    name: 'foo',
    label: 'Function',
    filePath: 'src/main.ts',
    content: 'function foo() { return 1; }',
    ...overrides,
  });

  it('returns a 40-char hex SHA-1 digest', () => {
    const hash = contentHashForNode(makeNode());
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is deterministic — same node always produces the same hash', () => {
    const node = makeNode();
    expect(contentHashForNode(node)).toBe(contentHashForNode(node));
  });

  it('matches sha1(generateEmbeddingText(node, node.content))', () => {
    const node = makeNode();
    const expected = createHash('sha1')
      .update(EMBEDDING_TEXT_VERSION)
      .update('\n')
      .update(generateEmbeddingText(node, node.content))
      .digest('hex');
    expect(contentHashForNode(node)).toBe(expected);
  });

  it('changes when node content is edited', () => {
    const original = makeNode({ content: 'function foo() { return 1; }' });
    const edited = makeNode({ content: 'function foo() { return 42; }' });
    expect(contentHashForNode(original)).not.toBe(contentHashForNode(edited));
  });

  it('changes when filePath differs', () => {
    const a = makeNode({ filePath: 'src/a.ts' });
    const b = makeNode({ filePath: 'src/b.ts' });
    // Different filePaths lead to different embedding text ⇒ different hashes
    expect(contentHashForNode(a)).not.toBe(contentHashForNode(b));
  });

  it('produces identical hash regardless of config vs finalConfig when config is empty', () => {
    const node = makeNode();
    const hashWithEmptyConfig = contentHashForNode(node, {});
    const hashWithFullDefaults = contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG);
    expect(hashWithEmptyConfig).toBe(hashWithFullDefaults);
  });

  it('exports a text template version marker', () => {
    expect(EMBEDDING_TEXT_VERSION).toBe('v2');
  });

  it('treats markdown Section nodes as embeddable', () => {
    expect(EMBEDDABLE_LABELS).toContain('Section');
    const node = makeNode({
      id: 'Section:docs/security.md:L1:Sanitization Rules',
      name: 'Sanitization Rules',
      label: 'Section',
      filePath: 'docs/security.md',
      content: '# Sanitization Rules\n\nAccess tokens and user paths must be redacted.',
    });

    const text = generateEmbeddingText(node, node.content);

    expect(text).toContain('Section: Sanitization Rules');
    expect(text).toContain('Access tokens and user paths');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// STALE_HASH_SENTINEL
// ────────────────────────────────────────────────────────────────────────────
describe('STALE_HASH_SENTINEL', () => {
  it('is the empty string', () => {
    expect(STALE_HASH_SENTINEL).toBe('');
  });

  it('is falsy — enables consistent `hash || STALE_HASH_SENTINEL` patterns', () => {
    expect(!STALE_HASH_SENTINEL).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runEmbeddingPipeline — exports
// ────────────────────────────────────────────────────────────────────────────
describe('runEmbeddingPipeline incremental mode', () => {
  it('exports contentHashForNode as a named export', async () => {
    const mod = await import('../../src/core/embeddings/embedding-pipeline.js');
    expect(typeof mod.contentHashForNode).toBe('function');
  });

  it('exports runEmbeddingPipeline as a named export', async () => {
    const mod = await import('../../src/core/embeddings/embedding-pipeline.js');
    expect(typeof mod.runEmbeddingPipeline).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EMBEDDING_SCHEMA includes contentHash column
// ────────────────────────────────────────────────────────────────────────────
describe('EMBEDDING_SCHEMA', () => {
  it('includes contentHash STRING column', async () => {
    const { EMBEDDING_SCHEMA } = await import('../../src/core/lbug/schema.js');
    expect(EMBEDDING_SCHEMA).toContain('contentHash STRING');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EMBEDDING_INDEX_NAME export
// ────────────────────────────────────────────────────────────────────────────
describe('EMBEDDING_INDEX_NAME', () => {
  it('is exported from schema.ts', async () => {
    const { EMBEDDING_INDEX_NAME } = await import('../../src/core/lbug/schema.js');
    expect(EMBEDDING_INDEX_NAME).toBe('code_embedding_idx');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runEmbeddingPipeline — incremental filter logic with mocked embedder
//
// Tests the three incremental-mode code paths:
// 1. New node (not in existingEmbeddings) → embedded
// 2. Unchanged node (hash matches) → skipped
// 3. Stale node (hash mismatch) → DELETE old → re-embed
// 4. Zero nodes after filter → createVectorIndex still called
// ────────────────────────────────────────────────────────────────────────────
describe('runEmbeddingPipeline incremental filter', () => {
  // Track mocked calls
  let queryCalls: string[];
  let stmtCalls: Array<{ cypher: string; params: Array<Record<string, any>> }>;
  let progressUpdates: EmbeddingProgress[];

  // Helper node
  const makeNode = (overrides: Partial<EmbeddableNode> = {}): EmbeddableNode => ({
    id: 'Function:foo:src/main.ts',
    name: 'foo',
    label: 'Function',
    filePath: 'src/main.ts',
    content: 'function foo() { return 1; }',
    ...overrides,
  });

  beforeEach(() => {
    queryCalls = [];
    stmtCalls = [];
    progressUpdates = [];
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // Mock the embedder module so we never need a real model
  const mockEmbedderSetup = () => {
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: vi
        .fn()
        .mockImplementation((texts: string[]) =>
          Promise.resolve(texts.map(() => new Float32Array(384))),
        ),
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));

    // Mock loadVectorExtension (avoids needing the native lbug module)
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(undefined),
    }));
  };

  const mockExecuteQuery = (nodes: EmbeddableNode[]) => {
    return vi.fn().mockImplementation(async (cypher: string) => {
      queryCalls.push(cypher);
      // Respond to node queries based on label
      for (const label of [
        'Function',
        'Class',
        'Method',
        'Interface',
        'File',
        ...(EMBEDDABLE_LABELS as readonly string[]),
      ]) {
        if (cypher.includes(`MATCH (n:${label})`) || cypher.includes(`MATCH (n:\`${label}\``)) {
          if (cypher.includes('RETURN count(n) AS count')) {
            return [{ count: nodes.filter((n) => n.label === label).length }];
          }
          return nodes
            .filter((n) => n.label === label)
            .map((n) => ({
              id: n.id,
              name: n.name,
              label: n.label,
              filePath: n.filePath,
              content: n.content,
              startLine: n.startLine,
              endLine: n.endLine,
            }));
        }
      }
      return [];
    });
  };

  const mockExecuteWithReusedStatement = () => {
    return vi
      .fn()
      .mockImplementation(async (cypher: string, params: Array<Record<string, any>>) => {
        stmtCalls.push({ cypher, params });
      });
  };

  const onProgress = (p: EmbeddingProgress) => {
    progressUpdates.push({ ...p });
  };

  const withEmbedSubBatchEnv = async <T>(
    value: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const original = process.env.ONTOINDEX_EMBED_SUB_BATCH;
    if (value === undefined) {
      delete process.env.ONTOINDEX_EMBED_SUB_BATCH;
    } else {
      process.env.ONTOINDEX_EMBED_SUB_BATCH = value;
    }
    try {
      return await fn();
    } finally {
      if (original === undefined) {
        delete process.env.ONTOINDEX_EMBED_SUB_BATCH;
      } else {
        process.env.ONTOINDEX_EMBED_SUB_BATCH = original;
      }
    }
  };

  const createCheckpoint = (seed: {
    path: string;
    currentLabel: string;
    lastCompletedNodeId: string;
    insertedRows?: number;
    embeddingTextVersion?: string;
    modelHash?: string;
    headCommit?: string;
  }): string =>
    JSON.stringify({
      version: 1,
      embeddingTextVersion: seed.embeddingTextVersion ?? EMBEDDING_TEXT_VERSION,
      modelHash: seed.modelHash ?? 'model-hash',
      headCommit: seed.headCommit ?? 'head-commit',
      currentLabel: seed.currentLabel,
      lastCompletedNodeId: seed.lastCompletedNodeId,
      insertedRows: seed.insertedRows ?? 0,
      updatedAt: '2026-06-20T00:00:00.000Z',
    });

  const makeLongNodeList = (count: number): EmbeddableNode[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `TypeAlias:alias${i}:src/alias.ts`,
      name: `alias${i}`,
      label: 'TypeAlias',
      filePath: 'src/alias.ts',
      content: `type Alias${i} = string;`,
    }));
  };

  const chunkContentHash = (text: string): string =>
    createHash('sha1').update(EMBEDDING_TEXT_VERSION).update('\n').update(text).digest('hex');

  const embeddingDigest = (
    rows: ReadonlyArray<{
      id: string;
      nodeId: string;
      chunkIndex: number;
      contentHash: string;
      chunkContentHash?: string;
    }>,
  ): string => {
    const payloadRows = rows
      .map((row) => {
        const payload: Record<string, string | number> & { chunkContentHash?: string } = {
          chunkIndex: row.chunkIndex,
          contentHash: row.contentHash,
          id: row.id,
          nodeId: row.nodeId,
        };
        if (row.chunkContentHash !== undefined) {
          payload.chunkContentHash = row.chunkContentHash;
        }
        return JSON.stringify(payload);
      })
      .sort();
    const digestInput = `${payloadRows.length}\u0000${payloadRows.join('\u001f')}`;
    return `sha256:${createHash('sha256').update(digestInput, 'utf8').digest('hex')}`;
  };

  it('reuses unchanged chunks when chunkContentHash matches', async () => {
    const unchangedChunkIndex0 = {
      text: 'constant chunk content 0',
      chunkIndex: 0,
      startLine: 1,
      endLine: 4,
    };
    const staleChunk = {
      text: 'CHUNK_CONTENT_SHOULD_REGENERATE',
      chunkIndex: 1,
      startLine: 5,
      endLine: 8,
    };
    const unchangedChunkIndex2 = {
      text: 'constant chunk content 2',
      chunkIndex: 2,
      startLine: 9,
      endLine: 12,
    };
    const baseNodeForHash: EmbeddableNode = {
      id: 'TypeAlias:aliasChunk:src/chunks.ts',
      name: 'aliasChunk',
      label: 'Enum',
      filePath: 'src/chunks.ts',
      content: 'type aliasChunk = 1;',
      startLine: 1,
      endLine: 20,
    };

    const chunkConfig = { ...DEFAULT_EMBEDDING_CONFIG, overlap: 0 };
    const computeChunkHashes = (
      chunks: Array<{ text: string; chunkIndex: number; startLine: number; endLine: number }>,
    ) => {
      let prevTail = '';
      return new Map(
        chunks.map((chunk) => {
          const generatedText = generateEmbeddingText(
            baseNodeForHash,
            chunk.text,
            chunkConfig,
            chunk.chunkIndex,
            prevTail,
          );
          const hash = chunkContentHash(generatedText);
          prevTail = chunkConfig.overlap > 0 ? chunk.text.slice(-chunkConfig.overlap) : '';
          return [chunk.chunkIndex, hash] as const;
        }),
      );
    };

    const currentChunk0 = { ...unchangedChunkIndex0 };
    const currentChunk1 = {
      text: 'UPDATED_CHUNK_CONTENT_1',
      chunkIndex: 1,
      startLine: 5,
      endLine: 8,
    };
    const currentChunk2 = { ...unchangedChunkIndex2 };

    vi.doMock('../../src/core/embeddings/chunker.js', () => ({
      chunkNode: vi.fn().mockResolvedValue([currentChunk0, currentChunk1, currentChunk2]),
      characterChunk: vi.fn(),
    }));

    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: vi
        .fn()
        .mockImplementation((texts: string[]) =>
          Promise.resolve(texts.map(() => new Float32Array(384))),
        ),
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));

    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(undefined),
    }));

    const node = makeNode(baseNodeForHash);
    const existingEmbeddings = new Map<
      string,
      { contentHash: string; chunkContentHashes: Map<number, string> }
    >([
      [
        node.id,
        {
          contentHash: contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG),
          chunkContentHashes: computeChunkHashes([
            unchangedChunkIndex0,
            staleChunk,
            unchangedChunkIndex2,
          ]),
        },
      ],
    ]);

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      chunkConfig,
      undefined,
      undefined,
      existingEmbeddings,
    );

    const createCalls = stmtCalls.filter((c) => c.cypher.includes('CREATE'));
    expect(createCalls).toHaveLength(1);
    const insertedRows = createCalls[0].params;
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({ chunkIndex: 1, nodeId: node.id });

    const deleteCalls = stmtCalls.filter((c) => c.cypher.includes('DELETE'));
    expect(deleteCalls).toHaveLength(1);
    const deleteParams = deleteCalls[0].params as { nodeId: string; chunkIndex?: number }[];
    const deletedChunkIndexes = deleteParams
      .filter((p) => p.nodeId === node.id)
      .map((p) => p.chunkIndex)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(deletedChunkIndexes).toEqual([1]);
  });

  it('honors an abort signal before starting work', async () => {
    mockEmbedderSetup();

    const abortController = new AbortController();
    abortController.abort(new Error('Cancelled by user'));
    const executeQuery = mockExecuteQuery([makeNode()]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await expect(
      runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        {},
        undefined,
        undefined,
        undefined,
        abortController.signal,
      ),
    ).rejects.toThrow('Embedding cancelled: Cancelled by user');
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('skips unchanged nodes when hash matches', async () => {
    mockEmbedderSetup();

    const node = makeNode();
    const hash = contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG);
    const existingEmbeddings = new Map<string, string>([[node.id, hash]]);

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined, // skipNodeIds
      undefined, // context
      existingEmbeddings,
    );

    // No CREATE calls — node was skipped because hash matched
    const createCalls = stmtCalls.filter((c) => c.cypher.includes('CREATE'));
    expect(createCalls).toHaveLength(0);

    // Pipeline should reach 'ready' state
    const readyProgress = progressUpdates.find((p) => p.phase === 'ready');
    expect(readyProgress).toBeDefined();
    expect(readyProgress!.percent).toBe(100);
  });

  it('embeds new nodes not in existingEmbeddings', async () => {
    mockEmbedderSetup();

    const node = makeNode({
      id: 'Function:newFn:src/new.ts',
      name: 'newFn',
      filePath: 'src/new.ts',
    });
    const existingEmbeddings = new Map<string, string>(); // empty — no prior embeddings

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined, // skipNodeIds
      undefined, // context
      existingEmbeddings,
    );

    // Should have a CREATE call to insert the embedding
    const createCalls = stmtCalls.filter((c) => c.cypher.includes('CREATE'));
    expect(createCalls.length).toBeGreaterThanOrEqual(1);

    // The inserted row should contain the node id and a contentHash
    const insertParams = createCalls[0].params;
    expect(insertParams.some((p: any) => p.nodeId === node.id)).toBe(true);
    expect(insertParams[0].contentHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('maps positional query rows with description/isExported columns correctly', async () => {
    const embedBatchSpy = vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => new Float32Array(384))),
      );
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: embedBatchSpy,
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(undefined),
    }));

    const executeQuery = vi.fn().mockImplementation(async (cypher: string) => {
      queryCalls.push(cypher);
      if (cypher.includes('MATCH (n:`Class`)')) {
        return [
          [
            'Class:src/parser.ts:Parser',
            'Parser',
            'Class',
            'src/parser.ts',
            'class Parser { value = 1; }',
            10,
            12,
            true,
            'Parses typed payloads.',
          ],
        ];
      }
      if (cypher.includes('MATCH (n:`Enum`)')) {
        return [
          [
            'Enum:src/status.ts:Status',
            'Status',
            'Enum',
            'src/status.ts',
            'enum Status { Active, Pending }',
            20,
            22,
            'Represents user status.',
          ],
        ];
      }
      return [];
    });
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined,
      undefined,
      new Map(),
    );

    const embeddedTexts = embedBatchSpy.mock.calls.flatMap((call) => call[0] as string[]);
    const classText = embeddedTexts.find((text) => text.includes('Class: Parser'));
    const enumText = embeddedTexts.find((text) => text.includes('Enum: Status'));

    expect(classText).toContain('Export: true');
    expect(classText).toContain('Parses typed payloads.');
    expect(enumText).not.toContain('Export:');
    expect(enumText).toContain('Represents user status.');
  });

  it('deletes and re-embeds stale nodes (hash mismatch)', async () => {
    mockEmbedderSetup();

    const node = makeNode({ content: 'function foo() { return 42; }' });
    const staleHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // wrong hash
    const existingEmbeddings = new Map<string, string>([[node.id, staleHash]]);

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined, // skipNodeIds
      undefined, // context
      existingEmbeddings,
    );

    // Should have a DELETE call for the stale node
    const deleteCalls = stmtCalls.filter((c) => c.cypher.includes('DELETE'));
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(deleteCalls[0].params.some((p: any) => p.nodeId === node.id)).toBe(true);

    // Should also have a CREATE call to re-insert with new hash
    const createCalls = stmtCalls.filter((c) => c.cypher.includes('CREATE'));
    expect(createCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('treats STALE_HASH_SENTINEL as stale — triggers re-embed', async () => {
    mockEmbedderSetup();

    const node = makeNode();
    // Legacy row: nodeId present but contentHash is STALE_HASH_SENTINEL
    const existingEmbeddings = new Map<string, string>([[node.id, STALE_HASH_SENTINEL]]);

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined, // skipNodeIds
      undefined, // context
      existingEmbeddings,
    );

    // Should have a DELETE call (stale)
    const deleteCalls = stmtCalls.filter((c) => c.cypher.includes('DELETE'));
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);

    // Should also have a CREATE (re-embed)
    const createCalls = stmtCalls.filter((c) => c.cypher.includes('CREATE'));
    expect(createCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('calls createVectorIndex even when zero nodes need embedding after filter', async () => {
    mockEmbedderSetup();

    const node = makeNode();
    const hash = contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG);
    // All existing hashes match — zero nodes to embed
    const existingEmbeddings = new Map<string, string>([[node.id, hash]]);

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined, // skipNodeIds
      undefined, // context
      existingEmbeddings,
    );

    // The CREATE_VECTOR_INDEX query should have been called via executeQuery
    const vectorIndexCalls = queryCalls.filter((c) => c.includes('CREATE_VECTOR_INDEX'));
    expect(vectorIndexCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('skips vector index rebuild when digest matches and index exists', async () => {
    mockEmbedderSetup();

    const node = makeNode();
    const digestRow = {
      id: `${node.id}:0`,
      nodeId: node.id,
      chunkIndex: 0,
      contentHash: contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG),
      chunkContentHash: 'chunk-digest-a',
    };
    const lastVectorIndexDigest = embeddingDigest([digestRow]);
    const existingEmbeddings = new Map<string, string>([[node.id, digestRow.contentHash]]);

    const executeQuery = vi.fn().mockImplementation(async (cypher: string) => {
      queryCalls.push(cypher);
      if (cypher.includes('MATCH (e:CodeEmbedding) RETURN e.id AS id')) {
        return [digestRow];
      }
      if (cypher.includes('CALL QUERY_VECTOR_INDEX')) {
        return [];
      }

      if (cypher.includes('MATCH (n:Function)') && cypher.includes('RETURN count(n) AS count')) {
        return [{ count: 1 }];
      }
      if (cypher.includes('MATCH (n:Function)') && !cypher.includes('RETURN count(n) AS count')) {
        return [node];
      }

      return [];
    });

    const executeWithReusedStatement = mockExecuteWithReusedStatement();
    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    const result = await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined,
      undefined,
      existingEmbeddings,
      undefined,
      lastVectorIndexDigest,
    );

    expect(result.didRebuildVectorIndex).toBe(false);
    expect(result.vectorIndexDigest).toBe(lastVectorIndexDigest);
    const vectorIndexCalls = queryCalls.filter((c) => c.includes('CREATE_VECTOR_INDEX'));
    expect(vectorIndexCalls).toHaveLength(0);
  });

  it('rebuilds vector index when chunkContentHash changes even if node content hash is unchanged', async () => {
    mockEmbedderSetup();

    const node = makeNode();
    const previousDigestRow = {
      id: `${node.id}:0`,
      nodeId: node.id,
      chunkIndex: 0,
      contentHash: contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG),
      chunkContentHash: 'chunk-digest-a',
    };
    const nextDigestRow = {
      ...previousDigestRow,
      chunkContentHash: 'chunk-digest-b',
    };
    const lastVectorIndexDigest = embeddingDigest([previousDigestRow]);
    const expectedNextDigest = embeddingDigest([nextDigestRow]);
    const existingEmbeddings = new Map<string, string>([[node.id, previousDigestRow.contentHash]]);

    const executeQuery = vi.fn().mockImplementation(async (cypher: string) => {
      queryCalls.push(cypher);
      if (cypher.includes('MATCH (e:CodeEmbedding) RETURN e.id AS id')) {
        return [nextDigestRow];
      }
      if (cypher.includes('CALL QUERY_VECTOR_INDEX')) {
        return [];
      }

      if (cypher.includes('MATCH (n:Function)') && cypher.includes('RETURN count(n) AS count')) {
        return [{ count: 1 }];
      }
      if (cypher.includes('MATCH (n:Function)') && !cypher.includes('RETURN count(n) AS count')) {
        return [node];
      }
      return [];
    });

    const executeWithReusedStatement = mockExecuteWithReusedStatement();
    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    const result = await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined,
      undefined,
      existingEmbeddings,
      undefined,
      lastVectorIndexDigest,
    );

    expect(result.didRebuildVectorIndex).toBe(true);
    expect(result.vectorIndexDigest).toBe(expectedNextDigest);
    const vectorIndexCalls = queryCalls.filter((c) => c.includes('CREATE_VECTOR_INDEX'));
    expect(vectorIndexCalls).toHaveLength(1);
  });

  it('rebuilds vector index when existence probe is non-verifiable', async () => {
    mockEmbedderSetup();

    const node = makeNode();
    const digestRow = {
      id: `${node.id}:0`,
      nodeId: node.id,
      chunkIndex: 0,
      contentHash: contentHashForNode(node, DEFAULT_EMBEDDING_CONFIG),
      chunkContentHash: 'chunk-digest-a',
    };
    const lastVectorIndexDigest = embeddingDigest([digestRow]);
    const existingEmbeddings = new Map<string, string>([[node.id, digestRow.contentHash]]);

    const executeQuery = vi.fn().mockImplementation(async (cypher: string) => {
      queryCalls.push(cypher);
      if (cypher.includes('MATCH (e:CodeEmbedding) RETURN e.id AS id')) {
        return [digestRow];
      }
      if (cypher.includes('CALL QUERY_VECTOR_INDEX')) {
        throw new Error('Runtime extension probe unavailable');
      }

      if (cypher.includes('MATCH (n:Function)') && cypher.includes('RETURN count(n) AS count')) {
        return [{ count: 1 }];
      }
      if (cypher.includes('MATCH (n:Function)') && !cypher.includes('RETURN count(n) AS count')) {
        return [node];
      }
      return [];
    });

    const executeWithReusedStatement = mockExecuteWithReusedStatement();
    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    const result = await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined,
      undefined,
      existingEmbeddings,
      undefined,
      lastVectorIndexDigest,
    );

    expect(result.didRebuildVectorIndex).toBe(true);
    const vectorIndexCalls = queryCalls.filter((c) => c.includes('CREATE_VECTOR_INDEX'));
    expect(vectorIndexCalls).toHaveLength(1);
  });

  it('does not inject preceding context when overlap is disabled', async () => {
    const embedBatchSpy = vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => new Float32Array(384))),
      );
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: embedBatchSpy,
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(undefined),
    }));

    const node = makeNode({
      label: 'Class',
      name: 'Parser',
      content: `class Parser {
  options: ParserOptions;
  cache: Map<string, any>;
  parseJSON() { return JSON.parse("{}"); }
  validate() { return true; }
}`,
      startLine: 1,
      endLine: 6,
    });

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      { chunkSize: 90, overlap: 0 },
      undefined,
      undefined,
      new Map(),
    );

    const embeddedTexts = embedBatchSpy.mock.calls.flatMap((call) => call[0] as string[]);
    const laterChunks = embeddedTexts.slice(1);
    expect(laterChunks.length).toBeGreaterThan(0);
    for (const text of laterChunks) {
      expect(text).not.toContain('[preceding context]:');
    }
  });

  it('truncates preceding context to the configured overlap size', async () => {
    const embedBatchSpy = vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => new Float32Array(384))),
      );
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: embedBatchSpy,
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(undefined),
    }));

    const node = makeNode({
      label: 'Class',
      name: 'Parser',
      content: `class Parser {
  options: ParserOptions;
  cache: Map<string, any>;
  parseJSON() { return JSON.parse("{}"); }
  validate() { return true; }
}`,
      startLine: 1,
      endLine: 6,
    });

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      { chunkSize: CLASS_CHUNK_SIZE, overlap: CLASS_OVERLAP },
      undefined,
      undefined,
      new Map(),
    );

    const embeddedTexts = embedBatchSpy.mock.calls.flatMap((call) => call[0] as string[]);
    const laterChunk = embeddedTexts.find((text) => text.includes('[preceding context]:'));
    expect(laterChunk).toBeDefined();
    expect(laterChunk).toContain('[preceding context]: ...');
    const precedingContextLine = laterChunk
      ?.split('\n')
      .find((line) => line.startsWith('[preceding context]: ...'));
    expect(precedingContextLine).toBeDefined();
    const contextPrefix = '[preceding context]: ...';
    expect(precedingContextLine).toContain(contextPrefix);
    expect(precedingContextLine!.slice(contextPrefix.length).length).toBeLessThanOrEqual(
      CLASS_OVERLAP,
    );
    expect(precedingContextLine).not.toContain('parseJSON() {');
  });

  it('throws when DELETE for stale nodes fails with non-trivial error', async () => {
    mockEmbedderSetup();

    const node = makeNode({ content: 'function foo() { return 42; }' });
    const staleHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const existingEmbeddings = new Map<string, string>([[node.id, staleHash]]);

    const executeQuery = mockExecuteQuery([node]);
    const executeWithReusedStatement = vi.fn().mockRejectedValue(new Error('Connection lost'));

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await expect(
      runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        {},
        undefined, // skipNodeIds
        undefined, // context
        existingEmbeddings,
      ),
    ).rejects.toThrow('vector-index may be inconsistent');
  });

  it('uses ONTOINDEX_EMBED_SUB_BATCH to control embedding sub-batch size', async () => {
    const embedBatchSpy = vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => new Float32Array(384))),
      );
    vi.doMock('../../src/core/embeddings/embedder.js', () => ({
      initEmbedder: vi.fn().mockResolvedValue(undefined),
      embedBatch: embedBatchSpy,
      embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
      embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
      isEmbedderReady: vi.fn().mockReturnValue(true),
    }));
    vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
      loadVectorExtension: vi.fn().mockResolvedValue(undefined),
    }));

    const executeQuery = mockExecuteQuery(makeLongNodeList(10));
    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const runWithEnv = async () => {
      const { runEmbeddingPipeline } =
        await import('../../src/core/embeddings/embedding-pipeline.js');
      await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        onProgress,
        { batchSize: 20 },
        undefined,
        undefined,
        new Map(),
      );
    };

    await withEmbedSubBatchEnv('4', runWithEnv);

    expect(embedBatchSpy).toHaveBeenCalledTimes(3); // 10 items with sub-batch size 4
    embedBatchSpy.mock.calls.forEach(([texts]) => {
      expect(texts.length).toBeLessThanOrEqual(4);
    });
  });

  it('resumes from a valid embedding checkpoint cursor', async () => {
    mockEmbedderSetup();

    const checkpointRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-embed-cp-'));
    const checkpointPath = path.join(checkpointRepo, 'embedding-checkpoint.json');
    const resumeNode = makeNode({
      id: 'Function:func-a:src/a.ts',
      name: 'funcA',
      filePath: 'src/a.ts',
      content: 'function funcA() { return 1; }',
    });
    const nextNode = makeNode({
      id: 'Function:func-b:src/b.ts',
      name: 'funcB',
      filePath: 'src/b.ts',
      content: 'function funcB() { return 1; }',
    });

    const queryCalls: string[] = [];
    const executeQuery = vi.fn().mockImplementation(async (cypher: string) => {
      queryCalls.push(cypher);
      if (cypher.includes('RETURN count(n) AS count')) {
        return [{ count: 1 }];
      }
      if (
        cypher.includes('MATCH (n:`Function`)') &&
        cypher.includes("WHERE n.id > 'Function:func-a:src/a.ts'")
      ) {
        return [nextNode];
      }
      if (cypher.includes('MATCH (n:`Function`)')) {
        return [nextNode];
      }
      if (cypher.includes('MATCH (e:CodeEmbedding)')) {
        return [];
      }
      if (cypher.includes('CREATE_VECTOR_INDEX')) {
        return [];
      }
      if (cypher.includes('CALL QUERY_VECTOR_INDEX')) {
        throw new Error('query vector index unsupported in test');
      }
      return [];
    });

    const executeWithReusedStatement = mockExecuteWithReusedStatement();
    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await fs.writeFile(
      checkpointPath,
      createCheckpoint({
        path: checkpointPath,
        currentLabel: 'Function',
        lastCompletedNodeId: resumeNode.id,
        modelHash: 'model-hash',
        headCommit: 'head-commit',
      }),
    );

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined,
      undefined,
      new Map(),
      undefined,
      undefined,
      {
        path: checkpointPath,
        embeddingTextVersion: EMBEDDING_TEXT_VERSION,
        modelHash: 'model-hash',
        headCommit: 'head-commit',
      },
    );

    expect(queryCalls.some((q) => q.includes("WHERE n.id > 'Function:func-a:src/a.ts'"))).toBe(
      true,
    );
    await expect(fs.access(checkpointPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.rm(checkpointRepo, { recursive: true, force: true });
  });

  it('ignores checkpoint when model hash changes', async () => {
    mockEmbedderSetup();

    const checkpointRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-embed-cp-'));
    const checkpointPath = path.join(checkpointRepo, 'embedding-checkpoint.json');
    const queryCalls: string[] = [];

    const executeQuery = vi.fn().mockImplementation(async (cypher: string) => {
      queryCalls.push(cypher);
      if (cypher.includes('RETURN count(n) AS count')) {
        return [{ count: 1 }];
      }
      if (cypher.includes('MATCH (n:`Function`)')) {
        return [
          {
            id: 'Function:func-b:src/b.ts',
            name: 'funcB',
            label: 'Function',
            filePath: 'src/b.ts',
            content: 'function funcB() { return 1; }',
          },
        ];
      }
      if (cypher.includes('MATCH (e:CodeEmbedding)')) {
        return [];
      }
      if (cypher.includes('CREATE_VECTOR_INDEX')) {
        return [];
      }
      if (cypher.includes('CALL QUERY_VECTOR_INDEX')) {
        throw new Error('query vector index unsupported in test');
      }
      return [];
    });

    const executeWithReusedStatement = mockExecuteWithReusedStatement();

    const { runEmbeddingPipeline } =
      await import('../../src/core/embeddings/embedding-pipeline.js');

    await fs.writeFile(
      checkpointPath,
      createCheckpoint({
        path: checkpointPath,
        currentLabel: 'Function',
        lastCompletedNodeId: 'Function:func-a:src/a.ts',
        modelHash: 'different-model',
        headCommit: 'head-commit',
      }),
    );

    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      onProgress,
      {},
      undefined,
      undefined,
      new Map(),
      undefined,
      undefined,
      {
        path: checkpointPath,
        embeddingTextVersion: EMBEDDING_TEXT_VERSION,
        modelHash: 'model-hash',
        headCommit: 'head-commit',
      },
    );

    expect(queryCalls.some((q) => q.includes("WHERE n.id > 'Function:func-a:src/a.ts'"))).toBe(
      false,
    );
    await fs.rm(checkpointRepo, { recursive: true, force: true });
  });

  it.each([['0'], ['129'], ['abc'], [undefined]])(
    'falls back to default sub-batch size when ONTOINDEX_EMBED_SUB_BATCH is %s',
    async (envValue) => {
      const embedBatchSpy = vi
        .fn()
        .mockImplementation((texts: string[]) =>
          Promise.resolve(texts.map(() => new Float32Array(384))),
        );
      vi.doMock('../../src/core/embeddings/embedder.js', () => ({
        initEmbedder: vi.fn().mockResolvedValue(undefined),
        embedBatch: embedBatchSpy,
        embedText: vi.fn().mockResolvedValue(new Float32Array(384)),
        embeddingToArray: vi.fn().mockImplementation((emb: Float32Array) => Array.from(emb)),
        isEmbedderReady: vi.fn().mockReturnValue(true),
      }));
      vi.doMock('../../src/core/lbug/lbug-adapter.js', () => ({
        loadVectorExtension: vi.fn().mockResolvedValue(undefined),
      }));

      const executeQuery = mockExecuteQuery(makeLongNodeList(17));
      const executeWithReusedStatement = mockExecuteWithReusedStatement();

      const runWithEnv = async () => {
        const { runEmbeddingPipeline } =
          await import('../../src/core/embeddings/embedding-pipeline.js');
        await runEmbeddingPipeline(
          executeQuery,
          executeWithReusedStatement,
          onProgress,
          { batchSize: 25 },
          undefined,
          undefined,
          new Map(),
        );
      };

      await withEmbedSubBatchEnv(envValue as string | undefined, runWithEnv);

      expect(embedBatchSpy).toHaveBeenCalledTimes(2); // 17 items with default sub-batch size 16
      embedBatchSpy.mock.calls.forEach(([texts], index) => {
        if (index === 0) {
          expect(texts.length).toBe(16);
        } else {
          expect(texts.length).toBe(1);
        }
      });
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// fetchExistingEmbeddingHashes — tested in integration tests (requires native module)
// The function is tested via lbug-core-adapter integration tests which have the
// native @ladybugdb/core module available.
// ────────────────────────────────────────────────────────────────────────────
