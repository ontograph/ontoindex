/**
 * Unit tests for WAL-corruption recovery in pool-adapter doInitLbug.
 *
 * Strategy: mock @ladybugdb/core so the Database constructor is fully
 * under test control.  A real temp file is created so the fs.stat check
 * passes without mocking Node built-ins (which vitest handles differently
 * from user modules).  Two scenarios:
 *
 *   1. First open throws (WAL corrupt), second open (throwOnWalReplayFailure=false) succeeds
 *      → warning emitted on stderr, initLbug resolves.
 *   2. Both opens throw → initLbug rejects with the "unrecoverable" message.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before the module under test is imported.
// ---------------------------------------------------------------------------

// Minimal fake Connection returned by the Connection mock.
const makeConnection = () => ({
  query: vi.fn().mockResolvedValue([{ getAll: vi.fn().mockResolvedValue([]) }]),
  close: vi.fn().mockResolvedValue(undefined),
});

// Shared mutable state so individual tests can swap behaviour.
// dbOpenImpl is a plain object (not a vi.fn) so individual tests can
// swap its .open property without fighting vi.fn's constructor detection.
const lbugState = vi.hoisted(() => {
  const dbOpenImpl: { open: ((...args: any[]) => any) | null } = { open: null };
  return { dbOpenImpl };
});

vi.mock('@ladybugdb/core', () => {
  // Use a named class so `new lbug.Database(...)` works as a constructor.
  // The class delegates to lbugState.dbOpenImpl.open so tests can swap
  // behavior without fighting vitest's "must use function or class" constraint.
  class DatabaseMock {
    constructor(...args: any[]) {
      if (lbugState.dbOpenImpl.open) {
        const result = lbugState.dbOpenImpl.open(...args);
        // If open throws, propagate. Otherwise copy properties onto this.
        if (result && typeof result === 'object') {
          Object.assign(this as any, result);
        }
      }
    }
    close = vi.fn().mockResolvedValue(undefined);
  }

  class ConnectionMock {
    query = vi.fn().mockResolvedValue([{ getAll: vi.fn().mockResolvedValue([]) }]);
    close = vi.fn().mockResolvedValue(undefined);
  }

  return {
    default: {
      Database: DatabaseMock,
      Connection: ConnectionMock,
    },
  };
});

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are in place.
// ---------------------------------------------------------------------------
import { initLbug, closeLbug } from '../../src/core/lbug/pool-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture all bytes written to process.stderr.write during `fn()`. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: any, ..._rest: any[]): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WAL corruption recovery in initLbug (pool-adapter)', () => {
  const repoId = 'wal-recovery-test-repo';
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    // Create a real temp file so pool-adapter's fs.stat check passes.
    tmpDir = await mkdtemp(join(tmpdir(), 'ontoindex-wal-test-'));
    dbPath = join(tmpDir, 'test.lbug');
    await writeFile(dbPath, ''); // empty file is enough to pass stat check

    // Ensure pool is clean before each test.
    await closeLbug(repoId);
    // Reset the open implementation so tests start from a clean state.
    lbugState.dbOpenImpl.open = null;
  });

  afterEach(async () => {
    await closeLbug(repoId);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('recovers from WAL corruption: emits stderr warning and resolves', async () => {
    // First Database construction throws (WAL replay failure with throwOnWalReplayFailure=true).
    // Second construction (throwOnWalReplayFailure=false) succeeds → recovery path.
    const openCallArgs: any[][] = [];
    let openCallCount = 0;
    lbugState.dbOpenImpl.open = (...args: any[]) => {
      openCallCount++;
      openCallArgs.push(args);
      if (openCallCount === 1) {
        throw new Error('Failed to open database: WAL replay error at offset 4096');
      }
      // Success on second call — return nothing (DatabaseMock class provides defaults).
    };

    const stderrOutput = await captureStderr(async () => {
      await initLbug(repoId, dbPath);
    });

    // Must have emitted the WAL warning on stderr (not console.warn / console.log).
    expect(stderrOutput).toContain('WAL corruption detected on open');
    expect(stderrOutput).toContain('ontoindex analyze');

    // Two Database constructions: normal open (throws) + recovery open (succeeds).
    expect(openCallCount).toBe(2);

    // Recovery call must pass throwOnWalReplayFailure=false as the 8th positional arg (index 7).
    expect(openCallArgs[1][7]).toBe(false);
  });

  it('throws unrecoverable error when both open attempts fail', async () => {
    lbugState.dbOpenImpl.open = () => {
      throw new Error('Failed to open database: WAL replay error at offset 4096');
    };

    await expect(initLbug(repoId, dbPath)).rejects.toThrow(/unrecoverable due to WAL corruption/);
  });
});
