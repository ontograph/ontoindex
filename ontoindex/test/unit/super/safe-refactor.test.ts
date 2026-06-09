/**
 * Unit tests for gn_safe_refactor super-function (Phase 3 W3a).
 *
 * All external primitives are mocked so tests run without a live DB or filesystem.
 *
 * Mock call-order for gnSafeRefactor (non-preCheck path):
 *   1. resolveSymbol (executeParameterized — fuzzy lookup)
 *   Then dispatchDryRun / dispatchApply calls the atomic tool mock.
 *
 * For paths that call gnSafeEditCheck (preChecks !== false), the 8 internal
 * executeParameterized calls of gnSafeEditCheck are consumed first
 * (see safe-edit-check.test.ts for order).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import under test.
// ---------------------------------------------------------------------------

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

vi.mock('../../../src/core/lsp/bridge.js', () => ({
  lspBridge: {
    getClient: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../../src/mcp/super/_helpers/test-coverage.js', () => ({
  findTestFiles: vi.fn().mockResolvedValue({
    coveringTests: [],
    likelihoodOfCoverage: 'NONE',
  }),
}));

vi.mock('../../../src/mcp/local/backend-rename.js', () => ({
  renameSymbol: vi.fn(),
}));

vi.mock('../../../src/mcp/local/backend-extract-function.js', () => ({
  extractFunction: vi.fn(),
}));

vi.mock('../../../src/mcp/local/backend-move-symbol.js', () => ({
  moveSymbol: vi.fn(),
}));

vi.mock('../../../src/mcp/local/backend-detect-changes.js', () => ({
  detectChanges: vi.fn(),
}));

vi.mock('../../../src/mcp/local/backend-symbol-resolution.js', () => ({
  resolveSymbolCandidates: vi.fn(),
}));

vi.mock('../../../src/core/impact/impact-kernel.js', () => ({
  runImpactKernel: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { executeParameterized } from '../../../src/core/lbug/pool-adapter.js';
import { lspBridge } from '../../../src/core/lsp/bridge.js';
import { findTestFiles } from '../../../src/mcp/super/_helpers/test-coverage.js';
import { renameSymbol } from '../../../src/mcp/local/backend-rename.js';
import { extractFunction } from '../../../src/mcp/local/backend-extract-function.js';
import { moveSymbol } from '../../../src/mcp/local/backend-move-symbol.js';
import { detectChanges } from '../../../src/mcp/local/backend-detect-changes.js';
import { resolveSymbolCandidates } from '../../../src/mcp/local/backend-symbol-resolution.js';
import { runImpactKernel } from '../../../src/core/impact/impact-kernel.js';
import { gnSafeRefactor } from '../../../src/mcp/super/safe-refactor.js';

const mockExecuteParameterized = executeParameterized as unknown as ReturnType<typeof vi.fn>;
const mockGetClient = lspBridge.getClient as unknown as ReturnType<typeof vi.fn>;
const mockFindTestFiles = findTestFiles as unknown as ReturnType<typeof vi.fn>;
const mockRenameSymbol = renameSymbol as unknown as ReturnType<typeof vi.fn>;
const _mockExtractFunction = extractFunction as unknown as ReturnType<typeof vi.fn>;
const _mockMoveSymbol = moveSymbol as unknown as ReturnType<typeof vi.fn>;
const mockDetectChanges = detectChanges as unknown as ReturnType<typeof vi.fn>;
const _mockResolveSymbolCandidates = resolveSymbolCandidates as unknown as ReturnType<typeof vi.fn>;
const mockRunImpactKernel = runImpactKernel as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';
const SYMBOL_NAME = 'parseToken';
const NODE_ID = 'Function:src/auth/token.ts:parseToken';

function resolvedRow(
  nodeId = NODE_ID,
  name = SYMBOL_NAME,
  filePath = 'src/auth/token.ts',
  kind = 'Function',
): any {
  return { nodeId, name, filePath, kind, callerCount: 3 };
}

/** Mock executeParameterized for the resolveSymbol call (fuzzy lookup — 1 call). */
function mockResolve(rows = [resolvedRow()]): void {
  mockExecuteParameterized.mockResolvedValueOnce(rows);
}

