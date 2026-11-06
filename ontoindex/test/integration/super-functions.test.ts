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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDir } from '../helpers/test-db.js';
import { initLbug, closeLbug } from '../../src/mcp/core/lbug-adapter.js';
import { gnExplore } from '../../src/mcp/super/explore.js';
import { withCommittedRead } from '../../src/mcp/local/backend-overlay.js';
import { listRegisteredRepos, readActiveGenerationMeta } from '../../src/storage/repo-manager.js';
import { registryRepoIds, resolveRegistryEntry } from '../../src/mcp/shared/target-context.js';
import { gnExplainModule } from '../../src/mcp/super/explain-module.js';
import { gnFindRelated } from '../../src/mcp/super/find-related.js';
import { gnSafeEditCheck } from '../../src/mcp/super/safe-edit-check.js';
import { gnCanDelete } from '../../src/mcp/super/can-delete.js';
import { gnPreCommitAudit } from '../../src/mcp/super/pre-commit-audit.js';
import { gnSafeRefactor, type RefactorBackend } from '../../src/mcp/super/safe-refactor.js';
import { gnEnsureFresh } from '../../src/mcp/super/ensure-fresh.js';
import { gnQualityMode } from '../../src/mcp/super/quality-mode.js';
import { gnDiffImpact } from '../../src/mcp/super/diff-impact.js';
import { gnDiagnose } from '../../src/mcp/super/diagnose.js';
import { gnProposeLocation } from '../../src/mcp/super/propose-location.js';

// ---------------------------------------------------------------------------
// Repo under test — the OntoIndex monorepo self-index.
// ---------------------------------------------------------------------------

const REPO_ID = 'OntoIndex';
const CHECKOUT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LBUG_PATH = path.join(CHECKOUT_ROOT, '.ontoindex/lbug');
const SLOW_SUPER_FUNCTION_TIMEOUT_MS = 60_000;
const SLOW_PROPOSE_LOCATION_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Pool lifecycle.
// ---------------------------------------------------------------------------

// The self-index is produced by `ontoindex analyze` and is not committed, so a fresh
// checkout has none. Without it the whole file is skipped instead of failing.
const HAS_SELF_INDEX = existsSync(LBUG_PATH);
let committedRepoId: string;
let committedGeneration: string;
let fixtureMetadata: Awaited<ReturnType<typeof readActiveGenerationMeta>> | undefined;

beforeAll(async () => {
  if (!HAS_SELF_INDEX) return;
  const repos = await listRegisteredRepos();
  const selection = resolveRegistryEntry(repos, REPO_ID);
  if (selection.status !== 'ok') throw new Error('Self-index repository must resolve uniquely');
  expect(realpathSync(selection.entry.path)).toBe(realpathSync(CHECKOUT_ROOT));
  expect(realpathSync(selection.entry.storagePath)).toBe(
    realpathSync(path.join(CHECKOUT_ROOT, '.ontoindex')),
  );
  const selected = await readActiveGenerationMeta(selection.entry.storagePath);
  if (selected.authority === 'untrusted' || !selected.meta?.lastCommit) {
    throw new Error('Self-index must have trusted indexed commit metadata');
  }
  expect(
    realpathSync(
      selected.activeGeneration?.lbugPath ?? path.join(selection.entry.storagePath, 'lbug'),
    ),
  ).toBe(realpathSync(LBUG_PATH));
  committedGeneration = selected.activeGeneration?.generationId ?? selected.meta.lastCommit;
  fixtureMetadata = selected;
  committedRepoId = registryRepoIds(repos).get(selection.entry)!;
  await initLbug(REPO_ID, LBUG_PATH);
}, 30_000);

afterAll(async () => {
  try {
    if (fixtureMetadata) {
      const current = await readActiveGenerationMeta(path.join(CHECKOUT_ROOT, '.ontoindex'));
      expect(current.authority).not.toBe('untrusted');
      expect(current.authority).toBe(fixtureMetadata.authority);
      expect(current.activeGeneration?.generationId).toBe(
        fixtureMetadata.activeGeneration?.generationId,
      );
      expect(current.meta?.lastCommit).toBe(fixtureMetadata.meta?.lastCommit);
      expect(current.meta?.indexedAt).toBe(fixtureMetadata.meta?.indexedAt);
    }
  } finally {
    await closeLbug(REPO_ID);
  }
}, 10_000);

