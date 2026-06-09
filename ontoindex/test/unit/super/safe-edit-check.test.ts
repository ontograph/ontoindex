/**
 * Unit tests for gn_safe_edit_check super-function (Phase 2 W2a).
 *
 * All external primitives are mocked so tests run without a live DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import under test.
// ---------------------------------------------------------------------------

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
  executeQuery: vi.fn(),
}));

vi.mock('../../../src/core/lsp/bridge.js', () => ({
  lspBridge: {
    getClient: vi.fn(),
    validateRename: vi.fn(),
  },
}));

vi.mock('../../../src/mcp/super/_helpers/test-coverage.js', () => ({
  findTestFiles: vi.fn(),
}));

vi.mock('../../../src/mcp/super/docs-evidence.js', () => ({
  collectAdvisoryDocsEvidence: vi.fn(),
}));

vi.mock('../../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { executeParameterized, executeQuery } from '../../../src/core/lbug/pool-adapter.js';
import { lspBridge } from '../../../src/core/lsp/bridge.js';
import { findTestFiles } from '../../../src/mcp/super/_helpers/test-coverage.js';
import { collectAdvisoryDocsEvidence } from '../../../src/mcp/super/docs-evidence.js';
import { resolveTargetContext } from '../../../src/mcp/shared/target-context.js';
import { resolveSymbolCandidates } from '../../../src/mcp/local/backend-symbol-resolution.js';
import { gnSafeEditCheck } from '../../../src/mcp/super/safe-edit-check.js';

const mockExecuteParameterized = executeParameterized as unknown as ReturnType<typeof vi.fn>;
const mockExecuteQuery = executeQuery as unknown as ReturnType<typeof vi.fn>;
const mockGetClient = lspBridge.getClient as unknown as ReturnType<typeof vi.fn>;
const mockValidateRename = lspBridge.validateRename as unknown as ReturnType<typeof vi.fn>;
const mockFindTestFiles = findTestFiles as unknown as ReturnType<typeof vi.fn>;
const mockCollectDocsEvidence = collectAdvisoryDocsEvidence as unknown as ReturnType<typeof vi.fn>;
const mockResolveTargetContext = resolveTargetContext as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';
const NODE_ID = 'Function:src/auth/token.ts:parseToken';

function resolvedRow(
  nodeId = NODE_ID,
  name = 'parseToken',
  filePath = 'src/auth/token.ts',
  kind = 'Function',
): any {
  return { nodeId, name, filePath, kind, callerCount: 3 };
}

function upstreamImpactRows(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    sourceId: NODE_ID,
    id: `Function:src/caller${i}.ts:caller${i}`,
    name: `caller${i}`,
    type: 'Function',
    filePath: `src/caller${i}.ts`,
    relType: 'CALLS',
    confidence: 0.95,
  }));
}

function downstreamImpactRows(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    sourceId: NODE_ID,
    id: `Function:src/callee${i}.ts:fn`,
    name: `callee${i}`,
    type: 'Function',
    filePath: `src/callee${i}.ts`,
    relType: 'CALLS',
    confidence: 0.95,
  }));
}

/** Set up standard mock returns for a single gnSafeEditCheck call.
 *
 * executeParameterized call order within gnSafeEditCheck:
 *  1. resolveSymbol (fuzzy lookup — name match) — sequential before graph probes
 *  2+. non-kernel probes and optional class-seed expansion
 *
 * Kernel-backed impact uses executeQuery; executeParameterized is matched by
 * query shape so bounded concurrency and class seed expansion stay deterministic.
 *
 * findTestFiles is mocked separately (uses its own vi.mock).
 * lspBridge.getClient is mocked separately.
 */
