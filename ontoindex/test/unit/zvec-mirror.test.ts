import { describe, expect, it } from 'vitest';
import {
  computeZvecEmbeddingRowsDigest,
  createZvecMirrorMetadata,
  evaluateZvecMirrorFreshness,
  ZVEC_MIRROR_SCHEMA_VERSION,
  zvecDocIdForEmbeddingRow,
} from '../../src/core/embeddings/zvec-mirror.js';
import type { ZvecEmbeddingRowIdentity } from '../../src/core/embeddings/zvec-mirror.js';

const rows: ZvecEmbeddingRowIdentity[] = [
  {
    id: 'code_embedding:1',
    nodeId: 'Function::src/a.ts::alpha',
    chunkIndex: 0,
    contentHash: 'sha256:111',
  },
  {
    id: 'code_embedding:2',
    nodeId: 'Function::src/b.ts::beta',
    chunkIndex: 1,
    contentHash: 'sha256:222',
  },
];

const firstRow = rows[0]!;
const secondRow = rows[1]!;

const baseCurrent = {
  schemaVersion: ZVEC_MIRROR_SCHEMA_VERSION,
  zvecPackageVersion: '0.0.0-test',
  embeddingDimension: 384,
  embeddingModelHash: 'sha256:model-a',
  sourceCommit: 'abc123',
  currentHead: 'abc123',
  graphIndexId: 'graph-index-1',
  graphIndexHash: 'graph-hash-1',
  codeEmbeddingRowCount: rows.length,
  codeEmbeddingRowDigest: computeZvecEmbeddingRowsDigest(rows),
  backendIndexType: 'hnsw',
  backendIndexParams: {
    efConstruction: 200,
    m: 16,
  },
} as const;

describe('zvec-mirror helpers', () => {
  it('keeps the embedding-row digest stable across row order', () => {
    const digestA = computeZvecEmbeddingRowsDigest(rows);
    const digestB = computeZvecEmbeddingRowsDigest([...rows].reverse());

    expect(digestA).toBe(digestB);
  });

  it('changes the digest when contentHash changes', () => {
    const digestA = computeZvecEmbeddingRowsDigest(rows);
    const digestB = computeZvecEmbeddingRowsDigest([
      firstRow,
      { ...secondRow, contentHash: 'sha256:changed' },
    ]);

    expect(digestA).not.toBe(digestB);
  });

  it('reports fresh metadata for a matching mirror and stale metadata for drift', () => {
    const metadata = createZvecMirrorMetadata({
      ...baseCurrent,
      codeEmbeddingRows: rows,
      buildTimestamp: '2026-06-19T00:00:00.000Z',
    });

    const fresh = evaluateZvecMirrorFreshness({
      current: baseCurrent,
      metadata,
    });
    expect(fresh.status).toBe('fresh');
    expect(fresh.reasonCodes).toHaveLength(0);

    const driftedRows = [firstRow, { ...secondRow, contentHash: 'sha256:drifted' }] as const;
    const stale = evaluateZvecMirrorFreshness({
      current: {
        ...baseCurrent,
        codeEmbeddingRowCount: driftedRows.length,
        codeEmbeddingRowDigest: computeZvecEmbeddingRowsDigest(driftedRows),
      },
      metadata,
    });

    expect(stale.status).toBe('stale');
    expect(stale.reasonCodes).toContain('code-embedding-row-digest-mismatch');
  });

  it('creates safe synthetic doc ids without leaking the raw node id', () => {
    const docId = zvecDocIdForEmbeddingRow(firstRow);

    expect(docId).toMatch(/^doc_[a-f0-9]{32}$/);
    expect(docId).not.toContain(firstRow.nodeId);
    expect(docId).not.toContain('::');
    expect(zvecDocIdForEmbeddingRow(firstRow)).toBe(docId);
  });
});