/**
 * Mock executeParameterized for the full gnSafeEditCheck internal call sequence
 * (8 consecutive executeParameterized calls after the initial resolveSymbol call of gnSafeRefactor).
 *
 * gnSafeEditCheck sequence:
 *   1. resolveSymbol (fuzzy)
 *   Then Promise.all:
 *   2. fetchUpstream
 *   3. fetchDownstream
 *   4. fetchProcessCount
 *   5. fetchClusterCount
 *   6. fetchCoChangeSiblings
 *   7. fetchRecentTouchDays
 *   8. fetchIsExported
 */
function mockSafeEditCheckSequence(
  verdict: 'SAFE' | 'CAUTION' | 'DANGEROUS' | 'BLOCKED' = 'SAFE',
): void {
  // 1. gnSafeEditCheck resolveSymbol (fuzzy lookup)
  mockExecuteParameterized.mockResolvedValueOnce([resolvedRow()]);

  const upstreamCount =
    verdict === 'BLOCKED' ? 200 : verdict === 'DANGEROUS' ? 5 : verdict === 'CAUTION' ? 10 : 0;
  mockRunImpactKernel.mockResolvedValueOnce({
    rawCounts: { direct: upstreamCount },
    impacted: Array.from({ length: Math.min(upstreamCount, 10) }, (_, i) => ({
      filePath: `src/caller${i}.ts`,
    })),
    warnings: [],
  });
  mockRunImpactKernel.mockResolvedValueOnce({
    rawCounts: { direct: 0 },
    impacted: [],
    warnings: [],
  });

  const isExported = verdict === 'BLOCKED' || verdict === 'DANGEROUS';
  const lastDate = verdict === 'CAUTION' ? '2026-04-01' : '2026-05-18';
  mockExecuteParameterized.mockImplementation(async (_repoId: string, query: string) => {
    if (query.includes('PARTICIPATES_IN')) return [{ processCount: 0 }];
    if (query.includes('MEMBER_OF')) return [{ clusterCount: 0 }];
    if (query.includes('CO_CHANGED_WITH') && query.includes('lastDate')) return [{ lastDate }];
    if (query.includes('CO_CHANGED_WITH')) return [];
    if (query.includes('isExported')) return [{ isExported }];
    return [];
  });
}

