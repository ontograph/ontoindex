/**
 * CLI `export` command group — REV-6.
 *
 * Adds `ontoindex export review-bundle --target <ref> --out <dir>` for deterministic
 * local snapshot exports.  The bundle reuses the stable review-diff/report envelope
 * and the target/freshness/provenance data already produced by the review machinery.
 *
 * Output lives under `.ontoindex/review/` by default (already gitignored).
 * Exported artifacts are clearly labelled as disposable snapshots, not canonical
 * graph state.
 *
 * ADR 0020 § 2 (Static review bundle export).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';

import { getGitRoot } from '../storage/git.js';
import { getStoragePaths, loadMeta } from '../storage/repo-manager.js';
import { formatIndexCapabilityWarnings } from '../storage/index-capabilities.js';
import { initLbug, closeLbug } from '../core/lbug/pool-adapter.js';
import { buildDiffReview } from '../core/review/diff-review.js';
import type { DiffReviewResult, ReviewFile } from '../core/review/review-types.js';
import { resolveTargetContext } from '../mcp/shared/target-context.js';
import type { TargetContext } from '../mcp/shared/target-context.js';
import { runCommunityEvidencePack } from '../mcp/local/backend-community-evidence-pack.js';
import {
  deriveEnvelopeFreshness,
  type CapabilityResponseFreshness,
} from '../mcp/shared/response-envelope.js';
import { buildReviewDiffArgs, parseReviewNumstat } from './review.js';
import {
  LocalSidecarStore,
  getSidecarStorePath,
  type SidecarStoreState,
} from '../core/ingestion/enrichment/sidecar-store.js';
import {
  createDocsSidecarStatusReport,
  createMissingDocsSidecarStatusReport,
  createDocsSourceIndexIdentity,
  getDocsSidecarStaleReasons,
} from '../core/ingestion/enrichment/docs-sidecar-status.js';
import {
  createMarkdownKnowledgeReport,
  normalizeMarkdownKnowledgeDiagnosticSidecarStatus,
  type MarkdownKnowledgeReportItem,
} from '../core/ingestion/enrichment/markdown-knowledge-report.js';
import type { DocsReportEnvelope } from '../core/ingestion/enrichment/docs-contracts.js';
import type { MarkdownDocumentFact } from '../core/ingestion/enrichment/markdown-document-facts.js';
import type { MarkdownDocResolutionRecord } from '../core/ingestion/enrichment/markdown-doc-resolver.js';
import {
  isEvidenceDiagnosticTruncationReason,
  numericEvidenceDiagnosticSummaryValue,
  renderEvidenceDiagnosticGroup,
  renderEvidenceDiagnosticSummaryLine,
  summarizeEvidenceDiagnostics,
  type EvidenceDiagnosticQualityKind,
  type EvidenceDiagnosticRecord,
  type EvidenceDiagnostics,
} from '../core/runtime/evidence-diagnostics.js';
import {
  evaluateSemanticContracts,
  summarizeSemanticContractResult,
  type SemanticContractResult,
  type SemanticContractViolation,
} from '../core/runtime/semantic-contracts.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_CHANGED_PATHS = 500;
const MAX_DIAGNOSTIC_RECORDS = 50;
const MAX_DOCS_KNOWLEDGE_DIAGNOSTIC_ITEMS = 10;
const MAX_DOCS_KNOWLEDGE_DIAGNOSTIC_EVIDENCE = 2;
const MAX_SEMANTIC_CONTRACT_VIOLATIONS = 10;
/** Bump when the bundle file schema changes in a backwards-incompatible way. */
const BUNDLE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportReviewBundleOptions {
  target?: string;
  out?: string;
  repo?: string;
  base?: string;
  head?: string;
  range?: string;
  staged?: boolean;
}

/** Top-level metadata written to every artifact in the bundle. */
export interface BundleProvenance {
  schemaVersion: number;
  generatedAt: string;
  targetRef: string;
  targetHead: string | null;
  indexedHead: string | null;
  indexedAt: string | null;
  dirtyWorktree: boolean | null;
  freshnessStatus: string;
  freshnessReason: string;
  snapshotMode: string;
  warnings: string[];
}

/** Sidecar status data surfaced in the review bundle (disposable snapshot). */
export interface SidecarStatusSummary {
  status: string;
  staleReasons: string[];
  degradedReasons: Record<string, number>;
  summary: Record<string, unknown>;
  warnings: string[];
}

export interface ReviewBundleDiagnosticRecord extends EvidenceDiagnosticRecord {
  category: 'code-graph' | 'docs' | 'review' | 'runtime' | 'ranked-discovery';
  kind: EvidenceDiagnosticQualityKind;
  source: 'code' | 'graph' | 'docs-sidecar' | 'review' | 'freshness';
  authority: 'authoritative' | 'advisory';
  subject: string;
  reason: string;
  count?: number;
  freshness?: string;
  advisory: boolean;
  ambiguous?: boolean;
  degraded?: boolean;
  truncated?: boolean;
  linkedFiles?: string[];
  linkedSymbols?: string[];
  linkedGraphIdentities?: string[];
}

export type ReviewBundleDiagnostics = EvidenceDiagnostics<ReviewBundleDiagnosticRecord>;