// ---------------------------------------------------------------------------
// Test 1: gnExplore — concept-level discovery.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_SELF_INDEX)('gnExplore', () => {
  it(
    'returns a valid ExploreReport shape for a known concept',
    async () => {
      // Select committed evidence; this context alone does not pin a generation.
      const report = await withCommittedRead(committedRepoId, committedGeneration, () =>
        gnExplore(REPO_ID, { query: 'worker-pool', depth: 'shallow', read_mode: 'committed' }),
      );

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
      expect(
        report.warnings.filter((warning) =>
          /enrichment unavailable|query primitive failed/.test(warning),
        ),
      ).toEqual([]);
      expect(report.topSymbols.length).toBeGreaterThan(0);

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
    const report = await withCommittedRead(committedRepoId, committedGeneration, () =>
      gnExplore(REPO_ID, { query: 'worker-pool', depth: 'deep', read_mode: 'committed' }),
    );
    expect(
      report.warnings.filter((warning) =>
        /enrichment unavailable|query primitive failed/.test(warning),
      ),
    ).toEqual([]);
    expect(report.topSymbols.length).toBeGreaterThan(0);
    expect(report.topSymbols.length).toBeLessThanOrEqual(10);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 2: gnExplainModule — file/module overview.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_SELF_INDEX)('gnExplainModule', () => {
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

describe.skipIf(!HAS_SELF_INDEX)('gnFindRelated', () => {
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

    // The self-index topology changes as parser/resolver support evolves; keep
    // this test focused on report shape instead of a fixed edge count.
    if (report.resolvedSymbol.nodeId) {
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

describe.skipIf(!HAS_SELF_INDEX)('env-var invariant', () => {
  afterEach(() => vi.unstubAllEnvs());
  it(
    'gnExplore does not persistently set ONTOINDEX_INTENT_ENSEMBLE',
    async () => {
      // Ensure both are unset before the call
      vi.stubEnv('ONTOINDEX_INTENT_ENSEMBLE', undefined);
      vi.stubEnv('ONTOINDEX_CITATIONS', undefined);

      const report = await withCommittedRead(committedRepoId, committedGeneration, () =>
        gnExplore(REPO_ID, { query: 'worker-pool', depth: 'shallow', read_mode: 'committed' }),
      );
      expect(
        report.warnings.filter((warning) =>
          /enrichment unavailable|query primitive failed/.test(warning),
        ),
      ).toEqual([]);

      expect(process.env.ONTOINDEX_INTENT_ENSEMBLE).toBeUndefined();
      expect(process.env.ONTOINDEX_CITATIONS).toBeUndefined();
    },
    SLOW_SUPER_FUNCTION_TIMEOUT_MS,
  );

  it(
    'gnExplore restores pre-existing env vars after call',
    async () => {
      const sentinelEnsemble = '__test_sentinel_ensemble__';
      const sentinelCitations = '__test_sentinel_citations__';
      vi.stubEnv('ONTOINDEX_INTENT_ENSEMBLE', sentinelEnsemble);
      vi.stubEnv('ONTOINDEX_CITATIONS', sentinelCitations);

      const report = await withCommittedRead(committedRepoId, committedGeneration, () =>
        gnExplore(REPO_ID, { query: 'worker-pool', depth: 'shallow', read_mode: 'committed' }),
      );
      expect(
        report.warnings.filter((warning) =>
          /enrichment unavailable|query primitive failed/.test(warning),
        ),
      ).toEqual([]);

      expect(process.env.ONTOINDEX_INTENT_ENSEMBLE).toBe(sentinelEnsemble);
      expect(process.env.ONTOINDEX_CITATIONS).toBe(sentinelCitations);
    },
    SLOW_SUPER_FUNCTION_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Test 5 (Phase 2 W2d): gnSafeEditCheck — pre-edit risk synthesis.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_SELF_INDEX)('gnSafeEditCheck', () => {
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

describe.skipIf(!HAS_SELF_INDEX)('gnCanDelete', () => {
  it('returns DO-NOT-DELETE for mergeWithRRF (it has callers)', async () => {
    const report = await gnCanDelete(REPO_ID, { symbol: 'mergeWithRRF' });

    expect(report.version).toBe(1);
    expect(['DELETE-SAFE', 'CAUTION', 'DO-NOT-DELETE']).toContain(report.verdict);
    expect(typeof report.reasoning).toBe('string');

    // Source-reference fallback must block deletion even when the mutable
    // self-index has not captured caller edges for this symbol.
    if (report.symbol.nodeId) {
      expect(report.verdict).toBe('DO-NOT-DELETE');
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

describe.skipIf(!HAS_SELF_INDEX)('gnPreCommitAudit', () => {
  it('returns a valid CommitAuditReport for a guaranteed empty staged diff', async () => {
    const temp = await createTempDir('ontoindex-empty-staged-');
    const previousIndexFile = process.env.GIT_INDEX_FILE;
    let report: Awaited<ReturnType<typeof gnPreCommitAudit>>;
    try {
      process.env.GIT_INDEX_FILE = path.join(temp.dbPath, 'index');
      execFileSync('git', ['read-tree', 'HEAD'], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      });
      report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });
    } finally {
      if (previousIndexFile === undefined) {
        delete process.env.GIT_INDEX_FILE;
      } else {
        process.env.GIT_INDEX_FILE = previousIndexFile;
      }
      await temp.cleanup();
    }

    expect(report.version).toBe(1);
    expect(report.verdict).toBe('READY');
    expect(report.changedFiles).toEqual([]);
    expect(report.evaluation.status).toBe('skipped');
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

describe.skipIf(!HAS_SELF_INDEX)('gnSafeRefactor', () => {
  it('dryRun:true returns preview with applied:false and does not modify files', async () => {
    const repoPath = fileURLToPath(new URL('../../../', import.meta.url));
    const sourcePath = 'ontoindex/src/core/search/hybrid-search.ts';
    const sourceBefore = readFileSync(path.join(repoPath, sourcePath));
    const backend: RefactorBackend = {
      repoPath,
      async callTool() {
        throw new Error('Dry-run preview must not apply refactor tools');
      },
    };
    const report = await gnSafeRefactor(
      REPO_ID,
      {
        intent: 'rename',
        symbol: 'mergeWithRRF',
        params: { newName: 'mergeWithRRF_dryRunTest' },
        dryRun: true,
        force: true,
      },
      backend,
    );

    expect(report.version).toBe(1);
    expect(report.intent).toBe('rename');
    // applied MUST be false when dryRun: true
    expect(report.applied).toBe(false);
    // preview must be populated
    expect(report.preview).toBeDefined();
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(report.symbol.nodeId).toContain('mergeWithRRF');
    expect(report.preview.diffSummary.length).toBeGreaterThan(0);
    expect(report.preview.affectedFiles).toContain(sourcePath);
    expect(report.preview.estimatedLinesChanged).toBeGreaterThan(0);
    expect(report.warnings.some((w) => w.includes('Could not read rename candidate'))).toBe(false);
    expect(readFileSync(path.join(repoPath, sourcePath))).toEqual(sourceBefore);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 9 (Phase 3 W3d): gnEnsureFresh — staleness check against self-index.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_SELF_INDEX)('gnEnsureFresh', () => {
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

describe.skipIf(!HAS_SELF_INDEX)('gnQualityMode', () => {
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

describe.skipIf(!HAS_SELF_INDEX)('gnDiffImpact', () => {
  it('returns a valid DiffImpactReport for a guaranteed empty staged diff', async () => {
    const temp = await createTempDir('ontoindex-empty-staged-');
    const previousIndexFile = process.env.GIT_INDEX_FILE;
    let report: Awaited<ReturnType<typeof gnDiffImpact>>;
    try {
      process.env.GIT_INDEX_FILE = path.join(temp.dbPath, 'index');
      execFileSync('git', ['read-tree', 'HEAD'], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      });
      report = await gnDiffImpact(REPO_ID, { scope: 'staged' });
    } finally {
      if (previousIndexFile === undefined) {
        delete process.env.GIT_INDEX_FILE;
      } else {
        process.env.GIT_INDEX_FILE = previousIndexFile;
      }
      await temp.cleanup();
    }

    expect(report.changedFiles).toEqual([]);
    expect(report.totalSymbolsChanged).toBe(0);

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

describe.skipIf(!HAS_SELF_INDEX)('gnDiagnose', () => {
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

describe.skipIf(!HAS_SELF_INDEX)('gnProposeLocation', () => {
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
