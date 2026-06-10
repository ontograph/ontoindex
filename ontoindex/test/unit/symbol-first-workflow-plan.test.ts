import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type SymbolFirstWorkflowActionNames,
  buildSymbolFirstWorkflowPlan,
} from '../../src/core/agent-workflow/symbol-first-plan.js';

const baseTarget = {
  kind: 'symbol',
  name: 'resolveTarget',
  filePath: 'src/core/target.ts',
};

describe('symbol-first workflow plan', () => {
  it('validates target name and kind', () => {
    expect(() =>
      buildSymbolFirstWorkflowPlan({
        target: { kind: '', name: 'resolveTarget' },
        intent: 'read',
        evidence: {},
      }),
    ).toThrow(/target.kind must be a non-empty string/);

    expect(() =>
      buildSymbolFirstWorkflowPlan({
        target: { kind: 'symbol', name: '  ' },
        intent: 'read',
        evidence: {},
      }),
    ).toThrow(/target.name must be a non-empty string/);
  });

  it('validates intent support', () => {
    expect(() =>
      buildSymbolFirstWorkflowPlan({
        target: baseTarget,
        // @ts-expect-error invalid intent used for validation coverage
        intent: 'delete-it-all',
        evidence: {},
      }),
    ).toThrow(/unsupported symbol-first intent/);
  });

  it('validates non-negative integer evidence values', () => {
    expect(() =>
      buildSymbolFirstWorkflowPlan({
        target: baseTarget,
        intent: 'read',
        evidence: { upstreamCallerCount: -1 },
      }),
    ).toThrow(/upstreamCallerCount must be a finite non-negative integer/);

    expect(() =>
      buildSymbolFirstWorkflowPlan({
        target: baseTarget,
        intent: 'read',
        evidence: { processCount: 4.5 },
      }),
    ).toThrow(/processCount must be a finite non-negative integer/);

    expect(() =>
      buildSymbolFirstWorkflowPlan({
        target: baseTarget,
        intent: 'read',
        evidence: { coChangeCount: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/coChangeCount must be a finite non-negative integer/);
  });

  it('uses deterministic required-read and score trace ordering', () => {
    const plan = buildSymbolFirstWorkflowPlan({
      target: baseTarget,
      intent: 'modify',
      actionNames: {
        manualPatchWithGuard: 'manual_patch_with_guard',
        changedScopeVerification: 'verify_changed_scope',
        diffVerification: 'verify_diff',
        testGapReview: 'review_test_gap',
      },
      evidence: {
        upstreamCallerCount: 20,
        coChangeCount: 12,
        downstreamDependencyCount: 6,
        processCount: 2,
        testCoverageLikelihood: 'HIGH',
        exported: false,
        lspReady: true,
      },
    });

    expect(plan.requiredReads.map((step) => step.action)).toEqual([
      'target_context',
      'upstream_context',
      'process_context',
    ]);
    expect(plan.scoreTrace.contributions.map((entry) => entry.factor)).toEqual([
      'exported_symbol',
      'high_upstream_count',
      'high_process_count',
      'high_co_change_count',
      'high_downstream_count',
      'weak_coverage_for_destructive_intent',
      'optional_lsp_readiness_missing',
    ]);
    expect(plan.scoreTrace.contributions[1].delta).toBe(3);
    expect(plan.scoreTrace.contributions[2].delta).toBe(0);
    expect(plan.scoreTrace.contributions[3].delta).toBe(2);
  });

  it('escalates verdicts from safe to dangerous based on blast radius and coverage', () => {
    const safePlan = buildSymbolFirstWorkflowPlan({
      target: baseTarget,
      intent: 'read',
      evidence: {
        upstreamCallerCount: 2,
        processCount: 0,
        coChangeCount: 0,
        testCoverageLikelihood: 'HIGH',
        lspReady: true,
      },
    });
    expect(safePlan.verdict).toBe('SAFE');

    const dangerousPlan = buildSymbolFirstWorkflowPlan({
      target: baseTarget,
      intent: 'delete',
      evidence: {
        upstreamCallerCount: 20,
        processCount: 5,
        coChangeCount: 12,
        testCoverageLikelihood: 'LOW',
        lspReady: true,
      },
    });
    expect(dangerousPlan.verdict).toBe('DANGEROUS');
    expect(dangerousPlan.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing_coverage_on_broad_destructive_edit' }),
      ]),
    );
  });

  it('adds freshness blockers and allows advisory-only override', () => {
    const blocked = buildSymbolFirstWorkflowPlan({
      target: baseTarget,
      intent: 'read',
      evidence: { staleIndex: true, dirtyWorktree: true },
    });
    expect(blocked.verdict).toBe('BLOCKED');
    expect(blocked.blockers).toEqual([
      expect.objectContaining({ code: 'stale_index' }),
      expect.objectContaining({ code: 'dirty_worktree' }),
    ]);

    const advisory = buildSymbolFirstWorkflowPlan({
      target: baseTarget,
      intent: 'read',
      advisoryOnly: true,
      evidence: {
        staleIndex: true,
        dirtyWorktree: true,
        lspReady: true,
        testCoverageLikelihood: 'HIGH',
      },
    });
    expect(advisory.verdict).toBe('SAFE');
    expect(advisory.blockers).toEqual([]);
  });

  it('adds edit verifications for modify intent', () => {
    const actionNames: SymbolFirstWorkflowActionNames = {
      manualPatchWithGuard: 'manual_patch_with_guard',
      changedScopeVerification: 'verify_changed_scope',
      diffVerification: 'verify_diff',
      testGapReview: 'review_test_gap',
      reviewOnly: 'review_only',
    };
    const plan = buildSymbolFirstWorkflowPlan({
      target: baseTarget,
      intent: 'modify',
      actionNames,
      evidence: {
        testCoverageLikelihood: 'NONE',
        lspReady: true,
      },
    });
    expect(plan.verificationSteps.map((step) => step.action)).toEqual([
      actionNames.changedScopeVerification,
      actionNames.diffVerification,
      actionNames.testGapReview,
    ]);
  });

  it('normalizes missing or invalid coverage to unknown while treating it as weak', () => {
    const missingCoverage = buildSymbolFirstWorkflowPlan({
      target: baseTarget,
      intent: 'modify',
      evidence: {
        lspReady: true,
      },
    });
    expect(missingCoverage.evidence.testCoverageLikelihood).toBe('UNKNOWN');
    expect(missingCoverage.verificationSteps.map((step) => step.action)).toContain(
      'review_test_gap',
    );

    const invalidCoverage = buildSymbolFirstWorkflowPlan({
      target: baseTarget,
      intent: 'modify',
      evidence: {
        testCoverageLikelihood: 'maybe',
        lspReady: true,
      },
    });
    expect(invalidCoverage.evidence.testCoverageLikelihood).toBe('UNKNOWN');
    expect(invalidCoverage.verdict).toBe('CAUTION');
  });

  it('builds delete-specific required reads', () => {
    const plan = buildSymbolFirstWorkflowPlan({
      target: baseTarget,
      intent: 'delete',
      evidence: {
        upstreamCallerCount: 1,
        downstreamDependencyCount: 2,
        processCount: 4,
        lspReady: true,
        testCoverageLikelihood: 'HIGH',
      },
    });
    expect(plan.requiredReads.map((step) => step.action)).toEqual([
      'target_context',
      'upstream_context',
      'downstream_context',
      'process_context',
    ]);
  });

  it('defaults to caution when optional LSP readiness is missing', () => {
    const plan = buildSymbolFirstWorkflowPlan({
      target: baseTarget,
      intent: 'modify',
      evidence: {
        upstreamCallerCount: 1,
        processCount: 0,
        testCoverageLikelihood: 'HIGH',
        lspReady: false,
      },
    });
    expect(plan.verdict).toBe('CAUTION');
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing_optional_lsp_readiness' }),
      ]),
    );
  });

  it('has no MCP imports in the core module', () => {
    const source = readFileSync(
      new URL('../../src/core/agent-workflow/symbol-first-plan.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('/src/mcp/');
    expect(source).not.toContain('from \'../../mcp/');
    expect(source).not.toContain('from "../../mcp/');
  });
});