export interface ReviewBundleSemanticContracts {
  schemaVersion: 1;
  passed: boolean;
  text: string;
  summary: SemanticContractResult['summary'];
  violations: SemanticContractViolation[];
  bounded: {
    maxViolations: number;
    omittedViolations: number;
    evidenceOmitted: boolean;
    omittedEvidenceCount: number;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Build the sidecar-status.json artifact from provenance and sidecar data. */
export function buildSidecarStatusArtifact(
  provenance: BundleProvenance,
  sidecarStatus: SidecarStatusSummary,
): Record<string, unknown> {
  return {
    _note: 'Snapshot artifact — not canonical graph state',
    provenance,
    sidecar: sidecarStatus,
  };
}

/** Sanitise a git ref for use as a directory name component. */
export function sanitizeRefForPath(ref: string): string {
  return (
    ref
      .replace(/^refs\//, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 64) || 'HEAD'
  );
}

/** Build provenance from resolved target context and freshness. */
export function buildBundleProvenance(
  targetContext: TargetContext,
  freshness: CapabilityResponseFreshness,
  indexedAt: string | null,
  warnings: string[],
): BundleProvenance {
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    targetRef: targetContext.targetRef,
    targetHead: targetContext.targetHead ?? null,
    indexedHead: targetContext.indexedHead ?? null,
    indexedAt,
    dirtyWorktree: targetContext.dirtyWorktree,
    freshnessStatus: freshness.status,
    freshnessReason: freshness.reason,
    snapshotMode: targetContext.snapshotMode,
    warnings: [...new Set([...targetContext.warnings, ...warnings])],
  };
}

export function buildReviewBundleDiagnostics(
  provenance: BundleProvenance,
  reviewResult: DiffReviewResult | null,
  sidecarStatus?: SidecarStatusSummary,
  docsKnowledgeReport?: DocsReportEnvelope<MarkdownKnowledgeReportItem>,
): ReviewBundleDiagnostics {
  const records: ReviewBundleDiagnosticRecord[] = [];
  const graphIsFresh = provenance.freshnessStatus === 'fresh';

  const addRecord = (record: ReviewBundleDiagnosticRecord): void => {
    records.push(record);
  };

  if (graphIsFresh) {
    addRecord({
      category: 'code-graph',
      kind: 'extracted',
      source: 'freshness',
      authority: 'authoritative',
      subject: 'target/index freshness',
      reason: provenance.freshnessReason,
      freshness: provenance.freshnessStatus,
      advisory: false,
    });
  } else {
    addRecord({
      category: 'runtime',
      kind: provenance.freshnessStatus === 'stale' ? 'stale' : 'degraded',
      source: 'freshness',
      authority: 'advisory',
      subject: 'target/index freshness',
      reason: provenance.freshnessReason,
      freshness: provenance.freshnessStatus,
      advisory: true,
      degraded: true,
    });
  }

  if (reviewResult) {
    addRecord({
      category: 'code-graph',
      kind: 'extracted',
      source: 'code',
      authority: 'authoritative',
      subject: 'changed files',
      reason: 'git diff reviewed files',
      count: reviewResult.reviewedFiles.length,
      advisory: false,
    });

    if (reviewResult.totalSymbolsChanged > 0) {
      addRecord({
        category: 'code-graph',
        kind: graphIsFresh ? 'extracted' : 'degraded',
        source: 'graph',
        authority: graphIsFresh ? 'authoritative' : 'advisory',
        subject: 'changed symbols',
        reason: graphIsFresh
          ? 'changed symbols resolved from the current graph index'
          : 'changed symbols came from a non-fresh graph index',
        count: reviewResult.totalSymbolsChanged,
        freshness: provenance.freshnessStatus,
        advisory: !graphIsFresh,
        degraded: !graphIsFresh,
      });
    }

    const heuristicSymbols = reviewResult.reviewedFiles.flatMap((file) =>
      file.changedSymbols
        .filter((symbol) => symbol.impact.heuristic)
        .map((symbol) => `${symbol.name} (${file.path})`),
    );
    for (const subject of heuristicSymbols) {
      addRecord({
        category: 'code-graph',
        kind: 'ambiguous',
        source: 'graph',
        authority: 'advisory',
        subject,
        reason: 'impact count used a heuristic single-hop relationship',
        freshness: provenance.freshnessStatus,
        advisory: true,
        ambiguous: true,
      });
    }

    if (reviewResult.highRiskSymbols.length > 0) {
      addRecord({
        category: 'ranked-discovery',
        kind: 'inferred',
        source: 'review',
        authority: 'advisory',
        subject: 'high-risk symbols',
        reason: reviewResult.highRiskSymbols.join(', '),
        count: reviewResult.highRiskSymbols.length,
        freshness: provenance.freshnessStatus,
        advisory: true,
      });
    }

    if (reviewResult.affectedProcesses && reviewResult.affectedProcesses.length > 0) {
      addRecord({
        category: 'code-graph',
        kind: graphIsFresh ? 'extracted' : 'degraded',
        source: 'graph',
        authority: graphIsFresh ? 'authoritative' : 'advisory',
        subject: 'affected execution flows',
        reason: 'changed symbols appear in execution-flow steps',
        count: reviewResult.affectedProcesses.length,
        freshness: provenance.freshnessStatus,
        advisory: !graphIsFresh,
        degraded: !graphIsFresh,
      });
    }

    if (reviewResult.affectedCommunities && reviewResult.affectedCommunities.length > 0) {
      addRecord({
        category: 'code-graph',
        kind: graphIsFresh ? 'extracted' : 'degraded',
        source: 'graph',
        authority: graphIsFresh ? 'authoritative' : 'advisory',
        subject: 'affected communities',
        reason: 'changed symbols appear in graph communities',
        count: reviewResult.affectedCommunities.length,
        freshness: provenance.freshnessStatus,
        advisory: !graphIsFresh,
        degraded: !graphIsFresh,
      });
    }

    for (const reason of reviewResult.crossCommunityRiskReasons ?? []) {
      addRecord({
        category: 'code-graph',
        kind: 'ambiguous',
        source: 'graph',
        authority: 'advisory',
        subject: 'cross-community relationship hint',
        reason,
        freshness: provenance.freshnessStatus,
        advisory: true,
        ambiguous: true,
      });
    }

    for (const reason of reviewResult.warnings) {
      const truncated = isEvidenceDiagnosticTruncationReason(reason);
      addRecord({
        category: 'review',
        kind: truncated ? 'truncated' : 'degraded',
        source: 'review',
        authority: 'advisory',
        subject: 'review warning',
        reason,
        freshness: provenance.freshnessStatus,
        advisory: true,
        degraded: true,
        truncated,
      });
    }
  } else {
    addRecord({
      category: 'code-graph',
      kind: 'degraded',
      source: 'graph',
      authority: 'advisory',
      subject: 'graph analysis',
      reason: 'review result unavailable',
      freshness: provenance.freshnessStatus,
      advisory: true,
      degraded: true,
    });
  }

  for (const reason of provenance.warnings) {
    const truncated = isEvidenceDiagnosticTruncationReason(reason);
    addRecord({
      category: 'review',
      kind: truncated ? 'truncated' : 'degraded',
      source: 'review',
      authority: 'advisory',
      subject: 'bundle warning',
      reason,
      freshness: provenance.freshnessStatus,
      advisory: true,
      degraded: true,
      truncated,
    });
  }

  if (sidecarStatus) {
    const diagnosticSidecarStatus = normalizeMarkdownKnowledgeDiagnosticSidecarStatus(
      sidecarStatus.status,
    );
    const sidecarDegraded = diagnosticSidecarStatus !== 'complete';
    addRecord({
      category: 'docs',
      kind:
        diagnosticSidecarStatus === 'stale' ? 'stale' : sidecarDegraded ? 'degraded' : 'extracted',
      source: 'docs-sidecar',
      authority: 'advisory',
      subject: `docs sidecar ${diagnosticSidecarStatus}`,
      reason: sidecarDegraded
        ? `docs evidence is unavailable or degraded for this bundle (raw status: ${sidecarStatus.status})`
        : 'docs sidecar status is available',
      count: numericEvidenceDiagnosticSummaryValue(sidecarStatus.summary, 'files'),
      advisory: true,
      degraded: sidecarDegraded,
    });

    for (const reason of sidecarStatus.staleReasons) {
      addRecord({
        category: 'docs',
        kind: 'stale',
        source: 'docs-sidecar',
        authority: 'advisory',
        subject: 'docs sidecar stale reason',
        reason,
        advisory: true,
        degraded: true,
      });
    }

    for (const [reason, count] of Object.entries(sidecarStatus.degradedReasons)) {
      if (count > 0) {
        addRecord({
          category: 'docs',
          kind: 'degraded',
          source: 'docs-sidecar',
          authority: 'advisory',
          subject: reason,
          reason: 'docs sidecar degraded record count',
          count,
          advisory: true,
          degraded: true,
        });
      }
    }

    for (const reason of sidecarStatus.warnings) {
      addRecord({
        category: 'docs',
        kind: 'degraded',
        source: 'docs-sidecar',
        authority: 'advisory',
        subject: 'docs sidecar warning',
        reason,
        advisory: true,
        degraded: true,
      });
    }
  }

  if (docsKnowledgeReport) {
    appendDocsKnowledgeDiagnostics(records, docsKnowledgeReport, reviewResult);
  }

  return summarizeDiagnostics(records);
}

export function buildReviewBundleRiskSummaryArtifact(
  provenance: BundleProvenance,
  diagnostics: ReviewBundleDiagnostics,
  reviewResult: DiffReviewResult | null,
  diffRange: string,
  semanticContracts = buildReviewBundleSemanticContracts(provenance, diagnostics, reviewResult),
): Record<string, unknown> {
  return {
    _note: 'Snapshot artifact — not canonical graph state',
    provenance,
    diagnostics,
    semanticContracts,
    diffRange,
    totalFilesChanged: reviewResult?.reviewedFiles.length ?? 0,
    totalSymbolsChanged: reviewResult?.totalSymbolsChanged ?? 0,
    highRiskSymbols: reviewResult?.highRiskSymbols ?? [],
    affectedProcesses: reviewResult?.affectedProcesses ?? [],
    affectedCommunities: reviewResult?.affectedCommunities ?? [],
    crossCommunityRiskReasons: reviewResult?.crossCommunityRiskReasons ?? [],
    reviewedFiles: reviewResult?.reviewedFiles ?? [],
  };
}

export function buildReviewBundleSemanticContracts(
  provenance: BundleProvenance,
  diagnostics: ReviewBundleDiagnostics,
  reviewResult: DiffReviewResult | null = null,
): ReviewBundleSemanticContracts {
  const omittedEvidenceCount = countOmittedEvidence(diagnostics);
  const result = evaluateSemanticContracts({
    diagnostics: diagnostics.records,
    graphFreshness: provenance.freshnessStatus,
    evidenceLinks: buildReviewBundleSemanticEvidenceLinks(reviewResult),
    boundedOutput: {
      evidenceOmitted: omittedEvidenceCount > 0 || diagnostics.summary.truncated > 0,
      omittedEvidenceCount,
    },
    userFacing: true,
  });
  const violations = result.violations.slice(0, MAX_SEMANTIC_CONTRACT_VIOLATIONS);

  return {
    schemaVersion: 1,
    passed: result.passed,
    text: summarizeSemanticContractResult(result),
    summary: result.summary,
    violations,
    bounded: {
      maxViolations: MAX_SEMANTIC_CONTRACT_VIOLATIONS,
      omittedViolations: Math.max(0, result.violations.length - violations.length),
      evidenceOmitted: omittedEvidenceCount > 0 || diagnostics.summary.truncated > 0,
      omittedEvidenceCount,
    },
  };
}

/** Format the REVIEW_REPORT.md content from all bundle data. */
export function formatReviewBundleMarkdown(
  provenance: BundleProvenance,
  reviewResult: DiffReviewResult | null,
  diffRange: string,
  sidecarStatus?: SidecarStatusSummary,
  diagnostics = buildReviewBundleDiagnostics(provenance, reviewResult, sidecarStatus),
  semanticContracts = buildReviewBundleSemanticContracts(provenance, diagnostics, reviewResult),
): string {
  const lines: string[] = [];

  lines.push('# Review Bundle Snapshot');
  lines.push('');
  lines.push(
    '> **Disposable snapshot** — not canonical graph state. ' +
      'Regenerate with `ontoindex export review-bundle`.',
  );
  lines.push('');

  // Provenance table
  lines.push('## Provenance');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| Schema version | ${provenance.schemaVersion} |`);
  lines.push(`| Generated at | ${provenance.generatedAt} |`);
  lines.push(`| Target ref | \`${provenance.targetRef}\` |`);
  lines.push(`| Target HEAD | \`${provenance.targetHead ?? 'unknown'}\` |`);
  lines.push(`| Indexed HEAD | \`${provenance.indexedHead ?? 'unknown'}\` |`);
  lines.push(`| Indexed at | ${provenance.indexedAt ?? 'unknown'} |`);
  lines.push(`| Dirty worktree | ${provenance.dirtyWorktree ?? 'unknown'} |`);
  lines.push(`| Snapshot mode | ${provenance.snapshotMode} |`);
  lines.push('');

  // Freshness
  lines.push('## Freshness');
  lines.push('');
  const freshIcon =
    provenance.freshnessStatus === 'fresh'
      ? '✅'
      : provenance.freshnessStatus === 'stale'
        ? '⚠️'
        : '🔶';
  lines.push(
    `**${freshIcon} ${provenance.freshnessStatus.toUpperCase()}** — ${provenance.freshnessReason}`,
  );
  lines.push('');

  // Docs sidecar status
  if (sidecarStatus) {
    lines.push('## Docs Sidecar');
    lines.push('');
    const sidecarIcon =
      sidecarStatus.status === 'complete'
        ? '✅'
        : sidecarStatus.status === 'missing'
          ? '⬜'
          : sidecarStatus.status === 'stale'
            ? '⚠️'
            : sidecarStatus.status === 'partial'
              ? '🔶'
              : sidecarStatus.status === 'failed'
                ? '❌'
                : '🔵';
    const statusLabel = sidecarStatus.status.toUpperCase();
    lines.push(`**${sidecarIcon} ${statusLabel}**`);
    if (sidecarStatus.staleReasons.length > 0) {
      lines.push('');
      lines.push(`Stale reasons: ${sidecarStatus.staleReasons.join(', ')}`);
    }
    const degradedEntries = Object.entries(sidecarStatus.degradedReasons).filter(([, v]) => v > 0);
    if (degradedEntries.length > 0) {
      lines.push('');
      lines.push(`Degraded: ${degradedEntries.map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
    }
    if (sidecarStatus.warnings.length > 0) {
      lines.push('');
      for (const w of sidecarStatus.warnings) {
        lines.push(`- ⚠ ${w}`);
      }
    }
    lines.push('');
  }

  if (!reviewResult) {
    lines.push('## Graph Analysis');
    lines.push('');
    lines.push('No OntoIndex index found. Run `ontoindex analyze` to enable graph analysis.');
    lines.push('');
  } else {
    // Diff summary
    lines.push('## Diff Summary');
    lines.push('');
    lines.push(`Diff range: \`${diffRange}\``);
    lines.push('');
    lines.push(
      `Files changed: **${reviewResult.reviewedFiles.length}** · ` +
        `Symbols changed: **${reviewResult.totalSymbolsChanged}**`,
    );
    if (reviewResult.highRiskSymbols.length > 0) {
      lines.push('');
      lines.push(
        `**High-risk symbols (${reviewResult.highRiskSymbols.length}):** ` +
          reviewResult.highRiskSymbols.join(', '),
      );
    }
    lines.push('');

    // Per-file symbol table
    const filesWithSymbols = reviewResult.reviewedFiles.filter(
      (f: ReviewFile) => f.changedSymbols.length > 0,
    );
    if (filesWithSymbols.length > 0) {
      lines.push('## Changed Symbols');
      lines.push('');
      for (const file of filesWithSymbols) {
        lines.push(`### \`${file.path}\``);
        if (file.addedLines || file.removedLines) {
          lines.push(`+${file.addedLines} -${file.removedLines}`);
        }
        lines.push('');
        lines.push('| Symbol | Risk | Callers ↑ | Deps ↓ | Heuristic |');
        lines.push('|--------|------|-----------|--------|-----------|');
        for (const sym of file.changedSymbols) {
          lines.push(
            `| \`${sym.name}\` | ${sym.impact.risk} | ${sym.impact.upstreamCount} | ` +
              `${sym.impact.downstreamCount} | ${sym.impact.heuristic ? 'yes' : 'no'} |`,
          );
        }
        lines.push('');
      }
    }

    // Affected processes
    if (reviewResult.affectedProcesses && reviewResult.affectedProcesses.length > 0) {
      lines.push('## Affected Execution Flows');
      lines.push('');
      for (const p of reviewResult.affectedProcesses) {
        lines.push(`- **${p.name}** [${p.processType}]  steps changed: ${p.changedStepCount}`);
      }
      lines.push('');
    }

    // Affected communities
    if (reviewResult.affectedCommunities && reviewResult.affectedCommunities.length > 0) {
      lines.push('## Affected Communities');
      lines.push('');
      for (const c of reviewResult.affectedCommunities) {
        lines.push(`- **${c.name}**  symbols changed: ${c.changedSymbolCount}`);
      }
      lines.push('');
    }

    // Cross-community risk hints
    if (
      reviewResult.crossCommunityRiskReasons &&
      reviewResult.crossCommunityRiskReasons.length > 0
    ) {
      lines.push('## Cross-Community Risk Hints');
      lines.push('');
      for (const r of reviewResult.crossCommunityRiskReasons) {
        lines.push(`- ⚑ ${r}`);
      }
      lines.push('');
    }
  }

  appendSemanticContractsMarkdown(lines, semanticContracts);
  appendDiagnosticsMarkdown(lines, diagnostics);

  // Warnings
  if (provenance.warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of provenance.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    '*This snapshot was generated by `ontoindex export review-bundle`. ' +
      'It is a point-in-time diagnostic artifact and must not be treated as canonical graph state.*',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export async function exportReviewBundleCommand(opts: ExportReviewBundleOptions): Promise<void> {
  const targetRef = opts.target ?? 'HEAD';
  const warnings: string[] = [];

  // ---- 1. Resolve git repo root -------------------------------------------
  let repoRoot: string;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    repoRoot = getGitRoot(process.cwd()) ?? process.cwd();
  }

  // ---- 2. Resolve target context and freshness ----------------------------
  const targetContext = await resolveTargetContext({
    repo: opts.repo ?? repoRoot,
    targetRef,
  });
  const freshness = deriveEnvelopeFreshness(targetContext);

  // ---- 3. Load graph metadata for provenance ------------------------------
  const { storagePath, lbugPath } = getStoragePaths(repoRoot);
  const meta = await loadMeta(storagePath);
  const indexedAt = meta?.indexedAt ?? null;
  if (meta) {
    warnings.push(...formatIndexCapabilityWarnings(meta));
  }

  // ---- 4. Resolve output directory ----------------------------------------
  const defaultOutDir = path.join(repoRoot, '.ontoindex', 'review', sanitizeRefForPath(targetRef));
  const outDir = opts.out ? path.resolve(opts.out) : defaultOutDir;

  fs.mkdirSync(outDir, { recursive: true });

  // ---- 5. Build provenance -------------------------------------------------
  const provenance = buildBundleProvenance(targetContext, freshness, indexedAt, warnings);

  // ---- 6. Run review diff (reuses review.ts machinery) --------------------
  // Diff args inherit --base/--head/--range/--staged from the caller;
  // default to staged (same as `review diff` default) when none are set.
  const diffOpts = {
    base: opts.base,
    head: opts.head,
    range: opts.range,
    staged: opts.staged,
  };
  const { nameOnly, numstat, resolvedRange } = buildReviewDiffArgs(diffOpts);

  let changedPaths: string[] = [];
  try {
    const out = execFileSync('git', nameOnly, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    changedPaths = out.split('\n').filter(Boolean);
    if (changedPaths.length > MAX_CHANGED_PATHS) {
      changedPaths = changedPaths.slice(0, MAX_CHANGED_PATHS);
      warnings.push(`Changed file scan capped at ${MAX_CHANGED_PATHS} paths`);
    }
  } catch (err) {
    warnings.push(
      `git diff failed, diff review skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let numstatMap = new Map<string, { added: number; removed: number }>();
  if (changedPaths.length > 0) {
    try {
      const numstatOut = execFileSync('git', numstat, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      });
      numstatMap = parseReviewNumstat(numstatOut);
    } catch {
      warnings.push('git diff --numstat failed; line counts will be 0');
    }
  }

  // ---- 7. Graph-aware symbol review ---------------------------------------
  let reviewResult: DiffReviewResult | null = null;

  if (meta) {
    const repoId = path.basename(repoRoot).toLowerCase();
    if (changedPaths.length > 0) {
      try {
        await initLbug(repoId, lbugPath);
        const graphResult = await buildDiffReview(repoId, changedPaths, numstatMap);
        warnings.push(...graphResult.warnings);
        reviewResult = { ...graphResult, warnings: [...graphResult.warnings] };
      } catch (err) {
        warnings.push(
          `graph review failed, showing file list only: ${err instanceof Error ? err.message : String(err)}`,
        );
        reviewResult = fileListFallback(changedPaths, numstatMap);
      } finally {
        try {
          await closeLbug(repoId);
        } catch {
          // best-effort
        }
      }
    } else {
      // No diff to review — still emit empty review result so artifacts are written
      reviewResult = {
        reviewedFiles: [],
        totalSymbolsChanged: 0,
        highRiskSymbols: [],
        warnings: [],
      };
    }
  } else {
    warnings.push(
      'no OntoIndex index found; graph analysis unavailable — run `ontoindex analyze` first',
    );
  }

  // Propagate warnings into provenance now that we have the full set
  for (const w of warnings) {
    if (!provenance.warnings.includes(w)) {
      provenance.warnings.push(w);
    }
  }

  // ---- 8a. Load sidecar status --------------------------------------------
  let sidecarStatus: SidecarStatusSummary;
  let docsKnowledgeReport: DocsReportEnvelope<MarkdownKnowledgeReportItem> | undefined;
  if (meta) {
    const sidecarWarnings: string[] = [];
    try {
      const store = new LocalSidecarStore(getSidecarStorePath(storagePath));
      const state = await store.load();
      const identity = createDocsSourceIndexIdentity(
        {
          repoPath: repoRoot,
          lastCommit: meta.lastCommit,
          indexedAt: meta.indexedAt,
          stats: meta.stats,
        },
        repoRoot,
      );
      const currentCommit = targetContext.targetHead ?? null;
      const staleReasons = getDocsSidecarStaleReasons(identity, currentCommit);
      const report = createDocsSidecarStatusReport(
        identity,
        state,
        staleReasons,
        sidecarWarnings,
        state.manifest ?? undefined,
      );
      sidecarStatus = {
        status: report.sidecar.status,
        staleReasons: report.sidecar.staleReasons,
        degradedReasons: report.sidecar.degradedReasons,
        summary: report.summary as Record<string, unknown>,
        warnings: report.warnings,
      };
      docsKnowledgeReport = createMarkdownKnowledgeReport({
        baseReport: report,
        facts: collectMarkdownFacts(state),
        resolutions: collectMarkdownDocResolutionRecords(state),
        maxItems: MAX_DOCS_KNOWLEDGE_DIAGNOSTIC_ITEMS,
        maxCandidatesPerFact: MAX_DOCS_KNOWLEDGE_DIAGNOSTIC_EVIDENCE,
      });
    } catch (err) {
      sidecarWarnings.push(
        `sidecar store unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
      const missing = createMissingDocsSidecarStatusReport(repoRoot);
      sidecarStatus = {
        status: missing.sidecar.status,
        staleReasons: missing.sidecar.staleReasons,
        degradedReasons: missing.sidecar.degradedReasons,
        summary: missing.summary as Record<string, unknown>,
        warnings: [...missing.warnings, ...sidecarWarnings],
      };
    }
  } else {
    const missing = createMissingDocsSidecarStatusReport(repoRoot);
    sidecarStatus = {
      status: missing.sidecar.status,
      staleReasons: missing.sidecar.staleReasons,
      degradedReasons: missing.sidecar.degradedReasons,
      summary: missing.summary as Record<string, unknown>,
      warnings: missing.warnings,
    };
  }

  // ---- 8. Write bundle artifacts -------------------------------------------

  // freshness.json
  const freshnessArtifact = {
    _note: 'Snapshot artifact — not canonical graph state',
    provenance,
    freshness: {
      status: freshness.status,
      actionable: freshness.actionable,
      reason: freshness.reason,
      targetHead: freshness.targetHead ?? null,
      currentHead: freshness.currentHead ?? null,
      indexedHead: freshness.indexedHead ?? null,
      snapshotMode: freshness.snapshotMode ?? null,
    },
  };
  writeJsonArtifact(outDir, 'freshness.json', freshnessArtifact);

  // graph-summary.json
  const graphSummaryArtifact = {
    _note: 'Snapshot artifact — not canonical graph state',
    provenance,
    graphStats: meta?.stats ?? null,
    graphAvailable: meta !== null,
    repoKey: targetContext.repoKey ?? null,
    repoPath: targetContext.repoPath ?? null,
    branch: targetContext.branch ?? null,
    qualityMode: targetContext.qualityMode,
    graphSections: reviewResult?.graphSections ?? null,
  };
  writeJsonArtifact(outDir, 'graph-summary.json', graphSummaryArtifact);

  // risk-summary.json
  const diagnostics = buildReviewBundleDiagnostics(
    provenance,
    reviewResult,
    sidecarStatus,
    docsKnowledgeReport,
  );
  const riskSummaryArtifact = buildReviewBundleRiskSummaryArtifact(
    provenance,
    diagnostics,
    reviewResult,
    resolvedRange,
  );
  writeJsonArtifact(outDir, 'risk-summary.json', riskSummaryArtifact);

  // sidecar-status.json
  writeJsonArtifact(
    outDir,
    'sidecar-status.json',
    buildSidecarStatusArtifact(provenance, sidecarStatus),
  );

  // REVIEW_REPORT.md
  const markdown = formatReviewBundleMarkdown(
    provenance,
    reviewResult,
    resolvedRange,
    sidecarStatus,
    diagnostics,
  );
  fs.writeFileSync(path.join(outDir, 'REVIEW_REPORT.md'), markdown, 'utf8');

  // ---- 9. Print summary ---------------------------------------------------
  const relOut = path.relative(process.cwd(), outDir);
  console.log(`review-bundle exported to: ${relOut}`);
  console.log(`  freshness: ${freshness.status} — ${freshness.reason}`);
  console.log(`  sidecar: ${sidecarStatus.status}`);
  console.log(
    `  artifacts: freshness.json  graph-summary.json  risk-summary.json  sidecar-status.json  REVIEW_REPORT.md`,
  );
  if (provenance.warnings.length > 0) {
    for (const w of provenance.warnings) {
      console.warn(`  warning: ${w}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countOmittedEvidence(diagnostics: ReviewBundleDiagnostics): number {
  return diagnostics.records.reduce((total, record) => {
    if (!record.truncated) return total;
    return total + (typeof record.count === 'number' && record.count > 0 ? record.count : 1);
  }, 0);
}

function buildReviewBundleSemanticEvidenceLinks(reviewResult: DiffReviewResult | null): Array<{
  subject?: string;
  file?: string;
  symbol?: string;
  graphIdentity?: string;
}> {
  const links: Array<{
    subject?: string;
    file?: string;
    symbol?: string;
    graphIdentity?: string;
  }> = [];

  for (const file of reviewResult?.reviewedFiles ?? []) {
    links.push({ subject: 'changed files', file: file.path });
    for (const symbol of file.changedSymbols) {
      links.push({
        subject: 'changed symbols',
        file: file.path,
        symbol: symbol.name,
        graphIdentity: symbol.nodeId,
      });
    }
  }

  return links;
}

function summarizeDiagnostics(records: ReviewBundleDiagnosticRecord[]): ReviewBundleDiagnostics {
  return summarizeEvidenceDiagnostics(records, {
    maxRecords: MAX_DIAGNOSTIC_RECORDS,
    createTruncationRecord: (omitted) => ({
      category: 'runtime',
      kind: 'truncated',
      source: 'review',
      authority: 'advisory',
      subject: 'diagnostics records',
      reason: `diagnostics capped at ${MAX_DIAGNOSTIC_RECORDS} records; ${omitted} omitted`,
      count: omitted,
      advisory: true,
      degraded: true,
      truncated: true,
    }),
  });
}

function appendDocsKnowledgeDiagnostics(
  records: ReviewBundleDiagnosticRecord[],
  report: DocsReportEnvelope<MarkdownKnowledgeReportItem>,
  reviewResult: DiffReviewResult | null,
): void {
  const reviewContext = createDocsDiagnosticReviewContext(reviewResult);
  const emittedItems = report.items.slice(0, MAX_DOCS_KNOWLEDGE_DIAGNOSTIC_ITEMS);
  let skippedUnlinkedItems = 0;

  for (const item of emittedItems) {
    if (!docsKnowledgeItemConnectsToReviewImpact(item, reviewContext)) {
      skippedUnlinkedItems++;
      continue;
    }

    const degraded = item.diagnosticSidecarStatus !== 'complete' || item.freshness === 'stale';
    const kind =
      item.diagnosticSidecarStatus === 'stale' ? 'stale' : degraded ? 'degraded' : 'extracted';
    const freshness = `${item.diagnosticSidecarStatus}/${item.freshness}`;
    const emittedRationale = item.rationaleSnippets.slice(
      0,
      MAX_DOCS_KNOWLEDGE_DIAGNOSTIC_EVIDENCE,
    );
    const emittedSchema = item.schemaEvidence.slice(0, MAX_DOCS_KNOWLEDGE_DIAGNOSTIC_EVIDENCE);
    const linkedEvidence = createDocsKnowledgeLinkedEvidence(item);

    for (const snippet of emittedRationale) {
      records.push({
        category: 'docs',
        kind,
        source: 'docs-sidecar',
        authority: 'advisory',
        subject: `docs rationale: ${item.label}`,
        reason: `${formatDocsEvidenceLocation(snippet.docPath, snippet.lineSpan)} ${truncateDiagnosticText(snippet.excerpt)}`,
        count: item.rationaleSnippets.length,
        freshness,
        advisory: true,
        degraded,
        ...linkedEvidence,
      });
    }

    if (item.rationaleSnippets.length > emittedRationale.length) {
      appendDocsDiagnosticTruncationRecord(records, {
        subject: `docs rationale: ${item.label}`,
        omitted: item.rationaleSnippets.length - emittedRationale.length,
        reason: `docs rationale snippets capped at ${MAX_DOCS_KNOWLEDGE_DIAGNOSTIC_EVIDENCE} per concept`,
        freshness,
      });
    }

    for (const schema of emittedSchema) {
      records.push({
        category: 'docs',
        kind,
        source: 'docs-sidecar',
        authority: 'advisory',
        subject: `docs schema: ${schema.routeKey}`,
        reason: `${formatDocsEvidenceLocation(schema.docPath, schema.lineSpan)} ${truncateDiagnosticText(schema.excerpt)}`,
        count: item.schemaEvidence.length,
        freshness,
        advisory: true,
        degraded,
        ...linkedEvidence,
      });
    }

    if (item.schemaEvidence.length > emittedSchema.length) {
      appendDocsDiagnosticTruncationRecord(records, {
        subject: `docs schema: ${item.label}`,
        omitted: item.schemaEvidence.length - emittedSchema.length,
        reason: `docs schema evidence capped at ${MAX_DOCS_KNOWLEDGE_DIAGNOSTIC_EVIDENCE} per concept`,
        freshness,
      });
    }
  }

  if (skippedUnlinkedItems > 0) {
    records.push({
      category: 'docs',
      kind: 'degraded',
      source: 'docs-sidecar',
      authority: 'advisory',
      subject: 'docs knowledge relevance',
      reason: `${skippedUnlinkedItems} docs knowledge item(s) skipped because they were not linked to changed code evidence`,
      count: skippedUnlinkedItems,
      freshness: report.sidecar.status,
      advisory: true,
      degraded: true,
    });
  }

  if (report.items.length > emittedItems.length) {
    appendDocsDiagnosticTruncationRecord(records, {
      subject: 'docs knowledge items',
      omitted: report.items.length - emittedItems.length,
      reason: `docs knowledge diagnostics capped at ${MAX_DOCS_KNOWLEDGE_DIAGNOSTIC_ITEMS} concepts`,
      freshness: report.sidecar.status,
    });
  }
}

function createDocsKnowledgeLinkedEvidence(
  item: MarkdownKnowledgeReportItem,
): Pick<ReviewBundleDiagnosticRecord, 'linkedFiles' | 'linkedSymbols' | 'linkedGraphIdentities'> {
  const linkedFiles = uniqueNonEmpty(
    item.linkedGraphIdentities.map((identity) => identity.filePath),
  );
  const linkedSymbols = uniqueNonEmpty(item.linkedGraphIdentities.map((identity) => identity.name));
  const linkedGraphIdentities = uniqueNonEmpty(
    item.linkedGraphIdentities.map((identity) => identity.id),
  );
  const linkedEvidence: Pick<
    ReviewBundleDiagnosticRecord,
    'linkedFiles' | 'linkedSymbols' | 'linkedGraphIdentities'
  > = {};

  if (linkedFiles.length > 0) linkedEvidence.linkedFiles = linkedFiles;
  if (linkedSymbols.length > 0) linkedEvidence.linkedSymbols = linkedSymbols;
  if (linkedGraphIdentities.length > 0) {
    linkedEvidence.linkedGraphIdentities = linkedGraphIdentities;
  }

  return linkedEvidence;
}

function uniqueNonEmpty(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

interface DocsDiagnosticReviewContext {
  hasChangedCodeEvidence: boolean;
  changedFilePaths: Set<string>;
  changedSymbolIds: Set<string>;
  changedSymbolNames: Set<string>;
}

function createDocsDiagnosticReviewContext(
  reviewResult: DiffReviewResult | null,
): DocsDiagnosticReviewContext {
  const changedFilePaths = new Set<string>();
  const changedSymbolIds = new Set<string>();
  const changedSymbolNames = new Set<string>();

  for (const file of reviewResult?.reviewedFiles ?? []) {
    changedFilePaths.add(normalizeDiagnosticPath(file.path));
    for (const symbol of file.changedSymbols) {
      changedSymbolIds.add(symbol.nodeId);
      changedSymbolNames.add(symbol.name);
    }
  }

  return {
    hasChangedCodeEvidence: changedSymbolIds.size > 0,
    changedFilePaths,
    changedSymbolIds,
    changedSymbolNames,
  };
}

function docsKnowledgeItemConnectsToReviewImpact(
  item: MarkdownKnowledgeReportItem,
  context: DocsDiagnosticReviewContext,
): boolean {
  if (!context.hasChangedCodeEvidence) return false;

  return item.linkedGraphIdentities.some((identity) => {
    if (
      identity.filePath &&
      context.changedFilePaths.has(normalizeDiagnosticPath(identity.filePath))
    ) {
      return true;
    }
    if (context.changedSymbolIds.has(identity.id)) return true;
    if (identity.name && context.changedSymbolNames.has(identity.name)) return true;
    return false;
  });
}

function appendDocsDiagnosticTruncationRecord(
  records: ReviewBundleDiagnosticRecord[],
  input: {
    subject: string;
    omitted: number;
    reason: string;
    freshness: string;
  },
): void {
  records.push({
    category: 'docs',
    kind: 'truncated',
    source: 'docs-sidecar',
    authority: 'advisory',
    subject: input.subject,
    reason: `${input.reason}; ${input.omitted} omitted`,
    count: input.omitted,
    freshness: input.freshness,
    advisory: true,
    degraded: true,
    truncated: true,
  });
}

function normalizeDiagnosticPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function collectMarkdownFacts(state: SidecarStoreState): MarkdownDocumentFact[] {
  return state.enrichments.flatMap((record) =>
    record.records.filter((fact): fact is MarkdownDocumentFact => isMarkdownDocumentFact(fact)),
  );
}

function collectMarkdownDocResolutionRecords(
  state: SidecarStoreState,
): MarkdownDocResolutionRecord[] {
  return state.enrichments.flatMap((record) =>
    record.records.filter((fact): fact is MarkdownDocResolutionRecord =>
      isMarkdownDocResolutionRecord(fact),
    ),
  );
}

function isMarkdownDocumentFact(value: { kind: string }): value is MarkdownDocumentFact {
  return value.kind.startsWith('markdown-') && value.kind !== 'markdown-doc-resolution';
}

function isMarkdownDocResolutionRecord(value: {
  kind: string;
}): value is MarkdownDocResolutionRecord {
  return value.kind === 'markdown-doc-resolution';
}

function formatDocsEvidenceLocation(
  docPath: string | undefined,
  lineSpan: { start: number; end: number } | undefined,
): string {
  const source = docPath ?? 'unknown-doc';
  if (!lineSpan) return source;
  return `${source}:${lineSpan.start}-${lineSpan.end}`;
}

function truncateDiagnosticText(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function appendSemanticContractsMarkdown(
  lines: string[],
  semanticContracts: ReviewBundleSemanticContracts,
): void {
  lines.push('## Semantic Contracts');
  lines.push('');
  lines.push(semanticContracts.text);

  if (semanticContracts.violations.length > 0) {
    lines.push('');
    for (const violation of semanticContracts.violations) {
      lines.push(
        `- [${violation.contract}] ${violation.subject}: ${violation.reason} ` +
          `(source: ${violation.source}; evidence: ${violation.evidence})`,
      );
    }
  }

  if (semanticContracts.bounded.omittedViolations > 0) {
    lines.push('');
    lines.push(
      `Violation list capped at ${semanticContracts.bounded.maxViolations}; ` +
        `${semanticContracts.bounded.omittedViolations} omitted.`,
    );
  }

  lines.push('');
}

function appendDiagnosticsMarkdown(lines: string[], diagnostics: ReviewBundleDiagnostics): void {
  lines.push('## Evidence Diagnostics');
  lines.push('');
  lines.push(renderEvidenceDiagnosticSummaryLine(diagnostics.summary, ' · '));
  lines.push('');

  lines.push(
    ...renderEvidenceDiagnosticGroup(
      'Authoritative Code/Graph Evidence',
      diagnostics.records.filter(
        (record) => record.authority === 'authoritative' && record.category === 'code-graph',
      ),
    ),
    ...renderEvidenceDiagnosticGroup(
      'Advisory Docs Evidence',
      diagnostics.records.filter((record) => record.source === 'docs-sidecar'),
    ),
    ...renderEvidenceDiagnosticGroup(
      'Ambiguous Relationships',
      diagnostics.records.filter((record) => record.ambiguous),
    ),
    ...renderEvidenceDiagnosticGroup(
      'Degraded or Truncated Evidence',
      diagnostics.records.filter((record) => record.degraded || record.truncated),
    ),
    ...renderEvidenceDiagnosticGroup(
      'Ranked Discovery Notes',
      diagnostics.records.filter((record) => record.category === 'ranked-discovery'),
    ),
  );
}

function writeJsonArtifact(dir: string, filename: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function fileListFallback(
  changedPaths: string[],
  numstatMap: Map<string, { added: number; removed: number }>,
): DiffReviewResult {
  return {
    reviewedFiles: changedPaths.map((p) => {
      const stat = numstatMap.get(p);
      return {
        path: p,
        addedLines: stat?.added ?? 0,
        removedLines: stat?.removed ?? 0,
        changedSymbols: [],
      };
    }),
    totalSymbolsChanged: 0,
    highRiskSymbols: [],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
export async function exportCommunityEvidencePackCommand(opts: {
  community?: string;
  limit?: number;
  out?: string;
  repo?: string;
}): Promise<void> {
  const communityId = opts.community ?? 'default';
  const limit = opts.limit ?? 100;

  let repoRoot: string;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    repoRoot = getGitRoot(process.cwd()) ?? process.cwd();
  }

  const { storagePath, lbugPath } = getStoragePaths(repoRoot);
  const meta = await loadMeta(storagePath);

  if (!meta) {
    console.error('No OntoIndex index found. Run `ontoindex analyze` first.');
    process.exit(1);
  }

  const outDir = opts.out ? path.resolve(opts.out) : path.join(repoRoot, '.ontoindex', 'exports');
  fs.mkdirSync(outDir, { recursive: true });

  const repoId = path.basename(repoRoot).toLowerCase();
  try {
    await initLbug(repoId, lbugPath);
    const result = await runCommunityEvidencePack(
      { id: repoId, name: repoId },
      { community_id: communityId, limit },
    );

    if ('error' in result) {
      console.error(result.error);
      process.exit(1);
    }

    const outFile = path.join(outDir, `community-evidence-pack-${communityId}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(`Community evidence pack exported to: ${path.relative(process.cwd(), outFile)}`);
  } catch (err) {
    console.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await closeLbug(repoId);
  }
}

// Command registration
// ---------------------------------------------------------------------------

export function registerExportCommands(program: Command): void {
  const exportCmd = program
    .command('export')
    .description('Export OntoIndex data as deterministic snapshot artifacts');

  exportCmd
    .command('review-bundle')
    .description(
      'Export a deterministic review-bundle snapshot under .ontoindex/review/ (gitignored).\n' +
        'Reuses the ADR 0018 envelope: target context, freshness, and provenance are preserved.\n' +
        'Output is a disposable diagnostic snapshot, not canonical graph state.',
    )
    .option('--target <ref>', 'Target git ref for context (default: HEAD)', 'HEAD')
    .option('--out <dir>', 'Output directory (default: .ontoindex/review/<sanitized-target>)')
    .option('-r, --repo <name>', 'Indexed repository name or path (default: current git root)')
    .option('--base <ref>', 'Base git ref for diff (e.g. main, HEAD~5)')
    .option('--head <ref>', 'Head git ref (default: HEAD; used with --base)')
    .option('--range <range>', 'Explicit diff range (e.g. main...feature), overrides --base/--head')
    .option('--staged', 'Diff staged changes only (default when no range is given)')
    .addHelpText(
      'after',
      `
Examples:
  # Snapshot the current HEAD (staged diff):
  ontoindex export review-bundle

  # Snapshot with explicit target ref and output path:
  ontoindex export review-bundle --target HEAD --out .ontoindex/review/HEAD

  # Bundle a branch diff against main:
  ontoindex export review-bundle --base main

  # Explicit diff range with custom output:
  ontoindex export review-bundle --range main...feature/my-branch --out .ontoindex/review/my-branch

Output artifacts (under --out directory):
  freshness.json      Freshness status, provenance, and target/indexed HEAD data
  graph-summary.json  Graph metadata: stats, quality mode, graph sections availability
  risk-summary.json   Diff result: changed files, symbols, processes, communities
  sidecar-status.json Docs sidecar status: complete/stale/partial/missing with labels
  REVIEW_REPORT.md    Human-readable markdown report of all of the above

Notes:
  - The output directory is under .ontoindex/ by default, which is already gitignored.
  - All artifacts include a _note field marking them as disposable snapshots.
  - Run \`ontoindex analyze\` first for full graph-aware symbol and blast-radius data.
  - Freshness reflects the gap between the current index and the target ref.
`,
    )
    .action(exportReviewBundleCommand);

  exportCmd
    .command('community-evidence-pack')
    .description('Export a deterministic CommunityEvidencePack JSON artifact')
    .option('--community <id>', 'Community ID or label (default: default)', 'default')
    .option('--limit <n>', 'Maximum items per kind (default: 100)', (v) => parseInt(v, 10), 100)
    .option('--out <dir>', 'Output directory (default: .ontoindex/exports)')
    .option('-r, --repo <name>', 'Indexed repository name or path')
    .action(exportCommunityEvidencePackCommand);
}
