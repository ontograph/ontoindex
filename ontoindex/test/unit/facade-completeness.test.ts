/**
 * Facade Completeness Test
 *
 * Walks every (tool, action) pair declared in `ONTOINDEX_FACADE_TOOLS` and
 * verifies the dispatch layer routes it to a backend handler that exists.
 *
 * This test exists because the facade has three layers that must agree:
 *   1. tool-definitions.ts — declares the action enum
 *   2. dispatch.ts          — maps each action to a backend tool name
 *   3. local-backend.ts     — registers the backend tool in repoToolHandlers
 *
 * Drift between any two of these layers causes a tool that looks available
 * in `tools/list` but errors on call. Today's `audit/report` gap (backend
 * existed, dispatch said "not implemented yet") was the third such drift.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock the DB layer so backend dispatch reaches the handler without touching disk.
const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([
    {
      name: 'test-project',
      path: '/tmp/test-project',
      storagePath: '/tmp/.ontoindex/test-project',
      indexedAt: '2024-06-01T12:00:00Z',
      lastCommit: 'abc1234567890',
      stats: { files: 10, nodes: 50, edges: 100, communities: 3, processes: 5 },
    },
  ]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { dispatchFacade, type FacadeTool } from '../../src/mcp/facade/dispatch.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../src/mcp/facade/tool-definitions.js';

// Errors that prove a wiring gap, not a runtime/input failure:
//   - "Unknown action ..."     → dispatch.ts is missing a case for this enum value
//   - "Unknown tool: ..."       → local-backend.ts is missing the handler entry
//   - "not implemented yet"     → dispatch.ts has a placeholder throw
const WIRING_GAP_PATTERNS: RegExp[] = [
  /^Unknown action ".+" for tool ".+"$/,
  /^Unknown tool: .+$/,
  /not implemented yet/i,
];

function isWiringGap(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return WIRING_GAP_PATTERNS.some((re) => re.test(msg));
}

interface ActionPair {
  tool: FacadeTool;
  action: string;
}

function enumerateFacadeActions(): ActionPair[] {
  const pairs: ActionPair[] = [];
  for (const tool of ONTOINDEX_FACADE_TOOLS) {
    const actionProp = tool.inputSchema.properties.action;
    const enumValues = actionProp?.enum ?? [];
    for (const action of enumValues) {
      pairs.push({ tool: tool.name as FacadeTool, action });
    }
  }
  return pairs;
}

describe('facade completeness — every declared action must reach a backend handler', () => {
  const allPairs = enumerateFacadeActions();

  it('enumerates a non-trivial number of actions', () => {
    // Sanity: if this drops to zero, the test silently passes for everything.
    expect(allPairs.length).toBeGreaterThan(20);
  });

  for (const { tool, action } of allPairs) {
    it(`${tool}/${action} is wired end-to-end`, async () => {
      const backend = new LocalBackend();
      await backend.init();

      // Empty args — handlers may throw input-validation errors, that's fine.
      // We only fail when the error proves a layer is out of sync.
      let caught: unknown = null;
      try {
        await dispatchFacade(tool, action, {}, backend);
      } catch (err) {
        caught = err;
      }

      if (caught && isWiringGap(caught)) {
        const msg = caught instanceof Error ? caught.message : String(caught);
        throw new Error(
          `${tool}/${action}: wiring gap detected — "${msg}". ` +
            `Check facade/dispatch.ts (action mapping) and ` +
            `local-backend.ts repoToolHandlers (handler entry).`,
        );
      }
      // Any other error path (input validation, mocked DB returning empty, etc.)
      // proves the action successfully reached a handler. Pass.
    });
  }
});
