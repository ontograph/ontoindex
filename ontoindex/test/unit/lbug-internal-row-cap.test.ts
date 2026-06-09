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
  const bigRows = new Array(50_001).fill({ id: 1 });
  const fakeQueryResult = { getAll: vi.fn().mockResolvedValue(bigRows) };
  const fakeConn = {
    prepare: vi.fn().mockResolvedValue(fakeStmt),
    execute: vi.fn().mockResolvedValue(fakeQueryResult),
    // schema init queries during initLbug
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

import { initLbug, executePrepared } from '../../src/core/lbug/lbug-adapter.js';

describe('internal row cap (MAX_INTERNAL_ROWS = 50_000)', () => {
  it('executePrepared throws when result.getAll() returns >= 50_000 rows', async () => {
    // Use a real temp directory so the adapter's fs.mkdir succeeds.
    const dbPath = path.join(os.tmpdir(), 'ontoindex-test-row-cap', 'test.lbug');
    await initLbug(dbPath);

    await expect(executePrepared('MATCH (n) RETURN n', {})).rejects.toThrow('exceeded');
  });
});