function setupMocks({
  resolveRows = [resolvedRow()],
  upstreamN = 0,
  downstreamN = 0,
  upstreamRows = upstreamImpactRows(upstreamN),
  downstreamRows = downstreamImpactRows(downstreamN),
  classConstructorRows = [] as any[],
  classFileRows = [] as any[],
  processCount = 0,
  clusterCount = 0,
  coChangeSiblings = [] as string[],
  lastDate = '2026-04-01',
  isExported = false,
  testCoverage = {
    coveringTests: ['test/unit/auth.test.ts'],
    likelihoodOfCoverage: 'HIGH' as const,
  },
  lspClientAvailable = false,
  lspRenameResult,
}: {
  resolveRows?: any[];
  upstreamN?: number;
  downstreamN?: number;
  upstreamRows?: any[];
  downstreamRows?: any[];
  classConstructorRows?: any[];
  classFileRows?: any[];
  processCount?: number;
  clusterCount?: number;
  coChangeSiblings?: string[];
  lastDate?: string;
  isExported?: boolean;
  testCoverage?: {
    coveringTests: string[];
    likelihoodOfCoverage: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  };
  lspClientAvailable?: boolean;
  lspRenameResult?: { supported: boolean; placeholder?: string };
} = {}): void {
  mockExecuteParameterized.mockImplementation(async (_repoId: string, query: string) => {
    if (query.includes('WHERE s.id = $id') || query.includes('WHERE s.name = $name')) {
      return resolveRows;
    }
    if (query.includes("hm.type = 'HAS_METHOD'")) return classConstructorRows;
    if (query.includes("rel.type = 'DEFINES'")) return classFileRows;
    if (query.includes("r.type = 'PARTICIPATES_IN'")) return [{ processCount }];
    if (query.includes("r.type = 'MEMBER_OF'")) return [{ clusterCount }];
    if (query.includes('CO_CHANGED_WITH') && query.includes('other.filePath AS otherPath')) {
      return coChangeSiblings.map((p) => ({ otherPath: p, conf: 0.8 }));
    }
    if (query.includes('r.lastDate AS lastDate')) return [{ lastDate }];
    if (query.includes('RETURN s.isExported AS isExported')) return [{ isExported }];
    return [];
  });

  mockExecuteQuery.mockImplementation(async (_repoId: string, query: string) => {
    if (query.includes('MATCH (caller)-[r:CodeRelation]->(n)')) return upstreamRows;
    if (query.includes('MATCH (n)-[r:CodeRelation]->(callee)')) return downstreamRows;
    return [];
  });

  mockFindTestFiles.mockResolvedValue(testCoverage);
  mockGetClient.mockResolvedValue(
    lspClientAvailable ? { findReferences: vi.fn().mockResolvedValue([]) } : null,
  );
  mockValidateRename.mockResolvedValue(lspRenameResult ?? { supported: false });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gnSafeEditCheck', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default env state: ONTOINDEX_LSP_REFERENCES should not be set before each test.
    delete process.env['ONTOINDEX_LSP_REFERENCES'];
    mockCollectDocsEvidence.mockResolvedValue({
      enabled: true,
      sidecar: { status: 'missing', staleReasons: [], degradedReasons: {} },
      freshness: { statusCounts: {}, stale: false, reasons: [] },
      docEvidence: [],
      relatedDocs: [],
      limits: { maxEvidence: 12, maxRelatedDocs: 5, totalEvidence: 0, truncated: false },
    });
    mockResolveTargetContext.mockResolvedValue({
      version: 1,
      status: 'ok',
      repoKey: REPO_ID,
      repoPath: '/repo',
      branch: 'main',
      targetRef: 'HEAD',
      targetHead: 'abc123',
      currentHead: 'abc123',
      indexedHead: 'abc123',
      dirtyWorktree: false,
      changedSinceIndex: false,
      snapshotMode: 'committed-head',
      qualityMode: 'balanced',
      embeddings: { status: 'available', count: 5 },
      lsp: { status: 'unavailable', reason: 'no-lsp-server-on-path' },
      sidecar: { status: 'unknown', reason: 'not-probed' },
      policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
      warnings: [],
    });
  });

  // -------------------------------------------------------------------------
  // 1. SAFE verdict: low-impact, well-tested, recently active
  // -------------------------------------------------------------------------
  it('returns SAFE verdict for low-impact + tested + recent symbol', async () => {
    setupMocks({
      upstreamN: 2,
      processCount: 1,
      isExported: false,
      testCoverage: {
        coveringTests: [
          'test/unit/auth.test.ts',
          'test/integration/auth.test.ts',
          'test/e2e/auth.spec.ts',
        ],
        likelihoodOfCoverage: 'HIGH',
      },
      lastDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

    expect(report.version).toBe(1);
    expect(report.verdict).toBe('SAFE');
    expect(report.blastRadius.upstreamCount).toBe(2);
    expect(report.rawCounts?.upstream.direct).toBe(2);
    expect(report.rawCounts?.upstream.traversalDepth).toBe(1);
    expect(report.rawCounts?.upstream.relationshipSet).toEqual(['CALLS', 'REFERENCES']);
    expect(report.rawCounts?.upstream.countScope).toBe('unique-direct-nodes');
    expect(report.rawCounts?.upstream.graphSnapshot.repoId).toBe(REPO_ID);
    expect(report.rawCounts?.downstream.relationshipSet).toEqual([
      'CALLS',
      'REFERENCES',
      'IMPORTS',
    ]);
    expect(report.testCoverage.likelihoodOfCoverage).toBe('HIGH');
    expect(report.symbol.name).toBe('parseToken');
  });

  it('keeps risk verdict unchanged when advisory docs evidence is enabled', async () => {
    setupMocks({
      upstreamN: 2,
      processCount: 1,
      isExported: false,
      testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
      lastDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', docsEvidence: true });

    expect(report.verdict).toBe('SAFE');
    expect(report.reasoning).toBe('Low blast radius, well-tested, recently active.');
    expect(report.docEvidence).toMatchObject({ enabled: true, docEvidence: [] });
    expect(mockCollectDocsEvidence).toHaveBeenCalledWith(REPO_ID, [
      { nodeId: NODE_ID, name: 'parseToken', filePath: 'src/auth/token.ts' },
    ]);
  });

  // -------------------------------------------------------------------------
  // 2. CAUTION verdict: medium-impact OR low test coverage
  // -------------------------------------------------------------------------
  it('returns CAUTION verdict for medium-impact (10 callers)', async () => {
    setupMocks({
      upstreamN: 15,
      processCount: 2,
      isExported: false,
      testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'MEDIUM' },
      lastDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

    expect(report.verdict).toBe('CAUTION');
    expect(report.blastRadius.upstreamCount).toBe(15);
  });

  it('returns CAUTION verdict when test coverage is NONE', async () => {
    setupMocks({
      upstreamN: 3,
      processCount: 1,
      isExported: false,
      testCoverage: { coveringTests: [], likelihoodOfCoverage: 'NONE' },
      lastDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

    expect(report.verdict).toBe('CAUTION');
    expect(report.testCoverage.likelihoodOfCoverage).toBe('NONE');
  });

  // -------------------------------------------------------------------------
  // 3. DANGEROUS verdict: high transitive impact (processCount > 5)
  // -------------------------------------------------------------------------
  it('returns DANGEROUS verdict for high transitive impact (processCount > 5)', async () => {
    setupMocks({
      upstreamN: 8,
      processCount: 7, // > 5 → DANGEROUS
      isExported: false,
      testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
      lastDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

    expect(report.verdict).toBe('DANGEROUS');
    expect(report.blastRadius.transitiveImpact.processCount).toBe(7);
  });

  it('returns DANGEROUS verdict for exported public API symbol', async () => {
    setupMocks({
      upstreamN: 50,
      processCount: 2,
      isExported: true, // exported → DANGEROUS (upstream < 100 so not BLOCKED)
      testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
      lastDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

    expect(report.verdict).toBe('DANGEROUS');
  });

  // -------------------------------------------------------------------------
  // 4. BLOCKED verdict: HIGH risk (upstream > 100 AND exported) without force
  // -------------------------------------------------------------------------
  it('returns BLOCKED for HIGH risk without force', async () => {
    setupMocks({
      upstreamN: 110, // > 100
      processCount: 2,
      isExported: true, // AND exported → BLOCKED
      testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
      lastDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

    expect(report.verdict).toBe('BLOCKED');
    expect(report.reasoning).toMatch(/force:true/);
  });

  // -------------------------------------------------------------------------
  // 5. force:true overrides BLOCKED to DANGEROUS
  // -------------------------------------------------------------------------
  it('force:true overrides BLOCKED to DANGEROUS', async () => {
    setupMocks({
      upstreamN: 110, // > 100
      processCount: 2,
      isExported: true, // AND exported → would be BLOCKED without force
      testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
      lastDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', force: true });

    // With force, BLOCKED is skipped; upstream > 100 OR isExported → DANGEROUS
    expect(report.verdict).toBe('DANGEROUS');
  });

  // -------------------------------------------------------------------------
  // 6. Env var ONTOINDEX_LSP_REFERENCES restored after success + after error
  // -------------------------------------------------------------------------
  it('restores ONTOINDEX_LSP_REFERENCES env var after successful run', async () => {
    const originalValue = process.env['ONTOINDEX_LSP_REFERENCES'];
    setupMocks();

    await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

    expect(process.env['ONTOINDEX_LSP_REFERENCES']).toBe(originalValue);
  });

  it('does not set ONTOINDEX_LSP_REFERENCES while probing LSP refs', async () => {
    setupMocks();
    mockGetClient.mockImplementation(async () => {
      expect(process.env['ONTOINDEX_LSP_REFERENCES']).toBeUndefined();
      return null;
    });

    await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

    expect(process.env['ONTOINDEX_LSP_REFERENCES']).toBeUndefined();
  });

  it('returns a capability-aware envelope when legacyResponse is false', async () => {
    setupMocks({
      upstreamN: 4,
      processCount: 1,
      testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
      lastDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    mockGetClient.mockResolvedValue(null);

    const report = await gnSafeEditCheck(REPO_ID, {
      symbol: 'parseToken',
      legacyResponse: false,
    });

    expect(report).toMatchObject({
      envelopeVersion: '1',
      tool: 'gn_safe_edit_check',
      status: 'degraded',
      capabilitiesUsed: expect.arrayContaining(['symbol-graph', 'impact-kernel']),
      capabilitiesMissing: expect.arrayContaining(['typescript-lsp']),
      warnings: expect.arrayContaining([
        expect.stringContaining('type-aware claims were downgraded'),
      ]),
      nextTools: expect.arrayContaining(['gn_safe_refactor', 'gn_pre_commit_audit']),
    });
    expect((report.results as Record<string, unknown>).verdict).toBe('SAFE');
  });

  it('restores ONTOINDEX_LSP_REFERENCES env var even when executeParameterized throws', async () => {
    const originalValue = process.env['ONTOINDEX_LSP_REFERENCES'];
    // Make resolveSymbol throw so the try block exits early
    mockExecuteParameterized.mockRejectedValue(new Error('DB unavailable'));
    mockFindTestFiles.mockResolvedValue({ coveringTests: [], likelihoodOfCoverage: 'NONE' });
    mockGetClient.mockResolvedValue(null);

    // Should not throw (errors in resolveSymbol cause symbol-not-found path)
    // But if it does throw, env should still be restored.
    try {
      await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });
    } catch {
      // ignore
    }

    expect(process.env['ONTOINDEX_LSP_REFERENCES']).toBe(originalValue);
  });

  // -------------------------------------------------------------------------
  // 7. findTestFiles helper integration via mock: covers HIGH/MEDIUM/LOW/NONE
  // -------------------------------------------------------------------------
  it('uses findTestFiles helper and reflects coverage in report', async () => {
    // HIGH coverage
    setupMocks({
      upstreamN: 1,
      testCoverage: {
        coveringTests: ['test/a.test.ts', 'test/b.test.ts', 'test/c.spec.ts'],
        likelihoodOfCoverage: 'HIGH',
      },
    });
    let report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });
    expect(report.testCoverage.likelihoodOfCoverage).toBe('HIGH');
    expect(report.testCoverage.coveringTests).toHaveLength(3);

    vi.resetAllMocks();

    // MEDIUM coverage
    setupMocks({
      upstreamN: 1,
      testCoverage: {
        coveringTests: ['test/a.test.ts'],
        likelihoodOfCoverage: 'MEDIUM',
      },
    });
    report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });
    expect(report.testCoverage.likelihoodOfCoverage).toBe('MEDIUM');

    vi.resetAllMocks();

    // LOW coverage
    setupMocks({
      upstreamN: 1,
      testCoverage: {
        coveringTests: ['test/co-changed.test.ts'],
        likelihoodOfCoverage: 'LOW',
      },
    });
    report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });
    expect(report.testCoverage.likelihoodOfCoverage).toBe('LOW');

    vi.resetAllMocks();

    // NONE coverage → forces CAUTION
    setupMocks({
      upstreamN: 1,
      testCoverage: {
        coveringTests: [],
        likelihoodOfCoverage: 'NONE',
      },
    });
    report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });
    expect(report.testCoverage.likelihoodOfCoverage).toBe('NONE');
    expect(report.verdict).toBe('CAUTION'); // NONE coverage → CAUTION
  });

  it('prefers real function definitions over forward declarations during fuzzy resolution', async () => {
    setupMocks({
      resolveRows: [
        {
          nodeId: 'Function:include/auth/token.h:parseToken',
          name: 'parseToken',
          filePath: 'include/auth/token.h',
          kind: 'Function',
          callerCount: 50,
          content: 'Token parseToken(const char* raw);',
          startLine: 4,
          endLine: 4,
        },
        {
          nodeId: NODE_ID,
          name: 'parseToken',
          filePath: 'src/auth/token.ts',
          kind: 'Function',
          callerCount: 1,
          content: 'export function parseToken(raw: string): Token {\n  return decode(raw);\n}',
          startLine: 12,
          endLine: 14,
        },
      ],
      upstreamN: 2,
      processCount: 1,
      testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

    expect(report.symbol.nodeId).toBe(NODE_ID);
    expect(report.symbol.filePath).toBe('src/auth/token.ts');
  });

  it('prefers real class definitions over forward declarations during fuzzy resolution', async () => {
    setupMocks({
      resolveRows: [
        {
          nodeId: 'Class:include/DocumentBroker.h:DocumentBroker',
          name: 'DocumentBroker',
          filePath: 'include/DocumentBroker.h',
          kind: 'Class',
          callerCount: 20,
          content: 'class DocumentBroker;',
          startLine: 3,
          endLine: 3,
        },
        {
          nodeId: 'Class:src/DocumentBroker.cpp:DocumentBroker',
          name: 'DocumentBroker',
          filePath: 'src/DocumentBroker.cpp',
          kind: 'Class',
          callerCount: 0,
          content: 'class DocumentBroker {\npublic:\n  void run();\n};',
          startLine: 8,
          endLine: 12,
        },
      ],
      upstreamN: 2,
      processCount: 1,
      testCoverage: {
        coveringTests: ['test/unit/document-broker.test.ts'],
        likelihoodOfCoverage: 'HIGH',
      },
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'DocumentBroker' });

    expect(report.symbol.nodeId).toBe('Class:src/DocumentBroker.cpp:DocumentBroker');
    expect(report.symbol.filePath).toBe('src/DocumentBroker.cpp');
  });

  it('uses kernel direct counts for a DocumentBroker-style class without duplicate seed contradictions', async () => {
    const classId = 'Class:src/DocumentBroker.cpp:DocumentBroker';
    const constructorId = 'Constructor:src/DocumentBroker.cpp:DocumentBroker';
    const fileId = 'File:src/DocumentBroker.cpp';
    setupMocks({
      resolveRows: [
        {
          nodeId: classId,
          name: 'DocumentBroker',
          filePath: 'src/DocumentBroker.cpp',
          kind: 'Class',
          callerCount: 4,
          content: 'class DocumentBroker {\\npublic:\\n  DocumentBroker();\\n};',
          startLine: 8,
          endLine: 12,
        },
      ],
      classConstructorRows: [
        {
          id: constructorId,
          name: 'DocumentBroker',
          type: 'Constructor',
          filePath: 'src/DocumentBroker.cpp',
        },
      ],
      classFileRows: [
        {
          id: fileId,
          name: 'DocumentBroker.cpp',
          type: 'File',
          filePath: 'src/DocumentBroker.cpp',
        },
      ],
      upstreamRows: [
        {
          sourceId: classId,
          id: 'Function:src/session.cpp:createBroker',
          name: 'createBroker',
          type: 'Function',
          filePath: 'src/session.cpp',
          relType: 'REFERENCES',
          confidence: 0.9,
        },
        {
          sourceId: constructorId,
          id: 'Function:src/session.cpp:createBroker',
          name: 'createBroker',
          type: 'Function',
          filePath: 'src/session.cpp',
          relType: 'CALLS',
          confidence: 0.95,
        },
        {
          sourceId: fileId,
          id: 'Function:src/main.cpp:bootstrap',
          name: 'bootstrap',
          type: 'Function',
          filePath: 'src/main.cpp',
          relType: 'REFERENCES',
          confidence: 0.95,
        },
      ],
      downstreamRows: [],
      processCount: 1,
      testCoverage: {
        coveringTests: ['test/unit/document-broker.test.ts'],
        likelihoodOfCoverage: 'HIGH',
      },
      lastDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'DocumentBroker' });

    expect(report.blastRadius.upstreamCount).toBe(2);
    expect(report.rawCounts?.upstream.direct).toBe(2);
    expect(report.rawCounts?.upstream.total).toBe(2);
    expect(report.rawCounts?.upstream.seedUids).toEqual([classId, constructorId, fileId]);
    expect(report.rawCounts?.upstream.filters.classSeedExpansion).toBe(true);
    expect(report.rawCounts?.downstream.direct).toBe(0);
    expect(report.reasoning).not.toContain('3 upstream callers');
  });

  it('keeps canonical node-id lookup exact when the target is a declaration', async () => {
    const declarationId = 'Function:include/auth/token.h:parseToken';
    setupMocks({
      resolveRows: [
        {
          nodeId: declarationId,
          name: 'parseToken',
          filePath: 'include/auth/token.h',
          kind: 'Function',
          callerCount: 0,
          content: 'Token parseToken(const char* raw);',
          startLine: 4,
          endLine: 4,
        },
      ],
    });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: declarationId });

    expect(report.symbol.nodeId).toBe(declarationId);
    expect(mockExecuteParameterized.mock.calls[0]?.[1]).toContain('WHERE s.id = $id');
    expect(mockExecuteParameterized.mock.calls[0]?.[2]).toEqual({ id: declarationId });
  });

  it('keeps declaration candidates as lower-ranked fallbacks in shared resolver output', async () => {
    mockExecuteParameterized.mockResolvedValueOnce([
      {
        id: 'Function:include/auth/token.h:parseToken',
        name: 'parseToken',
        type: 'Function',
        filePath: 'include/auth/token.h',
        startLine: 4,
        endLine: 4,
        content: 'Token parseToken(const char* raw);',
      },
      {
        id: NODE_ID,
        name: 'parseToken',
        type: 'Function',
        filePath: 'src/auth/token.ts',
        startLine: 12,
        endLine: 14,
        content: 'export function parseToken(raw: string): Token {\n  return decode(raw);\n}',
      },
    ]);

    const outcome = await resolveSymbolCandidates({ id: REPO_ID }, { name: 'parseToken' }, {});

    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind !== 'ambiguous') return;
    expect(outcome.candidates.map((candidate) => candidate.id)).toEqual([
      NODE_ID,
      'Function:include/auth/token.h:parseToken',
    ]);
    expect(outcome.candidates[0].score).toBeGreaterThan(outcome.candidates[1].score);
  });

  // -------------------------------------------------------------------------
  // Additional: symbol not found returns safe report with warning
  // -------------------------------------------------------------------------
  it('returns SAFE with warning when symbol is not found in index', async () => {
    // resolveSymbol returns empty
    mockExecuteParameterized.mockResolvedValueOnce([]); // canonical lookup → 0 rows
    mockFindTestFiles.mockResolvedValue({ coveringTests: [], likelihoodOfCoverage: 'NONE' });
    mockGetClient.mockResolvedValue(null);

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'unknownSymbol' });

    expect(report.verdict).toBe('SAFE');
    expect(report.warnings).toContain('symbol not found in index');
    expect(report.symbol.nodeId).toBe('');
    expect(report.rawCounts).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Additional: intent influences recommendedTool
  // -------------------------------------------------------------------------
  it('recommendedTool is rename_symbol when intent is rename', async () => {
    setupMocks({ upstreamN: 3 });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

    expect(report.recommendedTool).toBe('rename_symbol');
    expect(report.recommendedToolVisibility).toBe('backend-fallback');
  });

  it('recommendedTool is manual when intent is delete', async () => {
    setupMocks({ upstreamN: 3 });

    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'delete' });

    expect(report.recommendedTool).toBe('manual');
    expect(report.recommendedToolVisibility).toBe('manual');
  });

  // -------------------------------------------------------------------------
  // REV4: tool visibility validation tests
  // -------------------------------------------------------------------------

  describe('REV4 — tool visibility and recommendation validation', () => {
    it('rename intent: recommendedTool is rename_symbol (backend-fallback), suggestedNext carries rename_symbol with backend-fallback visibility', async () => {
      setupMocks({ upstreamN: 3 });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

      expect(report.recommendedTool).toBe('rename_symbol');
      expect(report.recommendedToolVisibility).toBe('backend-fallback');
      const renameSuggestion = report.suggestedNext.find((s) => s.tool === 'rename_symbol');
      expect(renameSuggestion).toBeDefined();
      expect(renameSuggestion?.visibility).toBe('backend-fallback');
      // gn_rename must NOT appear — it is not a registered public tool
      expect(report.suggestedNext.find((s) => s.tool === 'gn_rename')).toBeUndefined();
    });

    it('modify-body intent: recommendedTool is update_symbol_body (backend-fallback)', async () => {
      setupMocks({ upstreamN: 2 });

      const report = await gnSafeEditCheck(REPO_ID, {
        symbol: 'parseToken',
        intent: 'modify-body',
      });

      expect(report.recommendedTool).toBe('update_symbol_body');
      expect(report.recommendedToolVisibility).toBe('backend-fallback');
    });

    it('delete intent: recommendedTool is manual, suggestedNext includes gn_can_delete as public', async () => {
      setupMocks({ upstreamN: 2 });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'delete' });

      expect(report.recommendedTool).toBe('manual');
      expect(report.recommendedToolVisibility).toBe('manual');
      const canDelete = report.suggestedNext.find((s) => s.tool === 'gn_can_delete');
      expect(canDelete).toBeDefined();
      expect(canDelete?.visibility).toBe('public');
    });

    it('BLOCKED verdict: suggestedNext includes gn_safe_edit_check as public', async () => {
      setupMocks({
        upstreamN: 110,
        isExported: true,
        testCoverage: { coveringTests: [], likelihoodOfCoverage: 'HIGH' },
      });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

      expect(report.verdict).toBe('BLOCKED');
      const suggestion = report.suggestedNext[0];
      expect(suggestion?.tool).toBe('gn_safe_edit_check');
      expect(suggestion?.visibility).toBe('public');
    });

    it('CAUTION verdict: suggestedNext includes gn_find_related as public', async () => {
      setupMocks({
        upstreamN: 15,
        isExported: false,
        testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'MEDIUM' },
        lastDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

      expect(report.verdict).toBe('CAUTION');
      const related = report.suggestedNext.find((s) => s.tool === 'gn_find_related');
      expect(related).toBeDefined();
      expect(related?.visibility).toBe('public');
    });

    it('SAFE verdict: suggestedNext includes gn_can_delete as public', async () => {
      setupMocks({
        upstreamN: 1,
        isExported: false,
        testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
        lastDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

      expect(report.verdict).toBe('SAFE');
      const canDelete = report.suggestedNext.find((s) => s.tool === 'gn_can_delete');
      expect(canDelete).toBeDefined();
      expect(canDelete?.visibility).toBe('public');
    });

    it('all suggestedNext tools have a defined visibility field', async () => {
      setupMocks({
        upstreamN: 5,
        isExported: false,
        testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
        lastDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const report = await gnSafeEditCheck(REPO_ID, {
        symbol: 'parseToken',
        intent: 'rename',
      });

      for (const suggestion of report.suggestedNext) {
        expect(suggestion.visibility).toBeDefined();
        expect(['public', 'facade', 'backend-fallback', 'unknown']).toContain(
          suggestion.visibility,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // D1: requiredReads and recommendedAction fields
  // -------------------------------------------------------------------------

  describe('D1 — requiredReads and recommendedAction', () => {
    it('rename intent: requiredReads includes symbol nodeId as first entry', async () => {
      setupMocks({ upstreamN: 3 });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

      expect(report.requiredReads).toBeDefined();
      expect(report.requiredReads![0].symbol).toBe(NODE_ID);
      expect(report.requiredReads![0].reason).toMatch(/name|signature/i);
    });

    it('rename intent: requiredReads includes upstream caller files (up to 5)', async () => {
      setupMocks({
        upstreamRows: [
          {
            sourceId: NODE_ID,
            id: 'Function:src/a.ts:fn',
            name: 'fn',
            type: 'Function',
            filePath: 'src/a.ts',
            relType: 'CALLS',
            confidence: 0.9,
          },
          {
            sourceId: NODE_ID,
            id: 'Function:src/b.ts:fn',
            name: 'fn',
            type: 'Function',
            filePath: 'src/b.ts',
            relType: 'CALLS',
            confidence: 0.9,
          },
          {
            sourceId: NODE_ID,
            id: 'Function:src/c.ts:fn',
            name: 'fn',
            type: 'Function',
            filePath: 'src/c.ts',
            relType: 'CALLS',
            confidence: 0.9,
          },
        ],
      });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

      const callerReads = report.requiredReads!.filter((r) => r.reason.includes('Caller'));
      expect(callerReads.length).toBe(3);
      expect(callerReads.map((r) => r.symbol)).toContain('src/a.ts');
      expect(callerReads.map((r) => r.symbol)).toContain('src/b.ts');
    });

    it('rename intent: requiredReads caps caller files at 5', async () => {
      const manyCallerRows = Array.from({ length: 8 }, (_, i) => ({
        sourceId: NODE_ID,
        id: `Function:src/caller${i}.ts:fn`,
        name: 'fn',
        type: 'Function',
        filePath: `src/caller${i}.ts`,
        relType: 'CALLS',
        confidence: 0.9,
      }));
      setupMocks({ upstreamRows: manyCallerRows });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

      // 1 symbol entry + up to 5 caller files = max 6 entries
      expect(report.requiredReads!.length).toBeLessThanOrEqual(6);
    });

    it('rename intent: recommendedAction uses rename_symbol with symbol nodeId', async () => {
      setupMocks({ upstreamN: 2 });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

      expect(report.recommendedAction).toBeDefined();
      expect(report.recommendedAction!.tool).toBe('rename_symbol');
      expect(report.recommendedAction!.params).toMatchObject({ symbol: NODE_ID });
      expect(report.recommendedAction!.rationale).toBeTruthy();
    });

    it('modify-body intent: requiredReads includes only the symbol nodeId', async () => {
      setupMocks({ upstreamN: 2 });

      const report = await gnSafeEditCheck(REPO_ID, {
        symbol: 'parseToken',
        intent: 'modify-body',
      });

      expect(report.requiredReads).toBeDefined();
      expect(report.requiredReads).toHaveLength(1);
      expect(report.requiredReads![0].symbol).toBe(NODE_ID);
      expect(report.requiredReads![0].reason).toMatch(/body/i);
    });

    it('modify-body intent: recommendedAction uses update_symbol_body with symbol nodeId', async () => {
      setupMocks({ upstreamN: 2 });

      const report = await gnSafeEditCheck(REPO_ID, {
        symbol: 'parseToken',
        intent: 'modify-body',
      });

      expect(report.recommendedAction).toBeDefined();
      expect(report.recommendedAction!.tool).toBe('update_symbol_body');
      expect(report.recommendedAction!.params).toMatchObject({ symbol: NODE_ID });
      expect(report.recommendedAction!.rationale).toBeTruthy();
    });

    it('general intent: requiredReads and recommendedAction are absent', async () => {
      setupMocks({ upstreamN: 2 });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'general' });

      expect(report.requiredReads).toBeUndefined();
      expect(report.recommendedAction).toBeUndefined();
    });

    it('delete intent: requiredReads and recommendedAction are absent', async () => {
      setupMocks({ upstreamN: 2 });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'delete' });

      expect(report.requiredReads).toBeUndefined();
      expect(report.recommendedAction).toBeUndefined();
    });

    it('default (no intent): requiredReads and recommendedAction are absent', async () => {
      setupMocks({ upstreamN: 2 });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

      expect(report.requiredReads).toBeUndefined();
      expect(report.recommendedAction).toBeUndefined();
    });

    it('rename intent: new fields do not affect verdict or existing fields', async () => {
      setupMocks({
        upstreamN: 3,
        testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
        lastDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

      expect(report.verdict).toBe('SAFE');
      expect(report.recommendedTool).toBe('rename_symbol');
      expect(report.recommendedToolVisibility).toBe('backend-fallback');
      expect(report.suggestedNext.find((s) => s.tool === 'rename_symbol')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // D2: LSP rename validation slice
  // -------------------------------------------------------------------------

  describe('D2 — LSP rename validation', () => {
    it('rename intent: preChecks includes lsp_rename_ready when LSP confirms support', async () => {
      setupMocks({
        upstreamN: 2,
        lspRenameResult: { supported: true, placeholder: 'parseToken' },
      });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

      const check = report.preChecks.find((c) => c.check === 'lsp_rename_ready');
      expect(check).toBeDefined();
      expect(check!.passed).toBe(true);
      expect(check!.detail).toContain('parseToken');
    });

    it('rename intent: lsp_rename_ready passed=true without placeholder', async () => {
      setupMocks({
        upstreamN: 2,
        lspRenameResult: { supported: true },
      });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

      const check = report.preChecks.find((c) => c.check === 'lsp_rename_ready');
      expect(check).toBeDefined();
      expect(check!.passed).toBe(true);
      expect(check!.detail).toContain('LSP confirms rename is supported');
    });

    it('rename intent: lsp_rename_ready passed=false when LSP not available', async () => {
      setupMocks({
        upstreamN: 2,
        lspRenameResult: { supported: false },
      });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

      const check = report.preChecks.find((c) => c.check === 'lsp_rename_ready');
      expect(check).toBeDefined();
      expect(check!.passed).toBe(false);
      expect(check!.detail).toContain('graph-only rename');
    });

    it('non-rename intent: preChecks does not include lsp_rename_ready', async () => {
      for (const intent of ['general', 'modify-body', 'delete'] as const) {
        setupMocks({ upstreamN: 2 });

        const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent });

        expect(report.preChecks.find((c) => c.check === 'lsp_rename_ready')).toBeUndefined();
      }
    });

    it('default intent: preChecks does not include lsp_rename_ready', async () => {
      setupMocks({ upstreamN: 2 });

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken' });

      expect(report.preChecks.find((c) => c.check === 'lsp_rename_ready')).toBeUndefined();
    });

    it('rename intent: validateRename error is caught and preCheck reports graph-only', async () => {
      setupMocks({ upstreamN: 2 });
      mockValidateRename.mockRejectedValue(new Error('LSP timeout'));

      const report = await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

      const check = report.preChecks.find((c) => c.check === 'lsp_rename_ready');
      expect(check).toBeDefined();
      expect(check!.passed).toBe(false);
      expect(check!.detail).toContain('graph-only rename');
    });

    it('rename intent: validateRename is called with the resolved filePath', async () => {
      setupMocks({ upstreamN: 2, lspRenameResult: { supported: true } });

      await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'rename' });

      expect(mockValidateRename).toHaveBeenCalledWith('src/auth/token.ts', 0, 0);
    });

    it('rename intent: validateRename is NOT called for non-rename intent', async () => {
      setupMocks({ upstreamN: 2 });

      await gnSafeEditCheck(REPO_ID, { symbol: 'parseToken', intent: 'modify-body' });

      expect(mockValidateRename).not.toHaveBeenCalled();
    });

    it('rename intent: lsp_rename_ready does not affect verdict', async () => {
      setupMocks({
        upstreamN: 2,
        lspRenameResult: { supported: true, placeholder: 'parseToken' },
        testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
        lastDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const reportReady = await gnSafeEditCheck(REPO_ID, {
        symbol: 'parseToken',
        intent: 'rename',
      });

      setupMocks({
        upstreamN: 2,
        lspRenameResult: { supported: false },
        testCoverage: { coveringTests: ['test/unit/auth.test.ts'], likelihoodOfCoverage: 'HIGH' },
        lastDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const reportNotReady = await gnSafeEditCheck(REPO_ID, {
        symbol: 'parseToken',
        intent: 'rename',
      });

      expect(reportReady.verdict).toBe(reportNotReady.verdict);
    });
  });
});
