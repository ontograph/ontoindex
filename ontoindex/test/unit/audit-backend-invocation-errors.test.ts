import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the actual backend wrappers; only their inner dependencies are mocked.
vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
  isLbugReady: vi.fn(),
}));
vi.mock('../../src/audit/verification-gap.js', () => ({
  auditVerificationGap: vi.fn(),
}));
vi.mock('../../src/core/repository-policy.js', () => ({
  resolveRepositoryPolicy: vi.fn(),
  createPolicyFilter: vi.fn(),
}));
vi.mock('../../src/mcp/local/backend-git-history.js', () => ({
  commitsByFile: vi.fn(),
  collectGitCommits: vi.fn(),
}));
vi.mock('../../src/core/wiki/llm-client.js', () => ({
  resolveLLMConfig: vi.fn(),
  callLLM: vi.fn(),
}));
vi.mock('../../src/mcp/local/backend-coupling-matrix.js', () => ({
  runCouplingMatrix: vi.fn().mockResolvedValue({
    rows: [{ community: 'retained', ca: 1, ce: 9, instability: 0.9 }],
  }),
}));
vi.mock('../../src/mcp/local/backend-graph-diff.js', () => ({
  runGraphDiff: vi.fn().mockResolvedValue({
    added: [{ source_name: 'retainedSource', target_name: 'retainedTarget' }],
    removed: [],
  }),
}));

import { executeParameterized, isLbugReady } from '../../src/core/lbug/pool-adapter.js';
import { auditVerificationGap } from '../../src/audit/verification-gap.js';
import { resolveRepositoryPolicy } from '../../src/core/repository-policy.js';
import { commitsByFile, collectGitCommits } from '../../src/mcp/local/backend-git-history.js';
import { runVerificationGap } from '../../src/mcp/local/backend-verification-gap.js';
import { runDeadCode } from '../../src/mcp/local/backend-dead-code.js';
import { runCycleDetect } from '../../src/mcp/local/backend-cycle-detect.js';
import { runTechDebt } from '../../src/mcp/local/backend-tech-debt.js';
import { runHotspotAnalysis } from '../../src/mcp/local/backend-hotspot-analysis.js';
import { runBoundaryViolations } from '../../src/mcp/local/backend-boundary-violations.js';
import { runAuditReport, formatAuditReport } from '../../src/mcp/local/backend-audit-report.js';
import { isMarkedInvocationError } from '../../src/mcp/shared/invocation-error.js';

const repo = {
  id: 'fixture',
  name: 'fixture-repo',
  repoPath: '/tmp/fixture',
  storagePath: '/tmp/fixture/.ontoindex',
  lastCommit: 'deadbeef',
};
const failure = new Error('inner dependency failed');

beforeEach(() => {
  vi.mocked(executeParameterized).mockReset().mockResolvedValue([]);
  vi.mocked(isLbugReady).mockReset().mockReturnValue(true);
  vi.mocked(auditVerificationGap).mockReset().mockRejectedValue(failure);
  vi.mocked(resolveRepositoryPolicy).mockReset().mockRejectedValue(failure);
  vi.mocked(commitsByFile).mockReset().mockRejectedValue(failure);
  vi.mocked(collectGitCommits).mockReset().mockRejectedValue(failure);
  vi.spyOn(Date, 'now').mockReturnValue(100);
});

afterEach(() => vi.restoreAllMocks());

