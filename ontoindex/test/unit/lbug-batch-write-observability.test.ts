import { describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// vi.hoisted() runs before vi.mock() factories — variables defined here are
// accessible inside the factory without the "cannot access before init" error.
// ---------------------------------------------------------------------------
const { fakeConn, fakeDb } = vi.hoisted(() => {
  const fakeStmt = {
    isSuccess: () => true,
    getErrorMessage: async () => '',
  };
  const fakeConn = {
    prepare: vi.fn().mockResolvedValue(fakeStmt),
    execute: vi.fn().mockResolvedValue(undefined),
    // schema init queries during initLbug succeed immediately
    query: vi.fn().mockResolvedValue({ getAll: async () => [] }),
    close: vi.fn(),
  };
  const fakeDb = { close: vi.fn() };
  return { fakeConn, fakeDb };
});

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(function (_path: string) {
      return fakeDb;
    }),
    Connection: vi.fn(function (_db: unknown) {
      return fakeConn;
    }),
  },
}));

import { initLbug, executeWithReusedStatement } from '../../src/core/lbug/lbug-adapter.js';

const DB_PATH = path.join(os.tmpdir(), 'ontoindex-test-batch-obs', 'test.lbug');

describe('executeWithReusedStatement — batch write observability', () => {
  it('throws a summary error when one sub-batch fails', async () => {
    await initLbug(DB_PATH);

    // Make execute fail on the second call (second sub-batch's first item)
    fakeConn.execute
      .mockResolvedValueOnce(undefined) // first sub-batch item 1
      .mockResolvedValueOnce(undefined) // first sub-batch item 2
      .mockResolvedValueOnce(undefined) // first sub-batch item 3
      .mockResolvedValueOnce(undefined) // first sub-batch item 4 (end of sub-batch 1)
      .mockRejectedValueOnce(new Error('disk full')); // second sub-batch fails

    // 5 params → 2 sub-batches (4 + 1)
    const paramsList = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }];

    await expect(executeWithReusedStatement('MERGE (n {a: $a})', paramsList)).rejects.toThrow(
      'sub-batch(es) failed',
    );
  });

  it('resolves without error when all sub-batches succeed', async () => {
    await initLbug(DB_PATH);

    fakeConn.execute.mockResolvedValue(undefined);

    const paramsList = [{ a: 1 }, { a: 2 }, { a: 3 }];

    await expect(
      executeWithReusedStatement('MERGE (n {a: $a})', paramsList),
    ).resolves.toBeUndefined();
  });
});
