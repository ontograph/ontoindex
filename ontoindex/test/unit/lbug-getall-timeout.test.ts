import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// vi.hoisted() runs before vi.mock() factories — variables defined here are
// accessible inside the factory without the "cannot access before init" error.
// ---------------------------------------------------------------------------
const { fakeConn, fakeDb } = vi.hoisted(() => {
  // A QueryResult whose getAll() returns a promise that never resolves.
  const hangingQueryResult = { getAll: vi.fn().mockReturnValue(new Promise(() => {})) };
  const fakeConn = {
    prepare: vi.fn(),
    execute: vi.fn(),
    // schema init queries during initLbug succeed immediately
    query: vi.fn().mockResolvedValue({ getAll: async () => [] }),
    close: vi.fn(),
  };
  const fakeDb = { close: vi.fn() };
  return { fakeConn, fakeDb, hangingQueryResult };
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

import { initLbug, executeQuery } from '../../src/core/lbug/lbug-adapter.js';

describe('getAllWithTimeout — lbug-adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects with timeout message when getAll() never resolves', async () => {
    const dbPath = path.join(os.tmpdir(), 'ontoindex-test-timeout', 'test.lbug');
    await initLbug(dbPath);

    // Make conn.query return a QueryResult whose getAll() hangs forever.
    fakeConn.query.mockResolvedValueOnce({ getAll: () => new Promise(() => {}) });

    const pending = executeQuery('MATCH (n) RETURN n');
    // Attach the rejection handler BEFORE advancing fake timers so that
    // the rejection is handled synchronously when the timer fires — prevents
    // a PromiseRejectionHandledWarning from vitest.
    const assertion = expect(pending).rejects.toThrow(/getAll timed out after 30000ms/);

    // Advance fake timers past the 30 s threshold.
    await vi.advanceTimersByTimeAsync(30_001);

    await assertion;
  });
});