/** Default mock for detectChanges — no unexpected symbols. */
function mockDetectNoUnexpected(): void {
  mockDetectChanges.mockResolvedValueOnce({
    summary: { changed_count: 1, affected_count: 0, changed_files: 1, risk_level: 'low' },
    changed_symbols: [
      {
        id: NODE_ID,
        name: SYMBOL_NAME,
        type: 'Function',
        filePath: 'src/auth/token.ts',
        change_type: 'touched',
      },
    ],
    affected_processes: [],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gnSafeRefactor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Restore default implementations that resetAllMocks clears.
    mockGetClient.mockResolvedValue(null);
    mockFindTestFiles.mockResolvedValue({ coveringTests: [], likelihoodOfCoverage: 'NONE' });
  });

  // -------------------------------------------------------------------------
  // 1. Pre-check blocking verdict → applied: false + preCheckReport included
  // -------------------------------------------------------------------------
  it('returns applied:false when pre-check verdict blocks the refactor', async () => {
    // gnSafeRefactor resolveSymbol (call 1)
    mockResolve();
    // gnSafeEditCheck internal sequence (calls 2-9) — BLOCKED verdict
    mockSafeEditCheckSequence('BLOCKED');

    const report = await gnSafeRefactor(REPO_ID, {
      intent: 'rename',
      symbol: SYMBOL_NAME,
      params: { newName: 'verifyToken' },
    });

    expect(report.applied).toBe(false);
    expect(report.preCheckReport).toBeDefined();
    expect(['BLOCKED', 'DANGEROUS']).toContain(report.preCheckReport!.verdict);
    expect(report.warnings.some((w) => w.includes(report.preCheckReport!.verdict))).toBe(true);
    // renameSymbol should not be called
    expect(mockRenameSymbol).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. force:true overrides BLOCKED verdict → applies (dryRun:false)
  // -------------------------------------------------------------------------
  it('applies when force:true overrides BLOCKED verdict', async () => {
    // gnSafeRefactor resolveSymbol (call 1)
    mockResolve();
    // gnSafeEditCheck sequence — BLOCKED verdict
    mockSafeEditCheckSequence('BLOCKED');
    // dispatchDryRun → renameSymbol (dry_run: true)
    mockRenameSymbol.mockResolvedValueOnce({
      status: 'success',
      old_name: SYMBOL_NAME,
      new_name: 'verifyToken',
      files_affected: 1,
      total_edits: 2,
      changes: [{ file_path: 'src/auth/token.ts', edits: [] }],
      applied: false,
    });
    // resolveSymbol in makeLookupSymbol (called during renameSymbol apply) — skipped since
    // renameSymbol is fully mocked; just set up the second renameSymbol call (apply path)
    mockRenameSymbol.mockResolvedValueOnce({
      status: 'success',
      old_name: SYMBOL_NAME,
      new_name: 'verifyToken',
      files_affected: 1,
      total_edits: 2,
      changes: [{ file_path: 'src/auth/token.ts', edits: [] }],
      applied: true,
    });
    mockDetectNoUnexpected();

    const report = await gnSafeRefactor(REPO_ID, {
      intent: 'rename',
      symbol: SYMBOL_NAME,
      params: { newName: 'verifyToken' },
      dryRun: false,
      force: true,
    });

    expect(report.applied).toBe(true);
    // With force:true the BLOCKED guard is bypassed; gnSafeEditCheck returns DANGEROUS instead.
    expect(['BLOCKED', 'DANGEROUS']).toContain(report.preCheckReport!.verdict);
    expect(report.warnings.some((w) => w.includes('overridden by force:true'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. dryRun:true (default) returns preview without calling apply path
  // -------------------------------------------------------------------------
  it('returns preview-only when dryRun defaults to true', async () => {
    mockResolve();
    // gnSafeEditCheck sequence — SAFE
    mockSafeEditCheckSequence('SAFE');
    // dispatchDryRun → renameSymbol (dry_run: true)
    mockRenameSymbol.mockResolvedValueOnce({
      status: 'success',
      old_name: SYMBOL_NAME,
      new_name: 'verifyToken',
      files_affected: 1,
      total_edits: 3,
      changes: [{ file_path: 'src/auth/token.ts', edits: [] }],
      applied: false,
    });

    const report = await gnSafeRefactor(REPO_ID, {
      intent: 'rename',
      symbol: SYMBOL_NAME,
      params: { newName: 'verifyToken' },
      // dryRun not specified → defaults to true
    });

    expect(report.applied).toBe(false);
    expect(report.preview.estimatedLinesChanged).toBe(3);
    // detectChanges must NOT be called (no apply)
    expect(mockDetectChanges).not.toHaveBeenCalled();
    // renameSymbol called exactly once (dry-run only, no apply)
    expect(mockRenameSymbol).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 4. intent:'rename' calls renameSymbol with correct params and dry_run:true first
  // -------------------------------------------------------------------------
  it('calls renameSymbol with dry_run:true for intent:rename', async () => {
    mockResolve();
    mockSafeEditCheckSequence('SAFE');
    mockRenameSymbol.mockResolvedValueOnce({
      status: 'success',
      old_name: SYMBOL_NAME,
      new_name: 'validateToken',
      files_affected: 2,
      total_edits: 4,
      changes: [
        { file_path: 'src/auth/token.ts', edits: [] },
        { file_path: 'src/auth/middleware.ts', edits: [] },
      ],
      applied: false,
    });

    const report = await gnSafeRefactor(REPO_ID, {
      intent: 'rename',
      symbol: SYMBOL_NAME,
      params: { newName: 'validateToken' },
    });

    expect(mockRenameSymbol).toHaveBeenCalledTimes(1);
    // Verify dry_run:true was passed
    const callArgs = mockRenameSymbol.mock.calls[0];
    expect(callArgs[1]).toMatchObject({ dry_run: true, new_name: 'validateToken' });
    expect(report.preview.affectedFiles).toHaveLength(2);
    expect(report.preview.diffSummary).toContain('parseToken → validateToken');
  });

  // -------------------------------------------------------------------------
  // 5. intent:'split-function' returns applied:false + warning "not yet supported"
  // -------------------------------------------------------------------------
  it('returns applied:false with warning for unsupported intent split-function', async () => {
    const report = await gnSafeRefactor(REPO_ID, {
      intent: 'split-function',
      symbol: SYMBOL_NAME,
      params: {},
    });

    expect(report.applied).toBe(false);
    expect(report.warnings.some((w) => w.includes('not yet supported in Phase 3 dispatcher'))).toBe(
      true,
    );
    // No DB calls needed — short-circuits before any IO
    expect(mockExecuteParameterized).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Post-write detect_changes finding unexpected symbol → warning + rollbackInstructions
  // -------------------------------------------------------------------------
  it('adds warning and rollbackInstructions when detect_changes finds unexpected scope', async () => {
    mockResolve();
    mockSafeEditCheckSequence('SAFE');
    // dry-run rename
    mockRenameSymbol.mockResolvedValueOnce({
      status: 'success',
      old_name: SYMBOL_NAME,
      new_name: 'verifyToken',
      files_affected: 1,
      total_edits: 1,
      changes: [{ file_path: 'src/auth/token.ts', edits: [] }],
      applied: false,
    });
    // apply rename
    mockRenameSymbol.mockResolvedValueOnce({
      status: 'success',
      old_name: SYMBOL_NAME,
      new_name: 'verifyToken',
      files_affected: 1,
      total_edits: 1,
      changes: [{ file_path: 'src/auth/token.ts', edits: [] }],
      applied: true,
    });
    // detect_changes returns an unexpected extra symbol
    mockDetectChanges.mockResolvedValueOnce({
      summary: { changed_count: 2, affected_count: 0, changed_files: 1, risk_level: 'low' },
      changed_symbols: [
        {
          id: NODE_ID,
          name: SYMBOL_NAME,
          type: 'Function',
          filePath: 'src/auth/token.ts',
          change_type: 'touched',
        },
        {
          id: 'Function:src/auth/middleware.ts:authenticate',
          name: 'authenticate',
          type: 'Function',
          filePath: 'src/auth/middleware.ts',
          change_type: 'touched',
        },
      ],
      affected_processes: [],
    });

    const report = await gnSafeRefactor(REPO_ID, {
      intent: 'rename',
      symbol: SYMBOL_NAME,
      params: { newName: 'verifyToken' },
      dryRun: false,
    });

    expect(report.applied).toBe(true);
    expect(report.warnings.some((w) => w.includes('unexpected scope'))).toBe(true);
    expect(report.rollbackInstructions).toMatch(/git restore/);
    expect(report.postCheckSummary!.unexpected).toContain('authenticate');
  });

  // -------------------------------------------------------------------------
  // 7. Successful apply with no unexpected scope → applied:true, no rollback
  // -------------------------------------------------------------------------
  it('returns applied:true with no rollbackInstructions on clean apply', async () => {
    mockResolve();
    mockSafeEditCheckSequence('SAFE');
    // dry-run
    mockRenameSymbol.mockResolvedValueOnce({
      status: 'success',
      old_name: SYMBOL_NAME,
      new_name: 'verifyToken',
      files_affected: 1,
      total_edits: 1,
      changes: [{ file_path: 'src/auth/token.ts', edits: [] }],
      applied: false,
    });
    // apply
    mockRenameSymbol.mockResolvedValueOnce({
      status: 'success',
      old_name: SYMBOL_NAME,
      new_name: 'verifyToken',
      files_affected: 1,
      total_edits: 1,
      changes: [{ file_path: 'src/auth/token.ts', edits: [] }],
      applied: true,
    });
    mockDetectNoUnexpected();

    const report = await gnSafeRefactor(REPO_ID, {
      intent: 'rename',
      symbol: SYMBOL_NAME,
      params: { newName: 'verifyToken' },
      dryRun: false,
    });

    expect(report.applied).toBe(true);
    expect(report.rollbackInstructions).toBeUndefined();
    expect(report.postCheckSummary!.unexpected).toHaveLength(0);
    expect(report.version).toBe(1);
  });
});
