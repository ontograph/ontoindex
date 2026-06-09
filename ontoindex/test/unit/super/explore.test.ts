/**
 * Unit tests for gn_explore super-function (W1a).
 *
 * All external primitives are mocked so tests run without a live DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import under test.
// ---------------------------------------------------------------------------

vi.mock('../../../src/core/search/intent-classifier.js', () => ({
  classifyIntent: vi.fn(),
}));

vi.mock('../../../src/core/search/skeleton.js', () => ({
  getFileSkeleton: vi.fn(),
}));

vi.mock('../../../src/core/search/graph-path.js', () => ({
  computeGraphPath: vi.fn(),
}));

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  executeParameterized: vi.fn(),
}));

vi.mock('../../../src/mcp/local/backend-search.js', () => ({
  query: vi.fn(),
}));

vi.mock('../../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([
    {
      name: 'test-repo',
      path: '/tmp/test-repo',
      repoPath: '/tmp/test-repo',
      storagePath: '/tmp/test-repo/.ontoindex',
      lastCommit: 'test-head',
    },
  ]),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { classifyIntent } from '../../../src/core/search/intent-classifier.js';
import { getFileSkeleton } from '../../../src/core/search/skeleton.js';
import { computeGraphPath } from '../../../src/core/search/graph-path.js';
import { executeParameterized, initLbug } from '../../../src/core/lbug/pool-adapter.js';
import { query as backendQuery } from '../../../src/mcp/local/backend-search.js';
import { listRegisteredRepos } from '../../../src/storage/repo-manager.js';
import { gnExplore } from '../../../src/mcp/super/explore.js';

// Typed mock handles.
const mockClassifyIntent = classifyIntent as unknown as ReturnType<typeof vi.fn>;
const mockGetFileSkeleton = getFileSkeleton as unknown as ReturnType<typeof vi.fn>;
const mockComputeGraphPath = computeGraphPath as unknown as ReturnType<typeof vi.fn>;
const mockInitLbug = initLbug as unknown as ReturnType<typeof vi.fn>;
const mockExecuteParameterized = executeParameterized as unknown as ReturnType<typeof vi.fn>;
const mockBackendQuery = backendQuery as unknown as ReturnType<typeof vi.fn>;
const mockListRegisteredRepos = listRegisteredRepos as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function makeSymbol(id: string, name = `sym_${id}`, filePath = `src/${id}.ts`): any {
  return { nodeId: id, id, name, filePath, type: 'Function' };
}

function makeDefaultQueryResult(count = 5): any {
  return {
    processes: [
      { id: 'proc-1', summary: 'Ingestion pipeline', priority: 0.9 },
      { id: 'proc-2', summary: 'Search pipeline', priority: 0.7 },
    ],
    process_symbols: Array.from({ length: count }, (_, i) => ({
      ...makeSymbol(`node-${i}`, `fn${i}`, `src/mod${i}.ts`),
      process_id: 'proc-1',
    })),
    definitions: [],
  };
}

function defaultClassification(intent = 'nl-conceptual' as const) {
  return { intent, confidence: 0.8, matchedKeywords: [] };
}

// ---------------------------------------------------------------------------
// Setup: reset all mocks before each test.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  // Defaults that keep tests green unless a specific test overrides.
  mockClassifyIntent.mockReturnValue(defaultClassification());
  mockBackendQuery.mockResolvedValue(makeDefaultQueryResult());
  mockListRegisteredRepos.mockResolvedValue([
    {
      name: 'test-repo',
      path: '/tmp/test-repo',
      repoPath: '/tmp/test-repo',
      storagePath: '/tmp/test-repo/.ontoindex',
      lastCommit: 'test-head',
    },
  ]);
  mockGetFileSkeleton.mockResolvedValue('Symbols in src/foo.ts:\n  - function fn0 (lines 1-10)');
  mockComputeGraphPath.mockResolvedValue([
    { fromId: 'node-0', toId: 'node-1', type: 'CALLS', depth: 1 },
  ]);
  mockInitLbug.mockResolvedValue(undefined);
  // executeParameterized: cluster + cochange return empty by default.
  mockExecuteParameterized.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Test 1: env vars are restored after a successful call.
// ---------------------------------------------------------------------------

describe('gn_explore', () => {
  it('env vars are restored after success', async () => {
    const prevEnsemble = process.env.ONTOINDEX_INTENT_ENSEMBLE;
    const prevCitations = process.env.ONTOINDEX_CITATIONS;

    // Ensure both are absent before the call.
    delete process.env.ONTOINDEX_INTENT_ENSEMBLE;
    delete process.env.ONTOINDEX_CITATIONS;

    await gnExplore('test-repo', { query: 'how does auth work' });

    expect(process.env.ONTOINDEX_INTENT_ENSEMBLE).toBe(prevEnsemble);
    expect(process.env.ONTOINDEX_CITATIONS).toBe(prevCitations);
  });

  it('resolves canonical lower-case repo ids from registered repo names', async () => {
    mockListRegisteredRepos.mockResolvedValue([
      {
        name: 'OntoIndex',
        path: '/tmp/OntoIndex',
        repoPath: '/tmp/OntoIndex',
        storagePath: '/tmp/OntoIndex/.ontoindex',
        lastCommit: 'test-head',
      },
    ]);

    const report = await gnExplore('ontoindex', { query: 'MCP tool contract', depth: 'shallow' });

    expect(report.topSymbols.length).toBeGreaterThan(0);
    expect(mockBackendQuery).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ontoindex', name: 'OntoIndex', repoPath: '/tmp/OntoIndex' }),
      expect.objectContaining({ query: 'MCP tool contract' }),
    );
    expect(mockInitLbug.mock.calls[0]?.[0]).toBe('ontoindex');
    expect(String(mockInitLbug.mock.calls[0]?.[1]).replace(/\\/g, '/')).toBe(
      '/tmp/OntoIndex/.ontoindex/lbug',
    );
    expect(mockGetFileSkeleton).toHaveBeenCalledWith(
      'ontoindex',
      expect.any(String),
      expect.any(Number),
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: env vars are restored even when a primitive throws.
  // -------------------------------------------------------------------------

  it('env vars are restored after primitive throws (error path)', async () => {
    mockBackendQuery.mockRejectedValue(new Error('mock backend failure'));

    delete process.env.ONTOINDEX_INTENT_ENSEMBLE;
    delete process.env.ONTOINDEX_CITATIONS;

    // gnExplore handles the error internally (pushes to warnings) — it must not rethrow.
    const report = await gnExplore('test-repo', { query: 'auth flow' });

    expect(process.env.ONTOINDEX_INTENT_ENSEMBLE).toBeUndefined();
    expect(process.env.ONTOINDEX_CITATIONS).toBeUndefined();
    // A warning should have been pushed.
    expect(report.warnings.some((w) => w.includes('mock backend failure'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: depth 'shallow' returns ≤ 3 topSymbols.
  // -------------------------------------------------------------------------

  it("depth: 'shallow' returns ≤3 topSymbols", async () => {
    // Provide 10 symbols so the limit is the binding constraint.
    mockBackendQuery.mockResolvedValue(makeDefaultQueryResult(10));

    const report = await gnExplore('test-repo', { query: 'embedding pipeline', depth: 'shallow' });

    expect(report.topSymbols.length).toBeLessThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // Test 4: depth 'deep' returns ≤ 10 topSymbols.
  // -------------------------------------------------------------------------

  it("depth: 'deep' returns ≤10 topSymbols", async () => {
    // Provide 20 symbols; expect at most 10.
    mockBackendQuery.mockResolvedValue(makeDefaultQueryResult(20));

    const report = await gnExplore('test-repo', { query: 'search pipeline', depth: 'deep' });

    expect(report.topSymbols.length).toBeLessThanOrEqual(10);
  });

  // -------------------------------------------------------------------------
  // Test 5: classifier intent flows into report.query.classified.
  // -------------------------------------------------------------------------

  it('classifier intent flows into query.classified', async () => {
    mockClassifyIntent.mockReturnValue({
      intent: 'calls-of',
      confidence: 0.9,
      matchedKeywords: ['who calls'],
    });

    const report = await gnExplore('test-repo', { query: 'who calls mergeWithRRF' });

    expect(report.query.classified.intent).toBe('calls-of');
    expect(report.query.classified.confidence).toBe(0.9);
  });

  // -------------------------------------------------------------------------
  // Test 6: includeCitations: false skips computeGraphPath calls.
  // -------------------------------------------------------------------------

  it('includeCitations: false skips computeGraphPath calls', async () => {
    await gnExplore('test-repo', { query: 'auth', includeCitations: false });

    expect(mockComputeGraphPath).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7: suggestedEntryPoints — process before symbol before file.
  // -------------------------------------------------------------------------

  it('suggestedEntryPoints ranked: process > symbol > file when all present', async () => {
    // One process and at least one symbol with a filePath must be present.
    mockBackendQuery.mockResolvedValue({
      processes: [{ id: 'proc-auth', summary: 'Auth process', priority: 1.0 }],
      process_symbols: [
        {
          nodeId: 'sym-login',
          id: 'sym-login',
          name: 'login',
          filePath: 'src/auth.ts',
          type: 'Function',
          process_id: 'proc-auth',
        },
      ],
      definitions: [],
    });

    const report = await gnExplore('test-repo', { query: 'auth flow' });

    const types = report.suggestedEntryPoints.map((e) => e.type);
    // First entry should be 'process', then 'symbol', then 'file'.
    expect(types[0]).toBe('process');
    expect(types[1]).toBe('symbol');
    expect(types[2]).toBe('file');
  });
});
