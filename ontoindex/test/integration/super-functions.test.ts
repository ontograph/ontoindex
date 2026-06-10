/**
 * Integration tests for gn_* super-functions (Phase 1 W1d + Phase 3 W3d + Phase 4 W4d).
 *
 * Runs against the OntoIndex self-index (repoId "OntoIndex") using the real
 * LadybugDB on disk.  Results are asserted on shape and basic invariants —
 * not on exact symbol counts, because the index content depends on when the
 * last `ontoindex analyze` was run.
 *
 * Prerequisites:
 *   - ontoindex self-index exists at ontoindex/.ontoindex/lbug
 *   - `ontoindex analyze` has been run at least once
 *
 * Env-var invariant: super-functions must restore ONTOINDEX_INTENT_ENSEMBLE
 * and ONTOINDEX_CITATIONS to their pre-call values (or delete them if absent).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { initLbug, closeLbug } from '../../src/mcp/core/lbug-adapter.js';
import { gnExplore } from '../../src/mcp/super/explore.js';
import { gnExplainModule } from '../../src/mcp/super/explain-module.js';
import { gnFindRelated } from '../../src/mcp/super/find-related.js';
import { gnSafeEditCheck } from '../../src/mcp/super/safe-edit-check.js';
import { gnCanDelete } from '../../src/mcp/super/can-delete.js';
import { gnPreCommitAudit } from '../../src/mcp/super/pre-commit-audit.js';
import { gnSafeRefactor } from '../../src/mcp/super/safe-refactor.js';
import { gnEnsureFresh } from '../../src/mcp/super/ensure-fresh.js';
import { gnQualityMode } from '../../src/mcp/super/quality-mode.js';
import { gnDiffImpact } from '../../src/mcp/super/diff-impact.js';
import { gnDiagnose } from '../../src/mcp/super/diagnose.js';
import { gnProposeLocation } from '../../src/mcp/super/propose-location.js';

// ---------------------------------------------------------------------------
// Repo under test — the OntoIndex monorepo self-index.
// ---------------------------------------------------------------------------

const REPO_ID = 'OntoIndex';
const LBUG_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../.ontoindex/lbug',
);
const SLOW_SUPER_FUNCTION_TIMEOUT_MS = 60_000;
const SLOW_PROPOSE_LOCATION_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Pool lifecycle.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initLbug(REPO_ID, LBUG_PATH);
}, 30_000);

afterAll(async () => {
  try {
    await closeLbug(REPO_ID);
  } catch {
    // best-effort
  }
}, 10_000);

// ---------------------------------------------------------------------------
// Test 1: gnExplore — concept-level discovery.
// ---------------------------------------------------------------------------

describe('gnExplore', () => {
  it(
    'returns a valid ExploreReport shape for a known concept',
    async () => {
      const report = await gnExplore(REPO_ID, { query: 'worker-pool', depth: 'shallow' });

      expect(report.version).toBe(1);
      expect(report.query.original).toBe('worker-pool');
      expect(report.query.classified).toHaveProperty('intent');
      expect(report.query.classified).toHaveProperty('confidence');
      expect(typeof report.query.classified.confidence).toBe('number');

      expect(Array.isArray(report.topSymbols)).toBe(true);
      expect(Array.isArray(report.topProcesses)).toBe(true);
      expect(Array.isArray(report.clusters)).toBe(true);
      expect(Array.isArray(report.suggestedEntryPoints)).toBe(true);
      expect(Array.isArray(report.warnings)).toBe(true);

      // depth: 'shallow' limits to ≤3 topSymbols
      expect(report.topSymbols.length).toBeLessThanOrEqual(3);

      // Each topSymbol must conform to the shape
      for (const sym of report.topSymbols) {
        expect(typeof sym.nodeId).toBe('string');
        expect(typeof sym.name).toBe('string');
        expect(typeof sym.filePath).toBe('string');
        expect(typeof sym.cluster).toBe('string');
        expect(Array.isArray(sym.coChangedFiles)).toBe(true);
      }

      // suggestedEntryPoints entries must have type + nodeId + rationale
      for (const ep of report.suggestedEntryPoints) {
        expect(['process', 'symbol', 'file']).toContain(ep.type);
        expect(typeof ep.nodeId).toBe('string');
        expect(typeof ep.rationale).toBe('string');
      }
    },
    SLOW_SUPER_FUNCTION_TIMEOUT_MS,
  );

  it('depth: deep returns ≤10 topSymbols', async () => {
    const report = await gnExplore(REPO_ID, { query: 'worker-pool', depth: 'deep' });
    expect(report.topSymbols.length).toBeLessThanOrEqual(10);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 2: gnExplainModule — file/module overview.
// ---------------------------------------------------------------------------

describe('gnExplainModule', () => {
  it('returns a valid ExplainModuleReport for an indexed file', async () => {
    // ontoindex/src/mcp/local/backend-search.ts is stable in the monorepo index.
    const report = await gnExplainModule(REPO_ID, {
      filePath: 'ontoindex/src/mcp/local/backend-search.ts',
    });

    expect(report.version).toBe(1);
    expect(report.filePath).toBe('ontoindex/src/mcp/local/backend-search.ts');
    expect(Array.isArray(report.publicAPI)).toBe(true);
    expect(Array.isArray(report.coChangedFiles)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(report.fileStats).toHaveProperty('lineCount');
    expect(report.fileStats).toHaveProperty('symbolCount');
    expect(report.fileStats).toHaveProperty('importCount');
    expect(report.recentlyTouched).toHaveProperty('lastCommitDate');
    expect(report.recentlyTouched).toHaveProperty('daysAgo');

    // publicAPI must be non-empty for a file with known exports
    expect(report.publicAPI.length).toBeGreaterThan(0);

    // publicAPI entries must have name and kind
    for (const sym of report.publicAPI) {
      expect(typeof sym.name).toBe('string');
      expect(['Function', 'Class', 'Const', 'Interface', 'TypeAlias', 'Variable']).toContain(
        sym.kind,
      );
    }
  }, 30_000);

  it('publicAPI includes applyEnsemble for per-intent-ensemble.ts', async () => {
    // Verifies DEFINES-based publicAPI query works for exported Function/Interface nodes.
    // Note: exported Const nodes (e.g. INTENT_WEIGHTS) use a schema without isExported
    // and are excluded by the WHERE s.isExported = true filter — that is a schema gap,
    // not a query bug.
    const report = await gnExplainModule(REPO_ID, {
      filePath: 'ontoindex/src/core/search/per-intent-ensemble.ts',
    });

    expect(report.version).toBe(1);
    expect(report.publicAPI.length).toBeGreaterThan(0);

    const names = report.publicAPI.map((s) => s.name);
    expect(names).toContain('applyEnsemble');
  }, 30_000);

  it('returns a warning and empty publicAPI for a file not in the index', async () => {
    const report = await gnExplainModule(REPO_ID, {
      filePath: 'does/not/exist.ts',
    });

    expect(report.version).toBe(1);
    expect(Array.isArray(report.publicAPI)).toBe(true);
    expect(report.publicAPI).toHaveLength(0);
    expect(report.warnings.some((w) => w.includes('not in index'))).toBe(true);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Test 3: gnFindRelated — symbol-level neighborhood.
// ---------------------------------------------------------------------------

describe('gnFindRelated', () => {
  it('returns a valid FindRelatedReport for mergeWithRRF', async () => {
    const report = await gnFindRelated(REPO_ID, { symbol: 'mergeWithRRF' });

    expect(report.version).toBe(1);
    expect(typeof report.resolvedSymbol.nodeId).toBe('string');
    expect(typeof report.resolvedSymbol.name).toBe('string');
    expect(Array.isArray(report.callers)).toBe(true);
    expect(Array.isArray(report.callees)).toBe(true);
    expect(Array.isArray(report.coChangedFiles)).toBe(true);
    expect(Array.isArray(report.clusterSiblings)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);

    // mergeWithRRF is called by multiple scripts — should have callers
    if (report.resolvedSymbol.nodeId) {
      expect(report.callers.length).toBeGreaterThan(0);
      // Each caller must have shape
      for (const caller of report.callers) {
        expect(typeof caller.nodeId).toBe('string');
        expect(typeof caller.name).toBe('string');
        expect(['CALLS', 'REFERENCES']).toContain(caller.relationshipKind);
      }
    } else {
      // symbol not found — graceful warning
      expect(report.warnings.some((w) => w.includes('not found'))).toBe(true);
    }
  }, 30_000);

  it('returns a graceful report for an unknown symbol', async () => {
    const report = await gnFindRelated(REPO_ID, {
      symbol: 'zzz_definitely_does_not_exist_xyz',
    });

    expect(report.version).toBe(1);
    expect(report.resolvedSymbol.nodeId).toBe('');
    expect(report.callers).toHaveLength(0);
    expect(report.callees).toHaveLength(0);
    expect(report.warnings.some((w) => w.includes('not found'))).toBe(true);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Test 4: env-var management — no persistent side effects.
// ---------------------------------------------------------------------------

describe('env-var invariant', () => {
  it(
    'gnExplore does not persistently set ONTOINDEX_INTENT_ENSEMBLE',
    async () => {
      const prevEnsemble = process.env.ONTOINDEX_INTENT_ENSEMBLE;
      const prevCitations = process.env.ONTOINDEX_CITATIONS;

      // Ensure both are unset before the call
      delete process.env.ONTOINDEX_INTENT_ENSEMBLE;
      delete process.env.ONTOINDEX_CITATIONS;

      await gnExplore(REPO_ID, { query: 'worker-pool', depth: 'shallow' });

      expect(process.env.ONTOINDEX_INTENT_ENSEMBLE).toBeUndefined();
      expect(process.env.ONTOINDEX_CITATIONS).toBeUndefined();

      // Restore original state for any following tests
      if (prevEnsemble !== undefined) process.env.ONTOINDEX_INTENT_ENSEMBLE = prevEnsemble;
      if (prevCitations !== undefined) process.env.ONTOINDEX_CITATIONS = prevCitations;
    },
    SLOW_SUPER_FUNCTION_TIMEOUT_MS,
  );

  it(
    'gnExplore restores pre-existing env vars after call',
    async () => {
      const sentinelEnsemble = '__test_sentinel_ensemble__';
      const sentinelCitations = '__test_sentinel_citations__';
      process.env.ONTOINDEX_INTENT_ENSEMBLE = sentinelEnsemble;
      process.env.ONTOINDEX_CITATIONS = sentinelCitations;

      await gnExplore(REPO_ID, { query: 'worker-pool', depth: 'shallow' });

      expect(process.env.ONTOINDEX_INTENT_ENSEMBLE).toBe(sentinelEnsemble);
      expect(process.env.ONTOINDEX_CITATIONS).toBe(sentinelCitations);

      // Clean up
      delete process.env.ONTOINDEX_INTENT_ENSEMBLE;
      delete process.env.ONTOINDEX_CITATIONS;
    },
    SLOW_SUPER_FUNCTION_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Test 5 (Phase 2 W2d): gnSafeEditCheck — pre-edit risk synthesis.
// ---------------------------------------------------------------------------

describe('gnSafeEditCheck', () => {
  it('returns a valid EditCheckReport with verdict and blastRadius for mergeWithRRF', async () => {
    const report = await gnSafeEditCheck(REPO_ID, { symbol: 'mergeWithRRF' });

    expect(report.version).toBe(1);
    expect(['SAFE', 'CAUTION', 'DANGEROUS', 'BLOCKED']).toContain(report.verdict);
    expect(typeof report.reasoning).toBe('string');
    expect(report.reasoning.length).toBeGreaterThan(0);

    // blastRadius shape
    expect(typeof report.blastRadius.upstreamCount).toBe('number');
    expect(Array.isArray(report.blastRadius.upstreamFiles)).toBe(true);
    expect(typeof report.blastRadius.downstreamCount).toBe('number');
    expect(typeof report.blastRadius.transitiveImpact.processCount).toBe('number');
    expect(typeof report.blastRadius.transitiveImpact.clusterCount).toBe('number');

    // The self-index topology changes as parser/resolver support evolves; keep
    // this test focused on safe-edit report shape instead of a fixed edge count.
    expect(report.symbol.nodeId).toContain('mergeWithRRF');

    // testCoverage shape
    expect(Array.isArray(report.testCoverage.coveringTests)).toBe(true);
    expect(['HIGH', 'MEDIUM', 'LOW', 'NONE']).toContain(report.testCoverage.likelihoodOfCoverage);

    // preChecks and warnings arrays
    expect(Array.isArray(report.preChecks)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(Array.isArray(report.suggestedNext)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 6 (Phase 2 W2d): gnCanDelete — dead-code safety verdict.
// ---------------------------------------------------------------------------

describe('gnCanDelete', () => {
  it('returns DO-NOT-DELETE for mergeWithRRF (it has callers)', async () => {
    const report = await gnCanDelete(REPO_ID, { symbol: 'mergeWithRRF' });

    expect(report.version).toBe(1);
    expect(['DELETE-SAFE', 'CAUTION', 'DO-NOT-DELETE']).toContain(report.verdict);
    expect(typeof report.reasoning).toBe('string');

    // mergeWithRRF is called by multiple scripts — verdict should block deletion
    if (report.symbol.nodeId) {
      expect(report.verdict).toBe('DO-NOT-DELETE');
      expect(report.callers.length).toBeGreaterThan(0);
      for (const caller of report.callers) {
        expect(typeof caller.nodeId).toBe('string');
        expect(typeof caller.name).toBe('string');
        expect(typeof caller.filePath).toBe('string');
      }
    } else {
      // symbol not indexed — graceful DELETE-SAFE + warning
      expect(report.verdict).toBe('DELETE-SAFE');
      expect(report.warnings.some((w) => w.includes('not in index'))).toBe(true);
    }

    expect(Array.isArray(report.blockers)).toBe(true);
    expect(Array.isArray(report.tests)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 7 (Phase 2 W2d): gnPreCommitAudit — ship-readiness verdict.
// ---------------------------------------------------------------------------

describe('gnPreCommitAudit', () => {
  it('returns a valid CommitAuditReport for staged scope on a clean tree', async () => {
    // The working tree is clean on main (no staged changes) — expect READY.
    // If there are staged changes (unlikely in CI), the verdict may be REVIEW or
    // DO-NOT-COMMIT, which is also acceptable.
    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.version).toBe(1);
    expect(['READY', 'REVIEW', 'DO-NOT-COMMIT']).toContain(report.verdict);
    expect(typeof report.reasoning).toBe('string');
    expect(Array.isArray(report.changedFiles)).toBe(true);
    expect(Array.isArray(report.unexpectedSymbols)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(['ok', 'degraded']).toContain(report.status);
    expect(['fresh', 'stale', 'degraded', 'unknown', 'not-applicable']).toContain(
      report.freshness.status,
    );
    expect(Array.isArray(report.evidence)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);
    expect(Array.isArray(report.affectedProcesses)).toBe(true);
    expect(typeof report.graphSections.processesAvailable).toBe('boolean');
    expect(typeof report.graphSections.hunkCoverageAvailable).toBe('boolean');

    // On a clean staged area, changedFiles should be empty and verdict READY.
    // We only assert shape — not exact verdict — to stay resilient to CI state.
    for (const cf of report.changedFiles) {
      expect(typeof cf.path).toBe('string');
      expect(Array.isArray(cf.changedSymbols)).toBe(true);
      expect(typeof cf.perSymbolImpact.upstream).toBe('number');
      expect(typeof cf.perSymbolImpact.downstream).toBe('number');
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(cf.perSymbolImpact.risk);
    }

    const evidenceIds = new Set(report.evidence.map((entry) => entry.id));
    for (const recommendation of report.recommendations) {
      expect(recommendation.evidenceIds.length).toBeGreaterThan(0);
      for (const evidenceId of recommendation.evidenceIds) {
        expect(evidenceIds.has(evidenceId)).toBe(true);
      }
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 8 (Phase 3 W3d): gnSafeRefactor — dry-run preview without apply.
// ---------------------------------------------------------------------------

describe('gnSafeRefactor', () => {
  it('dryRun:true returns preview with applied:false and does not modify files', async () => {
    const report = await gnSafeRefactor(REPO_ID, {
      intent: 'rename',
      symbol: 'mergeWithRRF',
      params: { newName: 'mergeWithRRF_dryRunTest' },
      dryRun: true,
      force: true,
    });

    expect(report.version).toBe(1);
    expect(report.intent).toBe('rename');
    // applied MUST be false when dryRun: true
    expect(report.applied).toBe(false);
    // preview must be populated
    expect(report.preview).toBeDefined();
    expect(Array.isArray(report.warnings)).toBe(true);

    // If the symbol was resolved, the preview should contain meaningful data.
    if (report.symbol.nodeId) {
      expect(typeof report.preview.diffSummary).toBe('string');
      expect(report.preview.diffSummary.length).toBeGreaterThan(0);
      expect(Array.isArray(report.preview.affectedFiles)).toBe(true);
    } else {
      // symbol not in index — graceful empty preview
      expect(report.warnings.some((w) => w.includes('not found'))).toBe(true);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 9 (Phase 3 W3d): gnEnsureFresh — staleness check against self-index.
// ---------------------------------------------------------------------------

describe('gnEnsureFresh', () => {
  it('returns a valid EnsureFreshReport with preCheck containing both commits', async () => {
    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.version).toBe(1);
    expect(report.preCheck).toBeDefined();
    expect(typeof report.preCheck.indexedCommit).toBe('string');
    expect(typeof report.preCheck.currentCommit).toBe('string');
    expect(typeof report.preCheck.isStale).toBe('boolean');

    // embeddingsStatus must be present
    expect(report.embeddingsStatus).toBeDefined();
    expect(typeof report.embeddingsStatus.count).toBe('number');
    expect(typeof report.embeddingsStatus.required).toBe('boolean');

    // actionsTaken and warnings must be arrays
    expect(Array.isArray(report.actionsTaken)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);

    // Since autoAnalyze was not passed, no actions should have been taken.
    expect(report.actionsTaken).toHaveLength(0);

    // postCheck must be absent (no autoAnalyze)
    expect(report.postCheck).toBeUndefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 10 (Phase 3 W3d): gnQualityMode — env var mutation and restore.
// ---------------------------------------------------------------------------

describe('gnQualityMode', () => {
  // Save and restore process.env around each test — gnQualityMode mutates it.
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {
      ONTOINDEX_INTENT_ENSEMBLE: process.env.ONTOINDEX_INTENT_ENSEMBLE,
      ONTOINDEX_CITATIONS: process.env.ONTOINDEX_CITATIONS,
      ONTOINDEX_LSP_REFERENCES: process.env.ONTOINDEX_LSP_REFERENCES,
      ONTOINDEX_VEC_POOL_MIN: process.env.ONTOINDEX_VEC_POOL_MIN,
    };
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it('level:balanced sets ONTOINDEX_INTENT_ENSEMBLE and ONTOINDEX_CITATIONS to "1"', () => {
    // Ensure keys are absent before the call
    delete process.env.ONTOINDEX_INTENT_ENSEMBLE;
    delete process.env.ONTOINDEX_CITATIONS;

    const report = gnQualityMode({ level: 'balanced' });

    expect(report.version).toBe(1);
    expect(report.appliedMode).toBe('balanced');
    expect(Array.isArray(report.warnings)).toBe(true);

    // Must set both flags
    expect(process.env.ONTOINDEX_INTENT_ENSEMBLE).toBe('1');
    expect(process.env.ONTOINDEX_CITATIONS).toBe('1');

    // envVarsSet must reflect both
    expect(report.envVarsSet['ONTOINDEX_INTENT_ENSEMBLE']).toBe('1');
    expect(report.envVarsSet['ONTOINDEX_CITATIONS']).toBe('1');
  });

  it('level:fast clears previously set flags', () => {
    process.env.ONTOINDEX_INTENT_ENSEMBLE = '1';
    process.env.ONTOINDEX_CITATIONS = '1';

    const report = gnQualityMode({ level: 'fast' });

    expect(report.version).toBe(1);
    expect(report.appliedMode).toBe('fast');
    expect(process.env.ONTOINDEX_INTENT_ENSEMBLE).toBeUndefined();
    expect(process.env.ONTOINDEX_CITATIONS).toBeUndefined();
    expect(report.envVarsCleared).toContain('ONTOINDEX_INTENT_ENSEMBLE');
    expect(report.envVarsCleared).toContain('ONTOINDEX_CITATIONS');
  });
});

// ---------------------------------------------------------------------------
// Test 11 (Phase 4 W4d): gnDiffImpact — PR blast-radius report.
// ---------------------------------------------------------------------------

describe('gnDiffImpact', () => {
  it('returns a valid DiffImpactReport for staged scope (works on empty staged diff)', async () => {
    // scope: 'staged' is safe to run in any CI state — an empty staged area
    // yields an empty changedFiles list and no error.
    const report = await gnDiffImpact(REPO_ID, { scope: 'staged' });

    expect(report.version).toBe(1);
    expect(typeof report.commitRange).toBe('string');
    expect(Array.isArray(report.changedFiles)).toBe(true);
    expect(Array.isArray(report.affectedProcesses)).toBe(true);
    expect(typeof report.totalSymbolsChanged).toBe('number');
    expect(Array.isArray(report.highRiskSymbols)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(Array.isArray(report.warningDetails)).toBe(true);
    expect(Array.isArray(report.evidence)).toBe(true);
    expect(report.capabilityState).toBeDefined();
    expect(typeof report.capabilityState.freshness.status).toBe('string');

    // testCoverageDelta shape
    expect(report.testCoverageDelta).toBeDefined();
    expect(typeof report.testCoverageDelta.coveredBefore).toBe('number');
    expect(typeof report.testCoverageDelta.coveredAfter).toBe('number');
    expect(typeof report.testCoverageDelta.deltaPp).toBe('number');

    // changedFiles entries must conform to shape
    for (const cf of report.changedFiles) {
      expect(typeof cf.path).toBe('string');
      expect(typeof cf.addedLines).toBe('number');
      expect(typeof cf.removedLines).toBe('number');
      expect(Array.isArray(cf.evidenceIds)).toBe(true);
      expect(Array.isArray(cf.changedSymbols)).toBe(true);
      for (const sym of cf.changedSymbols) {
        expect(typeof sym.nodeId).toBe('string');
        expect(typeof sym.name).toBe('string');
        expect(Array.isArray(sym.evidenceIds)).toBe(true);
        expect(['LOW', 'MEDIUM', 'HIGH']).toContain(sym.impact.risk);
        expect(typeof sym.impact.upstreamCount).toBe('number');
        expect(typeof sym.impact.downstreamCount).toBe('number');
      }
    }

    for (const recommendation of report.recommendations) {
      expect(Array.isArray(recommendation.evidenceIds)).toBe(true);
      expect(recommendation.evidenceIds.length).toBeGreaterThan(0);
    }

    // highRiskSymbols must be strings
    for (const sym of report.highRiskSymbols) {
      expect(typeof sym).toBe('string');
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 12 (Phase 4 W4d): gnDiagnose — read-only system-status report.
// ---------------------------------------------------------------------------

describe('gnDiagnose', () => {
  it('returns a valid DiagnoseReport with indexFreshness + envVars + recommendations', async () => {
    const report = await gnDiagnose(REPO_ID, {});

    expect(report.version).toBe(1);

    // indexFreshness must be present (checkIndexFreshness defaults to true)
    expect(report.indexFreshness).toBeDefined();
    expect(typeof report.indexFreshness!.isStale).toBe('boolean');
    expect(typeof report.indexFreshness!.indexedCommit).toBe('string');
    expect(typeof report.indexFreshness!.currentCommit).toBe('string');

    // envVars must be a record (may be empty if no ONTOINDEX_* vars are set)
    expect(report.envVars).toBeDefined();
    expect(typeof report.envVars).toBe('object');

    // recommendations must be an array with valid shape
    expect(Array.isArray(report.recommendations)).toBe(true);
    for (const rec of report.recommendations) {
      expect(['INFO', 'WARN', 'ERROR']).toContain(rec.severity);
      expect(typeof rec.detail).toBe('string');
      expect(typeof rec.fix).toBe('string');
    }

    // warnings must be an array
    expect(Array.isArray(report.warnings)).toBe(true);

    // embeddings must be present (checkEmbeddings defaults to true)
    expect(report.embeddings).toBeDefined();
    expect(typeof report.embeddings!.count).toBe('number');
    expect(typeof report.embeddings!.populated).toBe('boolean');

    // lspAvailable must be present (checkLsp defaults to true)
    expect(report.lspAvailable).toBeDefined();
    expect(typeof report.lspAvailable!.typescript).toBe('boolean');
    expect(typeof report.lspAvailable!.python).toBe('boolean');
    expect(typeof report.lspAvailable!.rust).toBe('boolean');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 13 (Phase 4 W4d): gnProposeLocation — where-to-add-new-code suggester.
// ---------------------------------------------------------------------------

describe('gnProposeLocation', () => {
  it(
    'returns a valid ProposeLocationReport with 0+ candidates (no warning when index has data)',
    async () => {
      const report = await gnProposeLocation(REPO_ID, { intent: 'test feature handler' });

      expect(report.version).toBe(1);
      expect(report.intent).toBe('test feature handler');
      expect(Array.isArray(report.candidates)).toBe(true);
      expect(Array.isArray(report.warnings)).toBe(true);

      // candidates shape (may be empty if explore finds no clusters)
      for (const candidate of report.candidates) {
        expect(typeof candidate.directory).toBe('string');
        expect(typeof candidate.suggestedFilename).toBe('string');
        expect(typeof candidate.rationale).toBe('string');
        expect(Array.isArray(candidate.siblingFiles)).toBe(true);
        for (const sibling of candidate.siblingFiles) {
          expect(typeof sibling).toBe('string');
        }
        if (candidate.matchedCluster !== undefined) {
          expect(typeof candidate.matchedCluster).toBe('string');
        }
        if (candidate.importPattern !== undefined) {
          expect(typeof candidate.importPattern).toBe('string');
        }
      }

      // When the index has data, explore should not emit an outright failure warning.
      // (A warning about "no clusters found" is acceptable only if the index is empty.)
      const fatalWarnings = report.warnings.filter((w) => w.startsWith('explore failed:'));
      expect(fatalWarnings).toHaveLength(0);
    },
    SLOW_PROPOSE_LOCATION_TIMEOUT_MS,
  );
});
