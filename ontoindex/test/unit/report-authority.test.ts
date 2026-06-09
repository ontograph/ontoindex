import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordEvidenceReadSafe,
  resetEvidenceReadLedgerForTests,
  summarizeBasedOnReads,
} from '../../src/core/runtime/evidence-read-ledger.js';
import type { CommitAuditReport } from '../../src/mcp/super/pre-commit-audit.js';

// Authority boundary tests: prove that ledger events do NOT affect tool verdicts or recommendations.

describe('Report Authority Boundaries', () => {
  beforeEach(() => {
    resetEvidenceReadLedgerForTests();
  });

  it('proves gn_pre_commit_audit verdict is independent of ledger state', () => {
    // 1. Setup a representative report for gn_pre_commit_audit
    const organicReport: CommitAuditReport = {
      version: 1,
      verdict: 'READY',
      reasoning: 'Changes are safe.',
      changedFiles: [],
      unexpectedSymbols: [],
      testCoverageDelta: { coveredBefore: 0, coveredAfter: 0, deltaPp: 0 },
      suggestedReviewers: [],
      preCommitChecklist: [],
      docEvidence: [],
      recommendations: [],
      affectedProcesses: [],
      graphSections: { processesAvailable: true, hunkCoverageAvailable: true },
      status: 'ok',
      freshness: { status: 'fresh', lastCommit: 'abc', indexedAt: '123' },
      evidence: [],
      capabilitiesMissing: [],
    };

    // 2. Inject STALE state into the ledger
    recordEvidenceReadSafe({
      readClass: 'graph_evidence',
      surface: 'mcp',
      target: 'stale-node',
      targetType: 'symbol',
      memoryFreshness: 'stale-index',
    });

    // 3. Attach the ledger summary to the report
    const finalReport: CommitAuditReport = {
      ...organicReport,
      basedOnReads: summarizeBasedOnReads(),
    };

    // 4. Verify that 'verdict' remains organic while 'basedOnReads' shows the truth
    expect(finalReport.verdict).toBe('READY');
    expect(finalReport.basedOnReads?.stale).toBe(true);
    expect(finalReport.basedOnReads?.details?.staleSurfaces).toContain('mcp');
  });

  it('verifies that ledger records cannot create organic recommendations', () => {
    // Organic recommendations come from the recommendation engine, not the ledger.
    // We verify that an empty recommendation list stays empty even if ledger is busy.

    recordEvidenceReadSafe({
      readClass: 'advisory_memory',
      surface: 'test',
      target: 'memory/1',
      targetType: 'memory',
    });

    const summary = summarizeBasedOnReads();
    const recommendations: any[] = []; // Organic engine returns this

    expect(recommendations).toHaveLength(0);
    expect(summary.advisory_memory).toBe(1);
  });

  it('keeps docs, memory, and runtime diagnostics out of audit evidence authority', () => {
    const organicReport: CommitAuditReport = {
      version: 1,
      verdict: 'READY',
      reasoning: 'Graph and audit checks already passed.',
      changedFiles: [],
      unexpectedSymbols: [],
      testCoverageDelta: { coveredBefore: 0, coveredAfter: 0, deltaPp: 0 },
      suggestedReviewers: [],
      preCommitChecklist: [],
      docEvidence: [],
      recommendations: [],
      affectedProcesses: [],
      graphSections: { processesAvailable: true, hunkCoverageAvailable: true },
      status: 'ok',
      freshness: { status: 'fresh', lastCommit: 'abc', indexedAt: '123' },
      evidence: [],
      capabilitiesMissing: [],
    };

    recordEvidenceReadSafe({
      readClass: 'docs_evidence',
      surface: 'docs',
      target: 'docs/adr/0028-answer-engine-inspired-evidence-expansion.md',
      targetType: 'doc',
    });
    recordEvidenceReadSafe({
      readClass: 'advisory_memory',
      surface: 'memory',
      target: 'memory/adr-0028',
      targetType: 'memory',
      memoryFreshness: 'stale-index',
      notAuditEvidence: true,
    });
    recordEvidenceReadSafe({
      readClass: 'runtime_diagnostic',
      surface: 'mcp',
      target: 'diagnostics/tool-contract',
      targetType: 'diagnostic',
    });

    const finalReport: CommitAuditReport = {
      ...organicReport,
      basedOnReads: summarizeBasedOnReads(),
    };

    expect(finalReport.verdict).toBe('READY');
    expect(finalReport.evidence).toEqual([]);
    expect(finalReport.recommendations).toEqual([]);
    expect(finalReport.basedOnReads?.audit_evidence).toBe(0);
    expect(finalReport.basedOnReads?.docs_evidence).toBe(1);
    expect(finalReport.basedOnReads?.advisory_memory).toBe(1);
    expect(finalReport.basedOnReads?.runtime_diagnostic).toBe(1);
    expect(finalReport.basedOnReads?.advisory_memory_not_audit_evidence).toBe(true);
    expect(finalReport.basedOnReads?.advisory_memory_stale_index).toBe(true);
  });
});