describe('real audit backend invocation failures', () => {
  const cases = [
    {
      name: 'verification-gap catch',
      invoke: () => runVerificationGap(repo, {}),
      expected: {
        tool: 'verification_gap',
        base_ref: 'HEAD~1',
        coverage: [],
        uncovered_count: 0,
        error: 'Verification gap audit failed: inner dependency failed',
        errors: ['Verification gap audit failed: inner dependency failed'],
      },
    },
    {
      name: 'dead-code catch',
      invoke: () => runDeadCode(repo, {}),
      expected: {
        tool: 'dead_code',
        entries: [],
        totalSymbols: 0,
        reachableCount: 0,
        deadCount: 0,
        error: 'Dead-code analysis failed: inner dependency failed',
      },
    },
    {
      name: 'cycle-detect invalid edge types',
      invoke: () => runCycleDetect(repo, { edge_types: [] }),
      expected: {
        tool: 'cycle_detect',
        edge_types: [],
        cycles: [],
        error: '`edge_types` must contain at least one non-empty string.',
      },
    },
    {
      name: 'cycle-detect unavailable database',
      invoke: () => {
        vi.mocked(isLbugReady).mockReturnValue(false);
        return runCycleDetect(repo, {});
      },
      expected: {
        tool: 'cycle_detect',
        cycles: [],
        error: 'LadybugDB not initialized for this repo.',
      },
    },
    {
      name: 'cycle-detect query catch',
      invoke: () => {
        vi.mocked(executeParameterized).mockRejectedValue(failure);
        return runCycleDetect(repo, {});
      },
      expected: {
        tool: 'cycle_detect',
        cycles: [],
        error: 'Cycle detection failed: inner dependency failed',
      },
    },
    {
      name: 'tech-debt catch',
      invoke: () => runTechDebt(repo, {}),
      expected: {
        tool: 'tech_debt',
        since: '6 months',
        min_lines: 10,
        symbol_count: 0,
        symbols: [],
        error: 'Tech debt analysis failed: inner dependency failed',
        errors: ['Tech debt analysis failed: inner dependency failed'],
      },
    },
    {
      name: 'hotspot-analysis catch',
      invoke: () => runHotspotAnalysis(repo, {}),
      expected: {
        tool: 'hotspot_analysis',
        metric: 'churn_x_complexity',
        since: '6 months',
        total_commits: 0,
        hotspot_count: 0,
        hotspots: [],
        error: 'Hotspot analysis failed: inner dependency failed',
        warnings: [],
      },
    },
    {
      name: 'boundary-violations catch',
      invoke: () => runBoundaryViolations(repo, {}),
      expected: {
        tool: 'boundary_violations',
        limit_per_rule: 20,
        violations: [],
        clean_rules: [],
        summary: { rules_checked: 0, rules_clean: 0, rules_violated: 0, total_violations: 0 },
        error: 'Boundary violation analysis failed: Provide either rules or rules_file',
      },
    },
  ];

  it.each(cases)(
    '$name preserves payload and marks spread copies',
    async ({ invoke, expected }) => {
      const result = await invoke();
      expect(result).toMatchObject({ status: 'error', repo: repo.name, ...expected });
      expect(isMarkedInvocationError(result)).toBe(true);
      expect(isMarkedInvocationError({ ...result })).toBe(true);
      // JSON retains every string-keyed payload field, with no marker field added.
      expect(JSON.parse(JSON.stringify(result))).toEqual(
        Object.fromEntries(Object.entries(result)),
      );
      expect(JSON.parse(JSON.stringify(result))).toMatchObject(expected);
      expect(isMarkedInvocationError(JSON.parse(JSON.stringify(result)))).toBe(false);
    },
  );

  it('real aggregation discloses failed wrappers while retaining successful siblings', async () => {
    vi.mocked(isLbugReady).mockReturnValue(false);
    const result = await runAuditReport(repo, {});
    const failedSections = [
      'dead-code',
      'cycle-detect',
      'tech-debt',
      'hotspot-analysis',
      'boundary-violations',
      'verification-gap',
    ];
    expect(result.incompleteSections).toEqual(failedSections);
    expect(result.warnings).toEqual([
      'dead-code: Dead-code analysis failed: inner dependency failed',
      'cycle-detect: LadybugDB not initialized for this repo.',
      'tech-debt: Tech debt analysis failed: inner dependency failed',
      'hotspot-analysis: Hotspot analysis failed: inner dependency failed',
      'boundary-violations: Boundary violation analysis failed: Provide either rules or rules_file',
      'verification-gap: Verification gap audit failed: inner dependency failed',
    ]);
    expect(result.couplingViolations).toEqual([
      { module: 'retained', ca: 1, ce: 9, instability: 0.9 },
    ]);
    expect(result.recentDrift).toEqual([
      { type: 'added', source: 'retainedSource', target: 'retainedTarget' },
    ]);
    const markdown = formatAuditReport(result);
    expect(markdown).toContain('> **Partial report**');
    for (const section of [
      'dead-code',
      'cycle-detect',
      'boundary-violations',
      'verification-gap',
    ]) {
      expect(markdown).toContain(`Unavailable: ${section} did not complete (see warnings).`);
    }
    expect(markdown).toContain(
      'Unavailable: tech-debt, hotspot-analysis did not complete (see warnings).',
    );
    for (const cleanClaim of [
      'No dead code candidates.',
      'No cycles detected.',
      'No boundary violations.',
      'No uncovered files detected.',
    ]) {
      expect(markdown).not.toContain(cleanClaim);
    }
  });

  it('keeps tech-debt query fallback and non-Git hotspot results successful and unmarked', async () => {
    vi.mocked(executeParameterized).mockRejectedValue(failure);
    vi.mocked(commitsByFile).mockResolvedValue(new Map());
    vi.mocked(collectGitCommits).mockResolvedValue({
      commits: [],
      warnings: ['git log failed: not a git repository'],
    });
    const debt = await runTechDebt(repo, {});
    const hotspot = await runHotspotAnalysis(repo, {});
    expect(debt).toMatchObject({ status: 'success', symbols: [] });
    expect(hotspot).toMatchObject({
      status: 'success',
      hotspots: [],
      warnings: ['git log failed: not a git repository'],
    });
    expect(isMarkedInvocationError(debt)).toBe(false);
    expect(isMarkedInvocationError(hotspot)).toBe(false);
  });
});
