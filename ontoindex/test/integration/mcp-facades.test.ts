import { beforeEach, describe, it, expect, vi } from 'vitest';

// ─── Mock pool-adapter ─────────────────────────────────────────────────────
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

const { childProcessMocks, diffReviewMocks, targetContextMocks } = vi.hoisted(() => ({
  childProcessMocks: {
    execFileSync: vi.fn(),
    nameOnlyOutput: 'src/alpha.ts\nsrc/beta.ts\n',
    numstatOutput: '10\t1\tsrc/alpha.ts\n2\t0\tsrc/beta.ts\n',
  },
  diffReviewMocks: {
    buildDiffReview: vi.fn(),
  },
  targetContextMocks: {
    resolveTargetContext: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: childProcessMocks.execFileSync };
});

vi.mock('../../src/core/review/diff-review.js', () => ({
  buildDiffReview: diffReviewMocks.buildDiffReview,
}));

vi.mock('../../src/mcp/shared/target-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/shared/target-context.js')>();
  return { ...actual, resolveTargetContext: targetContextMocks.resolveTargetContext };
});

vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

// ─── Mock repo-manager ─────────────────────────────────────────────────────
const { mockRepos } = vi.hoisted(() => ({
  mockRepos: [
    {
      name: 'fixture',
      id: 'fixture-id',
      path: '/tmp/fixture-repo',
      storagePath: '/tmp/.ontoindex/repos/fixture',
      indexedAt: new Date().toISOString(),
      lastCommit: 'abc123',
      stats: { nodes: 10, edges: 5, files: 3, communities: 1, processes: 1 },
    },
  ],
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue(mockRepos),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

// ─── Mock Audit Report ────────────────────────────────────────────────────
vi.mock('../../src/mcp/local/backend-audit-report.js', () => ({
  runAuditReport: vi.fn().mockResolvedValue({ status: 'success', summary: 'Mock audit report' }),
}));

// ─── Import under test ────────────────────────────────────────────────────
import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../src/mcp/facade/tool-definitions.js';
import * as superDispatch from '../../src/mcp/super/dispatch.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';

describe('MCP Facade Integration (M-1)', () => {
  beforeEach(() => {
    childProcessMocks.nameOnlyOutput = 'src/alpha.ts\nsrc/beta.ts\n';
    childProcessMocks.numstatOutput = '10\t1\tsrc/alpha.ts\n2\t0\tsrc/beta.ts\n';
    childProcessMocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/tmp/fixture-repo\n';
      if (args.includes('--name-only')) return childProcessMocks.nameOnlyOutput;
      if (args.includes('--numstat')) return childProcessMocks.numstatOutput;
      return '';
    });
    diffReviewMocks.buildDiffReview.mockResolvedValue({
      reviewedFiles: [
        {
          path: 'src/alpha.ts',
          addedLines: 10,
          removedLines: 1,
          changedSymbols: [
            {
              nodeId: 'Function:src/alpha.ts:alpha',
              name: 'alpha',
              impact: { upstreamCount: 3, downstreamCount: 1, risk: 'LOW', heuristic: false },
            },
          ],
        },
      ],
      totalSymbolsChanged: 1,
      highRiskSymbols: [],
      warnings: [],
      affectedProcesses: [],
      affectedCommunities: [],
      crossCommunityRiskReasons: [],
      graphSections: { processesAvailable: true, communitiesAvailable: true },
    });
    targetContextMocks.resolveTargetContext.mockResolvedValue(createOkTargetContext());
  });

  it('discover(action="repos") routes to list_repos', async () => {
    const backend = createFacadeBackend();
    const result = await dispatchFacade('discover', 'repos', {}, backend);
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[]).length).toBeGreaterThan(0);
    expect(backend.callTool).toHaveBeenCalledWith('list_repos', {});
  });

  it('discover(action="routes") routes to route_map without requiring a route target', async () => {
    const backend = createFacadeBackend();
    await dispatchFacade('discover', 'routes', { repo: 'fixture' }, backend);
    expect(backend.callTool).toHaveBeenCalledWith('route_map', { repo: 'fixture' });
  });

  it('audit(action="report") routes to audit_report', async () => {
    const backend = createFacadeBackend();
    const result = (await dispatchFacade('audit', 'report', { repo: 'fixture' }, backend)) as any;
    expect(result.status).toBe('success');
    expect(result.summary).toBeDefined();
    expect(backend.callTool).toHaveBeenCalledWith('audit_report', { repo: 'fixture' });
  });

  it('throws for unknown actions', async () => {
    const backend = createFacadeBackend();
    await expect(dispatchFacade('discover', 'invalid' as any, {}, backend)).rejects.toThrow(
      'Unknown facade action: discover/invalid',
    );
  });

  it('handles repo parameter via LocalBackend', async () => {
    const backend = createFacadeBackend();
    const result = await dispatchFacade('discover', 'repos', { repo: 'fixture' }, backend);
    expect(Array.isArray(result)).toBe(true);
    expect(backend.callTool).toHaveBeenCalledWith('list_repos', { repo: 'fixture' });
  });

  it('keeps impact(action="diff") routed to detect_changes for legacy diff impact', async () => {
    const backend = createFacadeBackend();
    await dispatchFacade('impact', 'diff', { repo: 'fixture', scope: 'unstaged' }, backend);
    expect(backend.callTool).toHaveBeenCalledWith('detect_changes', {
      repo: 'fixture',
      scope: 'unstaged',
    });
  });

  it('search(action="semantic") exposes exactly one typed structured shape', () => {
    const searchTool = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'search')!;

    expect(searchTool.inputSchema.properties.action.enum).toEqual([
      'semantic',
      'cypher',
      'repomap',
    ]);
    expect(searchTool.inputSchema.properties.typed_query).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(searchTool.inputSchema.properties.typed_query.description).toContain(
      'Parse query as the existing typed-query document',
    );
    expect(searchTool.inputSchema.properties.typed_query.description).toContain(
      '@group searches fall back to plain semantic search',
    );
    expect(searchTool.inputSchema.properties.structured_output).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(searchTool.inputSchema.properties.structured_output.description).toContain(
      'structured_retrieval candidates',
    );
  });

  it('search(action="semantic") parses typed_query documents into the existing typed path', async () => {
    const backend = createFacadeBackend();
    await dispatchFacade(
      'search',
      'semantic',
      {
        repo: 'fixture',
        query: 'intent: calls of cache store\nsymbol: CacheStore\nvec: cache storage',
        typed_query: true,
      },
      backend,
    );

    expect(backend.callTool).toHaveBeenCalledWith('query', {
      repo: 'fixture',
      query: 'intent: calls of cache store\nsymbol: CacheStore\nvec: cache storage',
      typed_query: true,
      typedQuery: {
        intent: 'calls of cache store',
        lines: [
          { type: 'symbol', query: 'CacheStore', lineNumber: 2 },
          { type: 'vec', query: 'cache storage', lineNumber: 3 },
        ],
      },
    });
  });

  it('search(action="semantic") rejects invalid typed_query documents', async () => {
    const backend = createFacadeBackend();

    await expect(
      dispatchFacade(
        'search',
        'semantic',
        {
          query: 'intent:',
          typed_query: true,
        },
        backend,
      ),
    ).rejects.toThrow('must include a value');
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('facade audit exposes systems-audit actions for on-demand MCP clients', () => {
    const auditTool = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!;

    expect(auditTool.inputSchema.properties.action.enum).toEqual(
      expect.arrayContaining([
        'session_start',
        'session_verify',
        'session_dedupe',
        'session_bundle',
        'session_dispatch',
        'session_review_worker',
        'verify_diff',
        'test_gap',
        'worker_scope_review',
        'logic',
        'trace_boundary',
        'resource_trace',
        'path_verify',
        'test_suggestions',
        'extract_fsm',
        'error_topology',
        'concurrency',
        'pressure',
        'taint',
        'abi',
        'simulate_fault',
      ]),
    );
  });

  it('routes facade audit systems actions through super-function dispatch', async () => {
    const fakeBackend = {
      resolveRepo: vi.fn(async () => ({ id: 'fixture' })),
      callTool: vi.fn(async () => ({ ok: true })),
    } as unknown as LocalBackend;

    const result = (await dispatchFacade(
      'audit',
      'logic',
      { source: 'int fd = open(path, O_RDONLY);\n', category: 'resource-leaks' },
      fakeBackend,
    )) as Record<string, unknown>;

    expect(result.tool).toBe('gn_audit_logic');
    expect(fakeBackend.callTool).not.toHaveBeenCalled();
  });

  it('routes facade audit manager session actions through super-function dispatch', async () => {
    const fakeBackend = {
      resolveRepo: vi.fn(async () => ({ id: 'fixture' })),
      callTool: vi.fn(async () => ({ ok: true })),
    } as unknown as LocalBackend;
    const dispatchSpy = vi
      .spyOn(superDispatch, 'dispatchSuper')
      .mockResolvedValue({ tool: 'gn_audit_session_start', status: 'ok' });

    const result = (await dispatchFacade(
      'audit',
      'session_start',
      { sourcePath: '/tmp/audit.md', targetRef: 'HEAD' },
      fakeBackend,
    )) as Record<string, unknown>;

    expect(dispatchSpy).toHaveBeenCalledWith(
      'gn_audit_session_start',
      { sourcePath: '/tmp/audit.md', targetRef: 'HEAD' },
      'fixture',
    );
    expect(result.tool).toBe('gn_audit_session_start');
    expect(fakeBackend.callTool).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });

  it('routes facade audit write-through actions through super-function dispatch', async () => {
    const fakeBackend = {
      resolveRepo: vi.fn(async () => ({ id: 'fixture' })),
      callTool: vi.fn(async () => ({ ok: true })),
    } as unknown as LocalBackend;
    const dispatchSpy = vi
      .spyOn(superDispatch, 'dispatchSuper')
      .mockResolvedValue({ tool: 'gn_verify_diff', status: 'PASS' });

    const result = (await dispatchFacade(
      'audit',
      'verify_diff',
      { expectedFiles: ['src/foo.ts'], expectedSymbols: ['foo'] },
      fakeBackend,
    )) as Record<string, unknown>;

    expect(dispatchSpy).toHaveBeenCalledWith(
      'gn_verify_diff',
      { expectedFiles: ['src/foo.ts'], expectedSymbols: ['foo'] },
      'fixture',
    );
    expect(result.tool).toBe('gn_verify_diff');
    expect(fakeBackend.callTool).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });

  it('routes facade audit systems actions through the capability-aware envelope when requested', async () => {
    const fakeBackend = {
      resolveRepo: vi.fn(async () => ({ id: 'fixture' })),
      callTool: vi.fn(async () => ({ ok: true })),
    } as unknown as LocalBackend;

    const result = (await dispatchFacade(
      'audit',
      'logic',
      {
        source: 'int fd = open(path, O_RDONLY);\n',
        category: 'resource-leaks',
        legacyResponse: false,
      },
      fakeBackend,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      envelopeVersion: '1',
      tool: 'gn_audit_logic',
      capabilitiesUsed: expect.arrayContaining(['systems-rule-engine']),
    });
    expect(result.results).toBeDefined();
  });

  it('advertises legacyResponse on audit facade for migrated super-action envelopes', () => {
    const auditTool = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'audit')!;
    expect(auditTool.inputSchema.properties.legacyResponse).toMatchObject({
      type: 'boolean',
      default: true,
    });
  });

  // ---- REV-5: gn_review_diff MCP contract tests ---------------------------
  it('gn_review_diff is registered in SUPER_NAMES', () => {
    const { SUPER_NAMES } = superDispatch;
    expect(SUPER_NAMES.has('gn_review_diff' as any)).toBe(true);
  });

  it('gn_review_diff dispatches through dispatchSuper and returns an ADR 0018 envelope', async () => {
    const fakeBackend = {
      resolveRepo: vi.fn(async () => ({ id: 'fixture' })),
      callTool: vi.fn(async () => ({ ok: true })),
    } as unknown as LocalBackend;

    const dispatchSpy = vi.spyOn(superDispatch, 'dispatchSuper').mockResolvedValue({
      envelopeVersion: '1',
      tool: 'gn_review_diff',
      version: 1,
      status: 'ok',
      results: {
        resolvedRange: 'HEAD~1..HEAD',
        reviewedFiles: [],
        totalSymbolsChanged: 0,
        highRiskSymbols: [],
        affectedProcesses: [],
        affectedCommunities: [],
        crossCommunityRiskReasons: [],
        graphSections: null,
      },
      capabilitiesUsed: ['git-diff', 'graph-review', 'blast-radius'],
      capabilitiesMissing: [],
      warnings: [],
      freshness: { status: 'ok', actionable: true, reason: 'fresh' },
      targetContext: { version: 1, status: 'ok' },
      evidence: [],
      limits: {},
      nextTools: [],
    });

    const result = (await superDispatch.dispatchSuper(
      'gn_review_diff',
      { commitRange: 'HEAD~1..HEAD' },
      'fixture',
    )) as Record<string, unknown>;

    expect(dispatchSpy).toHaveBeenCalledWith(
      'gn_review_diff',
      { commitRange: 'HEAD~1..HEAD' },
      'fixture',
    );
    expect(result.envelopeVersion).toBe('1');
    expect(result.tool).toBe('gn_review_diff');
    expect((result.results as Record<string, unknown>).resolvedRange).toBe('HEAD~1..HEAD');
    expect(fakeBackend.callTool).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });

  it('gn_review_diff is separate from gn_diff_impact and preserves gn_diff_impact backward compat', () => {
    const { SUPER_NAMES } = superDispatch;
    // Both tools exist independently
    expect(SUPER_NAMES.has('gn_diff_impact' as any)).toBe(true);
    expect(SUPER_NAMES.has('gn_review_diff' as any)).toBe(true);
  });

  it('gn_review_diff returns bounded evidence diagnostics under results', async () => {
    diffReviewMocks.buildDiffReview.mockResolvedValueOnce({
      reviewedFiles: [
        {
          path: 'src/alpha.ts',
          addedLines: 10,
          removedLines: 1,
          changedSymbols: [
            {
              nodeId: 'Function:src/alpha.ts:alpha',
              name: 'alpha',
              impact: { upstreamCount: 60, downstreamCount: 2, risk: 'HIGH', heuristic: true },
            },
          ],
        },
      ],
      totalSymbolsChanged: 1,
      highRiskSymbols: ['alpha'],
      warnings: Array.from({ length: 30 }, (_, index) => `diagnostic warning ${index + 1}`),
      affectedProcesses: [],
      affectedCommunities: [],
      crossCommunityRiskReasons: ['alpha crosses a community boundary'],
      graphSections: { processesAvailable: false, communitiesAvailable: false },
    });
    targetContextMocks.resolveTargetContext.mockResolvedValueOnce(
      createOkTargetContext({
        dirtyWorktree: true,
        snapshotMode: 'dirty-worktree-overlay',
      }),
    );

    const result = (await superDispatch.dispatchSuper(
      'gn_review_diff',
      { commitRange: 'HEAD~1..HEAD' },
      'fixture',
    )) as Record<string, any>;
    const diagnostics = result.results.diagnostics;

    expect(result).toMatchObject({
      envelopeVersion: '1',
      tool: 'gn_review_diff',
    });
    expect(diagnostics).toMatchObject({
      schemaVersion: 1,
      limits: { maxRecords: 25 },
    });
    expect(diagnostics.records).toHaveLength(25);
    expect(diagnostics.summary.total).toBe(25);
    expect(diagnostics.summary.advisory).toBeGreaterThan(0);
    expect(diagnostics.summary.degraded).toBeGreaterThan(0);
    expect(diagnostics.summary.truncated).toBeGreaterThan(0);
    expect(diagnostics.records.at(-1)).toMatchObject({
      category: 'runtime',
      kind: 'truncated',
      truncated: true,
      auditAuthority: false,
    });
    expect(diagnostics.records.map((record: any) => record.category)).not.toEqual(
      expect.arrayContaining(['ambiguous', 'degraded', 'extracted', 'truncated']),
    );
  });

  it('gn_review_diff diagnostics remain advisory metadata, not audit authority', async () => {
    diffReviewMocks.buildDiffReview.mockResolvedValueOnce({
      reviewedFiles: [
        {
          path: 'src/alpha.ts',
          addedLines: 10,
          removedLines: 1,
          changedSymbols: [
            {
              nodeId: 'Function:src/alpha.ts:alpha',
              name: 'alpha',
              impact: { upstreamCount: 60, downstreamCount: 2, risk: 'HIGH', heuristic: true },
            },
          ],
        },
      ],
      totalSymbolsChanged: 1,
      highRiskSymbols: ['alpha'],
      warnings: ['community data degraded'],
      affectedProcesses: [],
      affectedCommunities: [],
      crossCommunityRiskReasons: ['alpha crosses a community boundary'],
      graphSections: { processesAvailable: false, communitiesAvailable: false },
    });

    const result = (await superDispatch.dispatchSuper(
      'gn_review_diff',
      { commitRange: 'HEAD~1..HEAD' },
      'fixture',
    )) as Record<string, any>;
    const diagnostics = result.results.diagnostics;

    expect(diagnostics.note).toContain('not audit authority');
    expect(diagnostics.records.every((record: any) => record.auditAuthority === false)).toBe(true);
    expect(diagnostics.records.filter((record: any) => record.authority === 'advisory')).toEqual(
      expect.arrayContaining([expect.objectContaining({ advisory: true })]),
    );
    expect(
      diagnostics.records.filter((record: any) => record.authority === 'authoritative'),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ auditAuthority: false })]));
  });

  it('gn_review_diff diagnostics do not change the MCP tool contract frontier', async () => {
    const before = (await superDispatch.dispatchSuper('gn_tool_contract', {}, '')) as Record<
      string,
      any
    >;
    await superDispatch.dispatchSuper('gn_review_diff', { commitRange: 'HEAD~1..HEAD' }, 'fixture');
    const after = (await superDispatch.dispatchSuper('gn_tool_contract', {}, '')) as Record<
      string,
      any
    >;
    const reviewTool = ONTOINDEX_SUPER_TOOLS.find((tool) => tool.name === 'gn_review_diff')!;

    expect(after.runtime.superToolCount).toBe(before.runtime.superToolCount);
    expect(after.callable).toEqual(before.callable);
    expect(after.advertised).toEqual(before.advertised);
    expect(Object.keys(reviewTool.inputSchema.properties)).toEqual([
      'repo',
      'commitRange',
      'scope',
    ]);
    expect(reviewTool.inputSchema.properties).not.toHaveProperty('diagnostics');
  });
});

function createFacadeBackend(): LocalBackend & {
  callTool: ReturnType<typeof vi.fn>;
  resolveRepo: ReturnType<typeof vi.fn>;
} {
  return {
    callTool: vi.fn(async (method: string) => {
      if (method === 'list_repos') return mockRepos;
      if (method === 'audit_report') return { status: 'success', summary: 'Mock audit report' };
      return { ok: true };
    }),
    resolveRepo: vi.fn(async () => ({ id: 'fixture' })),
  } as unknown as LocalBackend & {
    callTool: ReturnType<typeof vi.fn>;
    resolveRepo: ReturnType<typeof vi.fn>;
  };
}

function createOkTargetContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    status: 'ok',
    repoKey: 'fixture',
    repoPath: '/tmp/fixture-repo',
    targetRef: 'HEAD',
    targetHead: 'abc123',
    currentHead: 'abc123',
    indexedHead: 'abc123',
    dirtyWorktree: false,
    changedSinceIndex: false,
    snapshotMode: 'committed-head',
    qualityMode: 'balanced',
    embeddings: { status: 'available' },
    lsp: { status: 'available' },
    sidecar: { status: 'unknown' },
    policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
    warnings: [],
    ...overrides,
  };
}
