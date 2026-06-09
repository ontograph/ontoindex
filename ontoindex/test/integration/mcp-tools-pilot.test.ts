/**
 * Integration tests: LocalBackend.callTool — 5 pilot tools
 *
 * Exercises the real LocalBackend class end-to-end with pool-adapter and
 * repo-manager mocked.  No real Kuzu/LadybugDB binary is required.
 *
 * Purpose: gate the middleware pipeline refactor — proves structural
 * invariants (dispatch, guard wrapping, response shape) survive refactoring.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// ─── Mock pool-adapter ─────────────────────────────────────────────────────
// Must be hoisted before LocalBackend import so the factory fires first.
const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
    isWriteQuery: vi.fn().mockReturnValue(false),
    executeParameterized: vi.fn().mockResolvedValue([]),
    executeQuery: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

// Re-export shim must use the same mocks
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

// ─── Mock repo-manager ─────────────────────────────────────────────────────
vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([
    {
      name: 'fixture',
      path: '/tmp/fixture-repo',
      storagePath: '/tmp/.ontoindex/repos/fixture',
      indexedAt: new Date().toISOString(),
      lastCommit: 'abc123',
      stats: { nodes: 10, edges: 5, files: 3, communities: 1, processes: 1 },
    },
  ]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

// ─── Mock search modules that load onnxruntime (native N-API) ─────────────
vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

// ─── Import under test (after all vi.mock calls) ───────────────────────────
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 600_000;

function assertResponseSize(result: unknown): void {
  expect(JSON.stringify(result).length).toBeLessThan(MAX_RESPONSE_BYTES);
}

function assertValidStatus(result: Record<string, unknown>): void {
  if ('status' in result) {
    expect(['success', 'error']).toContain(result.status);
  }
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('MCP tool integration pilot — 5 tools via LocalBackend.callTool', () => {
  let backend: LocalBackend;

  beforeAll(async () => {
    backend = new LocalBackend();
    await backend.init();
  });

  // ── 1. list_repos ──────────────────────────────────────────────────────
  it('list_repos returns an array with at least one repo entry', async () => {
    const result = await backend.callTool('list_repos', {});

    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // Spot-check shape: each entry must have a name string
    for (const repo of result as Array<Record<string, unknown>>) {
      expect(typeof repo.name).toBe('string');
    }
    assertResponseSize(result);
  });

  // ── 2. dead_code ───────────────────────────────────────────────────────
  it('dead_code { limit: 1 } returns a result with a status field', async () => {
    const result = (await backend.callTool('dead_code', { limit: 1 })) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect('status' in result).toBe(true);
    assertValidStatus(result);
    assertResponseSize(result);
  });

  // ── 3. hotspot_analysis ────────────────────────────────────────────────
  it('hotspot_analysis { limit: 1 } returns a result with a status field', async () => {
    const result = (await backend.callTool('hotspot_analysis', { limit: 1 })) as Record<
      string,
      unknown
    >;

    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect('status' in result).toBe(true);
    assertValidStatus(result);
    assertResponseSize(result);
  });

  // ── 4. tech_debt ───────────────────────────────────────────────────────
  it('tech_debt { limit: 1 } returns a result with a status field', async () => {
    const result = (await backend.callTool('tech_debt', { limit: 1 })) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect('status' in result).toBe(true);
    assertValidStatus(result);
    assertResponseSize(result);
  });

  // ── 5. cypher ─────────────────────────────────────────────────────────
  it('cypher { query: "RETURN 1 AS n LIMIT 1" } returns a non-null result under 600 KB', async () => {
    // Provide a minimal tabular row so formatCypherAsMarkdown produces
    // { markdown, row_count } rather than the empty-array pass-through.
    lbugMocks.executeQuery.mockResolvedValueOnce([{ n: 1 }]);

    const result = await backend.callTool('cypher', { query: 'RETURN 1 AS n LIMIT 1' });

    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    // When rows are returned, formatCypherAsMarkdown wraps them as { markdown, row_count }
    expect(result).toHaveProperty('markdown');
    expect(typeof (result as Record<string, unknown>).markdown).toBe('string');
    expect((result as Record<string, unknown>).row_count).toBe(1);
    assertResponseSize(result);
  });
});
