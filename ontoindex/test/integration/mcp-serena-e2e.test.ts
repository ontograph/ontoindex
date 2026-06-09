/**
 * SERENA-REV5: End-to-end acceptance tests.
 *
 * Proves the full v1 contract through the same dispatch path a real MCP
 * client uses (dispatchSuper), not direct function calls:
 *
 *  E2E-1  gn_help — mode-aware content differs by mode
 *  E2E-2  gn_tool_contract — works with and without mode param
 *  E2E-3  MCP discovery stability — SUPER_NAMES stable across mode-aware calls
 *  E2E-4  gn_help repo context — readiness/stale info appears when repo supplied
 *  E2E-5  gn_safe_edit_check — suggestedNext visibility labels are registry-valid
 *         (routed through dispatchSuper, DB mocked)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted before any source imports
// ---------------------------------------------------------------------------

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
  executeQuery: vi.fn(),
}));

vi.mock('../../src/core/lsp/bridge.js', () => ({
  lspBridge: { getClient: vi.fn() },
}));

vi.mock('../../src/mcp/super/_helpers/test-coverage.js', () => ({
  findTestFiles: vi.fn(),
}));

vi.mock('../../src/mcp/super/docs-evidence.js', () => ({
  collectAdvisoryDocsEvidence: vi.fn(),
}));

vi.mock('../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { dispatchSuper, SUPER_NAMES } from '../../src/mcp/super/dispatch.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';
import { ALL_AGENT_MODES } from '../../src/mcp/shared/tool-registry.js';
import { executeParameterized, executeQuery } from '../../src/core/lbug/pool-adapter.js';
import { lspBridge } from '../../src/core/lsp/bridge.js';
import { findTestFiles } from '../../src/mcp/super/_helpers/test-coverage.js';
import { collectAdvisoryDocsEvidence } from '../../src/mcp/super/docs-evidence.js';
import { resolveTargetContext } from '../../src/mcp/shared/target-context.js';

const mockExecuteParameterized = executeParameterized as unknown as ReturnType<typeof vi.fn>;
const mockExecuteQuery = executeQuery as unknown as ReturnType<typeof vi.fn>;
const mockGetClient = lspBridge.getClient as unknown as ReturnType<typeof vi.fn>;
const mockFindTestFiles = findTestFiles as unknown as ReturnType<typeof vi.fn>;
const mockCollectDocsEvidence = collectAdvisoryDocsEvidence as unknown as ReturnType<typeof vi.fn>;
const mockResolveTargetContext = resolveTargetContext as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Safe-edit mock helpers (mirror unit test fixtures)
// ---------------------------------------------------------------------------

const NODE_ID = 'Function:src/auth/token.ts:parseToken';

function resolvedRow(
  nodeId = NODE_ID,
  name = 'parseToken',
  filePath = 'src/auth/token.ts',
  kind = 'Function',
): Record<string, unknown> {
  return { nodeId, name, filePath, kind, callerCount: 3 };
}

function upstreamImpactRows(n: number): Record<string, unknown>[] {
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

function downstreamImpactRows(n: number): Record<string, unknown>[] {
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

function setupSafeEditMocks(opts: {
  upstreamN?: number;
  downstreamN?: number;
  intent?: string;
}): void {
  const { upstreamN = 2, downstreamN = 0 } = opts;

  mockExecuteParameterized
    .mockResolvedValueOnce([resolvedRow()]) // symbol resolution
    .mockResolvedValue([]); // class seed expansion etc.

  mockExecuteQuery
    .mockResolvedValueOnce(upstreamImpactRows(upstreamN)) // upstream impact
    .mockResolvedValueOnce(downstreamImpactRows(downstreamN)) // downstream impact
    .mockResolvedValue([]); // other probes

  mockFindTestFiles.mockResolvedValue({
    coveringTests: ['test/unit/auth.test.ts'],
    likelihoodOfCoverage: 'HIGH' as const,
  });
  mockGetClient.mockResolvedValue(null);
  mockCollectDocsEvidence.mockResolvedValue(undefined);
  mockResolveTargetContext.mockResolvedValue({
    scope: 'repo',
    repoId: 'test-repo',
    repoName: 'test-repo',
  });
}

// ---------------------------------------------------------------------------
// E2E-1: gn_help — mode-aware content differs by mode
// ---------------------------------------------------------------------------

describe('E2E-1: gn_help mode-aware content via dispatchSuper', () => {
  it('no-mode call returns a valid HelpReport with version:1', async () => {
    const result = (await dispatchSuper('gn_help', {}, '')) as Record<string, unknown>;
    expect(result.version).toBe(1);
    expect(Array.isArray(result.superFunctions)).toBe(true);
    expect((result.superFunctions as unknown[]).length).toBe(ONTOINDEX_SUPER_TOOLS.length);
  });

  it('mode absent from result when not supplied', async () => {
    const result = (await dispatchSuper('gn_help', {}, '')) as Record<string, unknown>;
    expect(result.mode).toBeUndefined();
    expect(result.modeDescription).toBeUndefined();
  });

  it('mode=audit: result includes mode and modeDescription', async () => {
    const result = (await dispatchSuper('gn_help', { mode: 'audit' }, '')) as Record<
      string,
      unknown
    >;
    expect(result.mode).toBe('audit');
    expect(typeof result.modeDescription).toBe('string');
    expect((result.modeDescription as string).length).toBeGreaterThan(0);
  });

  it('mode=refactor: result includes mode and modeDescription', async () => {
    const result = (await dispatchSuper('gn_help', { mode: 'refactor' }, '')) as Record<
      string,
      unknown
    >;
    expect(result.mode).toBe('refactor');
    expect(typeof result.modeDescription).toBe('string');
  });

  it('mode=general workflow does not mention audit-session steps', async () => {
    const result = (await dispatchSuper('gn_help', { mode: 'general' }, '')) as Record<
      string,
      unknown
    >;
    const workflow = (result.recommendedWorkflow as string[]).join('\n');
    expect(workflow).not.toContain('gn_audit_session_start');
  });

  it('mode=audit workflow includes audit session start', async () => {
    const result = (await dispatchSuper('gn_help', { mode: 'audit' }, '')) as Record<
      string,
      unknown
    >;
    const workflow = (result.recommendedWorkflow as string[]).join('\n');
    expect(workflow).toContain('gn_audit_session_start');
  });

  it('mode=refactor workflow includes gn_safe_refactor', async () => {
    const result = (await dispatchSuper('gn_help', { mode: 'refactor' }, '')) as Record<
      string,
      unknown
    >;
    const workflow = (result.recommendedWorkflow as string[]).join('\n');
    expect(workflow).toContain('gn_safe_refactor');
  });

  it('mode-aware workflows differ across modes', async () => {
    const [general, audit, refactor] = (await Promise.all([
      dispatchSuper('gn_help', { mode: 'general' }, ''),
      dispatchSuper('gn_help', { mode: 'audit' }, ''),
      dispatchSuper('gn_help', { mode: 'refactor' }, ''),
    ])) as Array<Record<string, unknown>>;

    const generalWf = (general.recommendedWorkflow as string[]).join('\n');
    const auditWf = (audit.recommendedWorkflow as string[]).join('\n');
    const refactorWf = (refactor.recommendedWorkflow as string[]).join('\n');

    expect(auditWf).not.toBe(generalWf);
    expect(refactorWf).not.toBe(generalWf);
    expect(auditWf).not.toBe(refactorWf);
  });

  it('every entry in mode-filtered superFunctions has name, intent, whenToUse', async () => {
    for (const mode of ALL_AGENT_MODES) {
      const result = (await dispatchSuper('gn_help', { mode }, '')) as Record<string, unknown>;
      for (const sf of result.superFunctions as Array<Record<string, unknown>>) {
        expect(typeof sf.name).toBe('string');
        expect((sf.name as string).length).toBeGreaterThan(0);
        expect(typeof sf.intent).toBe('string');
        expect((sf.intent as string).length).toBeGreaterThan(0);
        expect(typeof sf.whenToUse).toBe('string');
        expect((sf.whenToUse as string).length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// E2E-2: gn_tool_contract — works with and without mode param via dispatchSuper
// ---------------------------------------------------------------------------

describe('E2E-2: gn_tool_contract via dispatchSuper', () => {
  it('no-mode call returns version:1, status ok, no missing or extras', async () => {
    const result = (await dispatchSuper('gn_tool_contract', {}, '')) as Record<string, unknown>;
    expect(result.version).toBe(1);
    expect(result.status).toBe('ok');
    expect(result.missing).toEqual([]);
    expect(result.extras).toEqual([]);
  });

  it('no-mode call: modeFrontier is absent', async () => {
    const result = (await dispatchSuper('gn_tool_contract', {}, '')) as Record<string, unknown>;
    expect(result.mode).toBeUndefined();
    expect(result.modeFrontier).toBeUndefined();
  });

  it('mode=general: modeFrontier present and status ok', async () => {
    const result = (await dispatchSuper('gn_tool_contract', { mode: 'general' }, '')) as Record<
      string,
      unknown
    >;
    expect(result.mode).toBe('general');
    const frontier = result.modeFrontier as Record<string, unknown>;
    expect(frontier).toBeDefined();
    expect(frontier.mode).toBe('general');
    expect(frontier.status).toBe('ok');
    expect(frontier.missing).toEqual([]);
    expect(frontier.extras).toEqual([]);
  });

  it.each(ALL_AGENT_MODES)(
    'mode=%s: modeFrontier status is ok (no drift in current registry)',
    async (mode) => {
      const result = (await dispatchSuper('gn_tool_contract', { mode }, '')) as Record<
        string,
        unknown
      >;
      const frontier = result.modeFrontier as Record<string, unknown>;
      expect(frontier.status).toBe('ok');
    },
  );

  it.each(['general', 'audit', 'refactor'] as const)(
    'write mode=%s: modeFrontier advertised matches full advertised',
    async (mode) => {
      const full = (await dispatchSuper('gn_tool_contract', {}, '')) as Record<string, unknown>;
      const withMode = (await dispatchSuper('gn_tool_contract', { mode }, '')) as Record<
        string,
        unknown
      >;
      // Write modes have all tools — mode filtering is identity
      expect((withMode.modeFrontier as Record<string, unknown>).advertised).toEqual(
        full.advertised,
      );
    },
  );

  it('query-projects: modeFrontier advertised is a strict subset of full advertised', async () => {
    const full = (await dispatchSuper('gn_tool_contract', {}, '')) as Record<string, unknown>;
    const withMode = (await dispatchSuper(
      'gn_tool_contract',
      { mode: 'query-projects' },
      '',
    )) as Record<string, unknown>;
    const fullSet = new Set(full.advertised as string[]);
    const qpAdvertised = (withMode.modeFrontier as Record<string, unknown>).advertised as string[];
    expect(qpAdvertised.length).toBeGreaterThan(0);
    expect(qpAdvertised.length).toBeLessThan((full.advertised as string[]).length);
    for (const name of qpAdvertised) {
      expect(fullSet.has(name)).toBe(true);
    }
  });

  it('all structural checks pass when dispatched through dispatchSuper', async () => {
    const result = (await dispatchSuper('gn_tool_contract', {}, '')) as Record<string, unknown>;
    const checks = result.structuralChecks as Array<Record<string, unknown>>;
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(check.status).toBe('pass');
    }
  });

  it('runtime.superToolCount matches ONTOINDEX_SUPER_TOOLS.length', async () => {
    const result = (await dispatchSuper('gn_tool_contract', {}, '')) as Record<string, unknown>;
    const runtime = result.runtime as Record<string, unknown>;
    expect(runtime.superToolCount).toBe(ONTOINDEX_SUPER_TOOLS.length);
  });
});

// ---------------------------------------------------------------------------
// E2E-3: MCP discovery stability — SUPER_NAMES stable across mode-aware calls
// ---------------------------------------------------------------------------

describe('E2E-3: MCP discovery stability', () => {
  it('SUPER_NAMES is a non-empty set before any mode-aware call', () => {
    expect(SUPER_NAMES.size).toBeGreaterThan(0);
  });

  it('SUPER_NAMES size matches ONTOINDEX_SUPER_TOOLS.length', () => {
    expect(SUPER_NAMES.size).toBe(ONTOINDEX_SUPER_TOOLS.length);
  });

  it('SUPER_NAMES contains gn_help and gn_tool_contract', () => {
    expect(SUPER_NAMES.has('gn_help')).toBe(true);
    expect(SUPER_NAMES.has('gn_tool_contract')).toBe(true);
  });

  it('SUPER_NAMES size does not change after mode-aware gn_help calls', async () => {
    const before = SUPER_NAMES.size;
    await Promise.all(ALL_AGENT_MODES.map((mode) => dispatchSuper('gn_help', { mode }, '')));
    expect(SUPER_NAMES.size).toBe(before);
  });

  it('SUPER_NAMES size does not change after mode-aware gn_tool_contract calls', async () => {
    const before = SUPER_NAMES.size;
    await Promise.all(
      ALL_AGENT_MODES.map((mode) => dispatchSuper('gn_tool_contract', { mode }, '')),
    );
    expect(SUPER_NAMES.size).toBe(before);
  });

  it('gn_tool_contract advertised set is identical before and after mode-aware help calls', async () => {
    const before = ((await dispatchSuper('gn_tool_contract', {}, '')) as Record<string, unknown>)
      .advertised as string[];

    // Make mode-aware help calls that could theoretically mutate state
    await Promise.all(ALL_AGENT_MODES.map((mode) => dispatchSuper('gn_help', { mode }, '')));

    const after = ((await dispatchSuper('gn_tool_contract', {}, '')) as Record<string, unknown>)
      .advertised as string[];

    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// E2E-4: gn_help repo context — readiness/stale info appears when repo supplied
// ---------------------------------------------------------------------------

describe('E2E-4: gn_help readiness notes via dispatchSuper', () => {
  it('no repo: readinessNotes is absent', async () => {
    const result = (await dispatchSuper('gn_help', {}, '')) as Record<string, unknown>;
    expect(result.readinessNotes).toBeUndefined();
  });

  it('repo supplied: readinessNotes is a non-empty array', async () => {
    const result = (await dispatchSuper('gn_help', { repo: 'my-repo' }, '')) as Record<
      string,
      unknown
    >;
    expect(Array.isArray(result.readinessNotes)).toBe(true);
    expect((result.readinessNotes as unknown[]).length).toBeGreaterThan(0);
  });

  it('readinessNotes references gn_diagnose', async () => {
    const result = (await dispatchSuper('gn_help', { repo: 'my-repo' }, '')) as Record<
      string,
      unknown
    >;
    const notes = (result.readinessNotes as string[]).join('\n');
    expect(notes).toContain('gn_diagnose');
  });

  it('readinessNotes references gn_ensure_fresh', async () => {
    const result = (await dispatchSuper('gn_help', { repo: 'my-repo' }, '')) as Record<
      string,
      unknown
    >;
    const notes = (result.readinessNotes as string[]).join('\n');
    expect(notes).toContain('gn_ensure_fresh');
  });

  it('readinessNotes mentions stale index or dirty worktree guidance', async () => {
    const result = (await dispatchSuper('gn_help', { repo: 'my-repo' }, '')) as Record<
      string,
      unknown
    >;
    const notes = (result.readinessNotes as string[]).join('\n');
    expect(notes).toMatch(/stale|dirty|worktree|embeddings/i);
  });

  it('repo + mode: both readinessNotes and mode are present', async () => {
    const result = (await dispatchSuper(
      'gn_help',
      { repo: 'my-repo', mode: 'audit' },
      '',
    )) as Record<string, unknown>;
    expect(result.mode).toBe('audit');
    expect(Array.isArray(result.readinessNotes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E2E-5: gn_safe_edit_check — suggestedNext visibility labels are registry-valid
//         via dispatchSuper (DB mocked)
// ---------------------------------------------------------------------------

describe('E2E-5: gn_safe_edit_check registry-valid visibility via dispatchSuper', () => {
  const VALID_VISIBILITIES = new Set(['public', 'facade', 'backend-fallback', 'manual', 'unknown']);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('modify intent: all suggestedNext entries carry a valid visibility label', async () => {
    setupSafeEditMocks({ upstreamN: 2, intent: 'modify-body' });

    const result = (await dispatchSuper(
      'gn_safe_edit_check',
      { symbol: 'parseToken', intent: 'modify-body' },
      'test-repo',
    )) as Record<string, unknown>;

    const suggestions = result.suggestedNext as Array<Record<string, unknown>>;
    expect(suggestions).toBeDefined();
    expect(Array.isArray(suggestions)).toBe(true);

    for (const s of suggestions) {
      expect(typeof s.visibility).toBe('string');
      expect(VALID_VISIBILITIES.has(s.visibility as string)).toBe(true);
    }
  });

  it('rename intent: recommendedToolVisibility is backend-fallback (rename_symbol is not public)', async () => {
    setupSafeEditMocks({ upstreamN: 3, intent: 'rename' });

    const result = (await dispatchSuper(
      'gn_safe_edit_check',
      { symbol: 'parseToken', intent: 'rename' },
      'test-repo',
    )) as Record<string, unknown>;

    expect(result.recommendedTool).toBe('rename_symbol');
    expect(result.recommendedToolVisibility).toBe('backend-fallback');
  });

  it('no suggestedNext tool has visibility "unknown" for registered public/backend tools', async () => {
    setupSafeEditMocks({ upstreamN: 2 });

    const result = (await dispatchSuper(
      'gn_safe_edit_check',
      { symbol: 'parseToken' },
      'test-repo',
    )) as Record<string, unknown>;

    const suggestions = result.suggestedNext as Array<Record<string, unknown>>;
    for (const s of suggestions) {
      // All hardcoded tool suggestions in safe-edit-check must be in the registry
      expect(s.visibility).not.toBe('unknown');
    }
  });

  it('delete intent: gn_can_delete suggestion has visibility public (super-tool)', async () => {
    setupSafeEditMocks({ upstreamN: 2, intent: 'delete' });

    const result = (await dispatchSuper(
      'gn_safe_edit_check',
      { symbol: 'parseToken', intent: 'delete' },
      'test-repo',
    )) as Record<string, unknown>;

    const suggestions = result.suggestedNext as Array<Record<string, unknown>>;
    const canDelete = suggestions.find((s) => s.tool === 'gn_can_delete');
    if (canDelete !== undefined) {
      expect(canDelete.visibility).toBe('public');
    }
  });
});

// ---------------------------------------------------------------------------
// E2E-D5: query-projects mode — read-only discovery via dispatchSuper
// ---------------------------------------------------------------------------

describe('E2E-D5: query-projects mode — gn_help via dispatchSuper', () => {
  it('mode=query-projects: result includes mode and modeDescription', async () => {
    const result = (await dispatchSuper('gn_help', { mode: 'query-projects' }, '')) as Record<
      string,
      unknown
    >;
    expect(result.mode).toBe('query-projects');
    expect(typeof result.modeDescription).toBe('string');
    expect((result.modeDescription as string).length).toBeGreaterThan(0);
  });

  it('mode=query-projects: modeDescription references read-only or discovery', async () => {
    const result = (await dispatchSuper('gn_help', { mode: 'query-projects' }, '')) as Record<
      string,
      unknown
    >;
    expect(result.modeDescription as string).toMatch(/read-only|discovery/i);
  });

  it('mode=query-projects: superFunctions is a non-empty subset of full list', async () => {
    const full = (await dispatchSuper('gn_help', {}, '')) as Record<string, unknown>;
    const qp = (await dispatchSuper('gn_help', { mode: 'query-projects' }, '')) as Record<
      string,
      unknown
    >;
    const fullNames = new Set(
      (full.superFunctions as Array<Record<string, unknown>>).map((sf) => sf.name as string),
    );
    const qpFunctions = qp.superFunctions as Array<Record<string, unknown>>;
    expect(qpFunctions.length).toBeGreaterThan(0);
    expect(qpFunctions.length).toBeLessThan((full.superFunctions as unknown[]).length);
    for (const sf of qpFunctions) {
      expect(fullNames.has(sf.name as string)).toBe(true);
    }
  });

  it('mode=query-projects: superFunctions contains gn_explore and gn_help', async () => {
    const result = (await dispatchSuper('gn_help', { mode: 'query-projects' }, '')) as Record<
      string,
      unknown
    >;
    const names = (result.superFunctions as Array<Record<string, unknown>>).map(
      (sf) => sf.name as string,
    );
    expect(names).toContain('gn_explore');
    expect(names).toContain('gn_help');
  });

  it('mode=query-projects: superFunctions does not contain write/audit tools', async () => {
    const result = (await dispatchSuper('gn_help', { mode: 'query-projects' }, '')) as Record<
      string,
      unknown
    >;
    const names = (result.superFunctions as Array<Record<string, unknown>>).map(
      (sf) => sf.name as string,
    );
    expect(names).not.toContain('gn_safe_edit_check');
    expect(names).not.toContain('gn_safe_refactor');
    expect(names).not.toContain('gn_audit_ingest');
  });

  it('mode=query-projects: recommendedWorkflow references discovery surfaces', async () => {
    const result = (await dispatchSuper('gn_help', { mode: 'query-projects' }, '')) as Record<
      string,
      unknown
    >;
    const wf = (result.recommendedWorkflow as string[]).join('\n');
    expect(wf).toMatch(/discover|repos|groups/i);
  });

  it('mode=query-projects: recommendedWorkflow does not include write operations', async () => {
    const result = (await dispatchSuper('gn_help', { mode: 'query-projects' }, '')) as Record<
      string,
      unknown
    >;
    const wf = (result.recommendedWorkflow as string[]).join('\n');
    expect(wf).not.toContain('gn_safe_edit_check');
    expect(wf).not.toContain('gn_safe_refactor');
    expect(wf).not.toContain('gn_audit_session_start');
  });

  it('mode=query-projects: gn_tool_contract modeFrontier is ok', async () => {
    const result = (await dispatchSuper(
      'gn_tool_contract',
      { mode: 'query-projects' },
      '',
    )) as Record<string, unknown>;
    expect(result.mode).toBe('query-projects');
    const frontier = result.modeFrontier as Record<string, unknown>;
    expect(frontier).toBeDefined();
    expect(frontier.status).toBe('ok');
    expect(frontier.missing).toEqual([]);
    expect(frontier.extras).toEqual([]);
  });

  it('SUPER_NAMES size stable after query-projects mode calls', async () => {
    const before = SUPER_NAMES.size;
    await dispatchSuper('gn_help', { mode: 'query-projects' }, '');
    await dispatchSuper('gn_tool_contract', { mode: 'query-projects' }, '');
    expect(SUPER_NAMES.size).toBe(before);
  });
});
