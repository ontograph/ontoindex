/**
 * Unit tests: gnEnsureFresh
 *
 * All external I/O (child_process, fs, os) is mocked via vi.mock.
 * No real git process, filesystem, or registry access is used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before the module under test is imported.
// vi.mock factories are hoisted.
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import { execFile, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { gnEnsureFresh } from '../../../src/mcp/super/ensure-fresh.js';

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);
const mockReadFileSync = vi.mocked(readFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';
const REPO_PATH = '/home/testuser/_wrk/test-repo';
const CURRENT_COMMIT = 'abc123def456abc123def456abc123def456abc1';
const INDEXED_COMMIT = 'abc123def456abc123def456abc123def456abc1'; // same = fresh

const STALE_INDEXED_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** Build a minimal registry JSON string. */
function makeRegistry(
  options: {
    name?: string;
    path?: string;
    lastCommit?: string;
    embeddings?: number;
  } = {},
): string {
  return JSON.stringify([
    {
      name: options.name ?? REPO_ID,
      path: options.path ?? REPO_PATH,
      lastCommit: options.lastCommit ?? INDEXED_COMMIT,
      stats: {
        embeddings: options.embeddings ?? 0,
      },
    },
  ]);
}

/** Set up execFile to handle the standard calls. */
function setupExecFile(
  options: {
    currentCommit?: string;
    repoRoot?: string;
  } = {},
) {
  const { currentCommit = CURRENT_COMMIT, repoRoot = REPO_PATH } = options;

  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, callback: any) => {
    // git rev-parse --show-toplevel
    if (args.includes('--show-toplevel')) {
      callback(null, repoRoot + '\n', '');
      return {} as any;
    }
    // git rev-parse HEAD
    if (args.includes('HEAD') && args.includes('rev-parse')) {
      callback(null, currentCommit + '\n', '');
      return {} as any;
    }
    callback(null, '', '');
    return {} as any;
  });
}

function setupSpawnExit(code: number = 0) {
  mockSpawn.mockImplementation(() => {
    const child = new EventEmitter() as any;
    child.kill = vi.fn();
    setImmediate(() => child.emit('exit', code, null));
    return child;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gnEnsureFresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSpawnExit();
  });

  // ---- Test 1: Fresh index → isStale: false --------------------------------
  it('returns isStale: false when indexedCommit matches currentCommit', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.version).toBe(1);
    expect(report.preCheck.isStale).toBe(false);
    expect(report.preCheck.currentCommit).toBe(CURRENT_COMMIT);
    expect(report.preCheck.indexedCommit).toBe(CURRENT_COMMIT);
    expect(report.actionsTaken).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    // No stale recommendation
    expect(report.recommendations.some((r) => r.includes('stale'))).toBe(false);
  });

  // ---- Test 2: Stale without autoAnalyze → recommendations, no actions ----
  it('populates recommendations but takes no actions when stale and autoAnalyze is false', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: false });

    expect(report.preCheck.isStale).toBe(true);
    expect(report.preCheck.indexedCommit).toBe(STALE_INDEXED_COMMIT);
    expect(report.preCheck.currentCommit).toBe(CURRENT_COMMIT);
    expect(report.actionsTaken).toHaveLength(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(report.recommendations[0]).toContain('stale');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  // ---- Test 3: Stale with autoAnalyze: true → spawn called ----------------
  it('spawns ontoindex analyze when stale and autoAnalyze: true', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    // First readFileSync call: pre-check registry; second: post-check registry
    mockReadFileSync
      .mockReturnValueOnce(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any)
      .mockReturnValueOnce(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const analyzeCall = mockSpawn.mock.calls[0];
    expect(analyzeCall[0]).toBe(process.execPath);
    expect(analyzeCall[1]).toContain('analyze');
    expect(analyzeCall[2]).toMatchObject({ cwd: REPO_PATH });
    // --embeddings NOT included (withEmbeddings not set)
    expect(analyzeCall[1]).not.toContain('--embeddings');

    expect(report.actionsTaken).toHaveLength(1);
    expect(report.actionsTaken[0]).toContain('analyze');
    // postCheck should be populated
    expect(report.postCheck).toBeDefined();
    expect(report.postCheck!.isStale).toBe(false);
  });

  // ---- Test 4: withEmbeddings: true adds --embeddings to analyze args ------
  it('adds --embeddings to analyze args when withEmbeddings: true', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync
      .mockReturnValueOnce(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any)
      .mockReturnValueOnce(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    await gnEnsureFresh(REPO_ID, { autoAnalyze: true, withEmbeddings: true });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][1]).toContain('--embeddings');
  });

  // ---- Test 5: embeddingsCount surfaced from registry ---------------------
  it('surfaces embeddingsCount from registry stats', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 42 }) as any,
    );

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.embeddingsStatus.count).toBe(42);
    expect(report.embeddingsStatus.required).toBe(false);
  });

  // ---- Bonus Test 6: withEmbeddings + count=0 → required: true + recommendation
  it('marks embeddingsStatus.required: true when withEmbeddings and count is 0', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 0 }) as any,
    );

    const report = await gnEnsureFresh(REPO_ID, { withEmbeddings: true });

    expect(report.embeddingsStatus.required).toBe(true);
    expect(report.recommendations.some((r) => r.includes('Embeddings not populated'))).toBe(true);
  });

  // ---- Bonus Test 7: repo not in registry → warning + empty preCheck ------
  it('returns warning when repo is not found in registry', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    // Registry has a different repo
    mockReadFileSync.mockReturnValue(
      JSON.stringify([{ name: 'other-repo', path: '/other', lastCommit: 'aaa', stats: {} }]) as any,
    );

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.warnings.some((w) => w.includes('not in registry'))).toBe(true);
    expect(report.preCheck.isStale).toBe(false);
    expect(report.actionsTaken).toHaveLength(0);
  });

  // ---- Bonus Test 8: analyze failure → warning, no crash ------------------
  it('records a warning when autoAnalyze process fails', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    setupSpawnExit(1);
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(report.warnings.some((w) => w.includes('analyze failed'))).toBe(true);
    expect(report.actionsTaken).toHaveLength(0);
  });

  // ---- Test 9: killMcpForLock:true is advisory only → no process kill ----
  it('does not kill MCP processes when killMcpForLock:true', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync
      .mockReturnValueOnce(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any)
      .mockReturnValueOnce(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true, killMcpForLock: true });

    expect(mockExecFile.mock.calls.some((call) => call[0] === 'kill')).toBe(false);
    expect(mockExecFile.mock.calls.some((call) => call[0] === 'pgrep')).toBe(false);
    // analyze ran
    expect(report.actionsTaken.some((a) => a.includes('analyze'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('advisory only'))).toBe(true);
    expect(report.recommendations.some((r) => r.includes('Stop only the MCP process'))).toBe(true);
  });

  // ---- Test 10: killMcpForLock:true + autoAnalyze:false → note in recommendations ----
  it('adds a note in recommendations when killMcpForLock:true but autoAnalyze:false', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: false, killMcpForLock: true });

    // no kill, no analyze
    expect(mockExecFile.mock.calls.some((call) => call[0] === 'kill')).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    // note in recommendations
    expect(
      report.recommendations.some((r) => r.includes('no effect without autoAnalyze: true')),
    ).toBe(true);
  });
});
