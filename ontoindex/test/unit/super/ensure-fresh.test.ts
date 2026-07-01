/**
 * Unit tests: gnEnsureFresh
 *
 * All external I/O (child_process, fs, os) is mocked via vi.mock.
 * No real git process, filesystem, or registry access is used.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

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

vi.mock('../../../src/storage/repo-manager.js', () => ({
  loadMeta: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

vi.mock('../../../src/core/runtime/runtime-health.js', () => ({
  readRuntimeHealth: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import { execFile, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { gnEnsureFresh } from '../../../src/mcp/super/ensure-fresh.js';
import { readRuntimeHealth } from '../../../src/core/runtime/runtime-health.js';
import { loadMeta } from '../../../src/storage/repo-manager.js';

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReadRuntimeHealth = vi.mocked(readRuntimeHealth);
const mockLoadMeta = vi.mocked(loadMeta);

let savedEnv: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';
const REPO_PATH = path.resolve('/home/testuser/_wrk/test-repo');
const CURRENT_COMMIT = 'abc123def456abc123def456abc123def456abc1';
const INDEXED_COMMIT = 'abc123def456abc123def456abc123def456abc1'; // same = fresh
const EMBEDDING_MODEL_HASH = 'hash-a';

const STALE_INDEXED_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function makeRuntimeHealth(
  freshnessState:
    | 'clean'
    | 'stale'
    | 'dirty'
    | 'degraded'
    | 'untrusted'
    | 'failed-after-partial-run' = 'clean',
) {
  return {
    version: 1 as const,
    repoLabel: REPO_ID,
    repoPath: REPO_PATH,
    indexedCommit: INDEXED_COMMIT,
    currentCommit: CURRENT_COMMIT,
    dirtyWorktree: false,
    freshnessState,
    degradedReason: freshnessState === 'clean' ? null : `${freshnessState} reason`,
    repairCommand: 'ontoindex analyze --force',
    hasRuntimeArtifacts: freshnessState !== 'clean',
    analyzeLock: {
      path: `${REPO_PATH}/.ontoindex/analyze.lock`,
      present: false,
      state: 'absent' as const,
    },
    analysisCheckpoint: {
      path: `${REPO_PATH}/.ontoindex/analysis-checkpoint.json`,
      present: false,
      state: 'absent' as const,
    },
    embeddingCheckpoint: {
      path: `${REPO_PATH}/.ontoindex/embedding-checkpoint.json`,
      present: false,
    },
    bootstrapSource: {
      path: `${REPO_PATH}/.ontoindex/bootstrap-source.json`,
      present: false,
    },
    warnings: [],
  };
}

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

function makeMeta(
  options: {
    lastCommit?: string;
    embeddings?: number;
    modelHash?: string;
  } = {},
) {
  return {
    repoPath: REPO_PATH,
    lastCommit: options.lastCommit ?? INDEXED_COMMIT,
    indexedAt: '2026-06-17T00:00:00.000Z',
    model_hash: options.modelHash ?? EMBEDDING_MODEL_HASH,
    stats: {
      embeddings: options.embeddings ?? 12,
    },
  };
}

/** Set up execFile to handle the standard calls. */
function setupExecFile(
  options: {
    currentCommit?: string;
    repoRoot?: string;
    statusOutput?: string;
  } = {},
) {
  const { currentCommit = CURRENT_COMMIT, repoRoot = REPO_PATH, statusOutput = '' } = options;

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
    if (args.includes('status') && args.includes('--porcelain')) {
      callback(null, statusOutput, '');
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
    savedEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ONTOINDEX_')) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    process.env.ONTOINDEX_EMBEDDING_MODEL_HASH = EMBEDDING_MODEL_HASH;
    setupSpawnExit();
    mockReadRuntimeHealth.mockResolvedValue(makeRuntimeHealth());
    mockLoadMeta.mockResolvedValue(makeMeta() as any);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ONTOINDEX_')) delete process.env[key];
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
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
    expect(report.repoLabel).toBe(REPO_ID);
    expect(report.repoPath).toBe(REPO_PATH);
    expect(report.headCommit).toBe(CURRENT_COMMIT);
    expect(report.indexedCommit).toBe(CURRENT_COMMIT);
    expect(report.dirtyFileCount).toBe(0);
    expect(report.scopeConfidence).toBe('high');
    expect(report.actionsTaken).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    // No stale recommendation
    expect(report.recommendations.some((r) => r.includes('stale'))).toBe(false);
  });

  it('resolves MCP backend repo ids case-insensitively and reads HEAD from the registry path', async () => {
    let headCwd: string | undefined;
    mockExecFile.mockImplementation((_cmd: string, args: string[], opts: any, callback: any) => {
      if (args.includes('HEAD') && args.includes('rev-parse')) {
        headCwd = opts.cwd;
        callback(null, CURRENT_COMMIT + '\n', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ name: 'Test-Repo', path: REPO_PATH, lastCommit: CURRENT_COMMIT }) as any,
    );

    const report = await gnEnsureFresh('test-repo', {});

    expect(headCwd).toBe(REPO_PATH);
    expect(report.preCheck).toEqual({
      indexedCommit: CURRENT_COMMIT,
      currentCommit: CURRENT_COMMIT,
      isStale: false,
    });
    expect(report.repoLabel).toBe('Test-Repo');
    expect(report.repoPath).toBe(REPO_PATH);
    expect(report.scopeConfidence).toBe('high');
    expect(report.warnings).toHaveLength(0);
  });

  it('resolves absolute repo path selectors without depending on process cwd', async () => {
    let headCwd: string | undefined;
    mockExecFile.mockImplementation((_cmd: string, args: string[], opts: any, callback: any) => {
      if (args.includes('HEAD') && args.includes('rev-parse')) {
        headCwd = opts.cwd;
        callback(null, CURRENT_COMMIT + '\n', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ path: REPO_PATH, lastCommit: CURRENT_COMMIT }) as any,
    );

    const report = await gnEnsureFresh(REPO_PATH, {});

    expect(headCwd).toBe(REPO_PATH);
    expect(report.preCheck.currentCommit).toBe(CURRENT_COMMIT);
    expect(report.preCheck.indexedCommit).toBe(CURRENT_COMMIT);
    expect(report.repoLabel).toBe(REPO_ID);
    expect(report.repoPath).toBe(REPO_PATH);
    expect(report.scopeConfidence).toBe('high');
    expect(report.warnings).toHaveLength(0);
  });

  it('falls back to the cwd repo when no selector is provided', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh('', {});

    expect(report.repoLabel).toBe(REPO_ID);
    expect(report.repoPath).toBe(REPO_PATH);
    expect(report.scopeConfidence).toBe('medium');
    expect(report.dirtyFileCount).toBe(0);
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

  it('does not autoAnalyze when runtime health is untrusted', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadRuntimeHealth.mockResolvedValue(makeRuntimeHealth('untrusted'));
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(report.runtimeHealth?.freshnessState).toBe('untrusted');
    expect(report.recommendations.some((item) => item.includes('repair manually'))).toBe(true);
    expect(report.actionsTaken).toHaveLength(0);
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
    mockLoadMeta.mockResolvedValue(makeMeta({ embeddings: 42 }) as any);

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.embeddingsStatus.count).toBe(42);
    expect(report.embeddingsStatus.required).toBe(false);
    expect(report.embeddingsStatus.status).toBe('ok');
    expect(report.embeddingsStatus.repairCommand).toBeUndefined();
  });

  // ---- Bonus Test 6: withEmbeddings + count=0 → required: true + recommendation
  it('marks embeddingsStatus.required: true when withEmbeddings and count is 0', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 0 }) as any,
    );
    mockLoadMeta.mockResolvedValue(makeMeta({ embeddings: 0 }) as any);

    const report = await gnEnsureFresh(REPO_ID, { withEmbeddings: true });

    expect(report.embeddingsStatus.required).toBe(true);
    expect(report.embeddingsStatus.status).toBe('missing');
    expect(report.recommendations.some((r) => r.includes('ontoindex analyze'))).toBe(true);
  });

  it('marks embeddingsStatus.metadata-unavailable when repo metadata is missing', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 5 }) as any,
    );
    mockLoadMeta.mockResolvedValue(null);

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.embeddingsStatus.status).toBe('metadata-unavailable');
    expect(report.embeddingsStatus.reason).toMatch(/unavailable/i);
    expect(report.embeddingsStatus.repairCommand).toBe('ontoindex analyze');
  });

  it('marks embeddingsStatus.drifted when the stored embedding hash differs from the runtime hash', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 12 }) as any,
    );
    mockLoadMeta.mockResolvedValue(makeMeta({ modelHash: 'stored-hash', embeddings: 12 }) as any);
    process.env.ONTOINDEX_EMBEDDING_MODEL_HASH = 'runtime-hash';

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.embeddingsStatus.status).toBe('drifted');
    expect(report.embeddingsStatus.reason).toContain('stored-hash');
    expect(report.embeddingsStatus.repairCommand).toBe('ontoindex analyze --force --embeddings');
  });

  it('keeps embeddingsStatus.ok when embeddings exist and the runtime hash is unset', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 12 }) as any,
    );
    mockLoadMeta.mockResolvedValue(makeMeta({ modelHash: 'stored-hash', embeddings: 12 }) as any);
    delete process.env.ONTOINDEX_EMBEDDING_MODEL_HASH;

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.embeddingsStatus.status).toBe('ok');
    expect(report.embeddingsStatus.count).toBe(12);
    expect(report.embeddingsStatus.reason).toContain('drift check skipped');
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
