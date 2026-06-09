import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Intercept @ladybugdb/core so tests never touch the real native driver.
// ---------------------------------------------------------------------------
const { fakeConn, fakeDb } = vi.hoisted(() => {
  const fakeStmt = { isSuccess: () => true, getErrorMessage: async () => '' };
  const fakeConn = {
    prepare: vi.fn().mockResolvedValue(fakeStmt),
    execute: vi.fn(),
    query: vi.fn(),
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

import { openBridgeDb, queryBridge, closeBridgeDb } from '../../../src/core/group/bridge-db.js';

describe('withCallTimeout — bridge-db queryBridge', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-timeout-'));
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects when conn.query returns a QueryResult whose getAll() hangs', async () => {
    const hangingResult = { getAll: () => new Promise<never>(() => {}) };
    fakeConn.query.mockResolvedValue(hangingResult);

    const handle = await openBridgeDb(path.join(tmpDir, 'test.lbug'));
    const pending = queryBridge(handle, 'MATCH (n) RETURN n');
    // Attach the rejection handler BEFORE advancing fake timers so that
    // the rejection is handled synchronously when the timer fires — prevents
    // a PromiseRejectionHandledWarning from vitest.
    const assertion = expect(pending).rejects.toThrow(/native call timed out after 30000ms/);

    await vi.advanceTimersByTimeAsync(30_001);

    await assertion;

    // Cleanup (best-effort — handle may be in broken state).
    await closeBridgeDb(handle).catch(() => {});
  });
});
