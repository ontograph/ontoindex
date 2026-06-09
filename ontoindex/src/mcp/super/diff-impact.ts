/**
 * gn_diff_impact — PR-blast-radius super-function.
 *
 * Gets changed files via `git diff` for an arbitrary commit-range (or staged
 * changes), finds symbols defined in each changed file, runs upstream/downstream
 * impact analysis per symbol, aggregates HIGH-risk symbols, and optionally
 * suggests reviewers from git history.
 *
 * Symbol discovery and per-symbol blast-radius computation are delegated to the
 * shared review core (`buildDiffReview`).  The impact kernel is used for
 * authoritative upstream counts; downstream counts are heuristic.
 */

import { execFileSync } from 'child_process';
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { emitOrganicRecommendation } from '../../core/recommendations/organic.js';
import type { OrganicRecommendation } from '../../core/recommendations/types.js';
import { buildDiffReview } from '../../core/review/diff-review.js';
import type { DiffReviewResult } from '../../core/review/review-types.js';
import {
  createCapabilityResponseEnvelope,
  deriveEnvelopeFreshness,
  type CapabilityResponseEnvelope,
  type CapabilityResponseFreshness,
} from '../shared/response-envelope.js';
import { resolveTargetContext } from '../shared/target-context.js';
import {
  collectAdvisoryDocsEvidence,
  type AdvisoryDocsEvidenceReport,
  type AdvisoryDocsEvidenceTarget,
} from './docs-evidence.js';
import {
  recordEvidenceReadSafe,
  summarizeBasedOnReads,
  type BasedOnReadsSummary,
} from '../../core/runtime/evidence-read-ledger.js';
import {
  addQueryBudgetDegradedReason,
  addQueryBudgetTruncatedReason,
  createQueryBudgetSnapshot,
  finishQueryBudgetSnapshot,
  type QueryBudgetSnapshot,
  updateQueryBudgetSnapshot,
} from '../../core/runtime/query-budget.js';
import {
  isEvidenceDiagnosticTruncationReason,
  summarizeEvidenceDiagnostics,
  type EvidenceDiagnosticQualityKind,
} from '../../core/runtime/evidence-diagnostics.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiffImpactParams {
  commitRange?: string; // 'HEAD~5..HEAD' | 'main...feature' | undefined (= staged)
  scope?: 'staged' | 'commit-range' | 'branch'; // default: 'commit-range' if commitRange set, else 'staged'
  includeReviewers?: boolean; // default: true
  docsEvidence?: boolean; // opt-in advisory Markdown docs evidence
}

export interface DiffImpactReport {
  version: 1;
  commitRange: string;
  basedOnReads?: BasedOnReadsSummary;
  changedFiles: Array<{
    path: string;
    addedLines: number;
    removedLines: number;
    evidenceIds: string[];
    changedSymbols: Array<{
      nodeId: string;
      name: string;
      evidenceIds: string[];
      impact: {
        upstreamCount: number;
        downstreamCount: number;
        risk: 'LOW' | 'MEDIUM' | 'HIGH';
        heuristic?: boolean;
      };
    }>;
  }>;
  affectedProcesses: Array<{
    id: string;
    name: string;
    processType: string;
    changedStepCount: number;
    evidenceIds: string[];
  }>;
  totalSymbolsChanged: number;
  highRiskSymbols: string[];
  testCoverageDelta: { coveredBefore: number; coveredAfter: number; deltaPp: number };
  recommendations: OrganicRecommendation[];
  suggestedReviewers?: string[];
  warnings: string[];
  warningDetails: Array<{ id: string; message: string; evidenceIds: string[] }>;
  graphSections: DiffReviewResult['graphSections'] | null;
  capabilityState: {
    freshness: CapabilityResponseFreshness;
    capabilitiesUsed: string[];
    capabilitiesMissing: string[];
    warnings: string[];
  };
  evidence: Array<{
    id: string;
    kind: 'changed-file' | 'changed-symbol' | 'affected-process' | 'warning';
    summary: string;
    target: {
      kind: 'file' | 'symbol' | 'process' | 'warning';
      name: string;
      filePath?: string;
      nodeId?: string;
    };
    metadata?: Record<string, unknown>;
  }>;
  docEvidence?: AdvisoryDocsEvidenceReport;
  relatedDocs?: AdvisoryDocsEvidenceReport['relatedDocs'];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_CHANGED_PATHS = 500;
const MAX_REVIEWER_PATHS = 100;
const MAX_REVIEW_DIFF_DIAGNOSTIC_RECORDS = 25;
const REVIEW_DIFF_DIAGNOSTICS_NOTE =
  'Evidence diagnostics are bounded quality metadata for review triage; they are not audit authority.';

type QueryRow = Record<string, unknown> | readonly unknown[];
type TestCoverageRow = QueryRow;
type ReviewDiffDiagnosticEvidenceClass = 'code_evidence' | 'graph_evidence' | 'runtime_diagnostic';
type ReviewDiffDiagnosticAuthority = 'authoritative' | 'advisory';

interface ReviewDiffDiagnosticRecord {
  category: string;
  kind: EvidenceDiagnosticQualityKind;
  source: string;
  authority: ReviewDiffDiagnosticAuthority;
  subject: string;
  reason: string;
  evidenceClass: ReviewDiffDiagnosticEvidenceClass;
  advisory: boolean;
  auditAuthority: false;
  count?: number;
  freshness?: string;
  ambiguous?: boolean;
  degraded?: boolean;
  truncated?: boolean;
  limit?: string;
}

interface ReviewDiffDiagnosticSummary {
  total: number;
  authoritative: number;
  advisory: number;
  ambiguous: number;
  degraded: number;
  truncated: number;
}

interface ReviewDiffDiagnostics {
  schemaVersion: 1;
  note: string;
  summary: ReviewDiffDiagnosticSummary;
  records: ReviewDiffDiagnosticRecord[];
  limits: {
    maxRecords: number;
  };
}

const DEFAULT_FRESHNESS: CapabilityResponseFreshness = {
  status: 'unknown',
  actionable: false,
  reason: 'target-context-unavailable',
};

function gitCapture(repoRoot: string | undefined, args: string[]): string {
  return execFileSync('git', args, {
    ...(repoRoot ? { cwd: repoRoot } : {}),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

export function applyChangedPathLimitForReview(
  changedPaths: string[],
  maxChangedPaths = MAX_CHANGED_PATHS,
): { changedPaths: string[]; truncated: boolean; warning?: string } {
  if (changedPaths.length <= maxChangedPaths) {
    return { changedPaths, truncated: false };
  }
  return {
    changedPaths: changedPaths.slice(0, maxChangedPaths),
    truncated: true,
    warning: `Changed file scan capped at ${maxChangedPaths} paths`,
  };
}

/** Resolve the repo root via git. Falls back to process.cwd(). */
function resolveRepoRoot(): string {
  try {
    return gitCapture(undefined, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return process.cwd();
  }
}

/** Parse `git diff --numstat` output into a map of path → { added, removed }. */
function parseNumstat(output: string): Map<string, { added: number; removed: number }> {
  const result = new Map<string, { added: number; removed: number }>();
  for (const line of output.split('\n').filter(Boolean)) {
    // numstat format: "<added>\t<removed>\t<path>"
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = Number(parts[0]) || 0;
    const removed = Number(parts[1]) || 0;
    const path = parts.slice(2).join('\t'); // handle tab in path (rare)
    result.set(path, { added, removed });
  }
  return result;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function makeEvidenceId(prefix: string, value: string): string {
  return `${prefix}:${encodeURIComponent(value)}`;
}

function lowerRecommendationConfidence(
  confidence: OrganicRecommendation['confidence'],
): OrganicRecommendation['confidence'] {
  switch (confidence) {
    case 'high':
      return 'medium';
    case 'medium':
      return 'low';
    default:
      return 'low';
  }
}

function downgradeRecommendationConfidence(
  base: OrganicRecommendation['confidence'],
  options: {
    freshness: CapabilityResponseFreshness;
    heuristic?: boolean;
    partialGraph?: boolean;
    capabilitiesMissing?: readonly string[];
  },
): OrganicRecommendation['confidence'] {
  let confidence = base;
  if (options.freshness.status !== 'fresh' && options.freshness.status !== 'not-applicable') {
    confidence = lowerRecommendationConfidence(confidence);
  }
  if (
    options.heuristic === true ||
    options.partialGraph === true ||
    (options.capabilitiesMissing ?? []).length > 0
  ) {
    confidence = lowerRecommendationConfidence(confidence);
  }
  return confidence;
}

function buildRecommendationTrace(
  baseConfidence: OrganicRecommendation['confidence'],
  finalConfidence: OrganicRecommendation['confidence'],
  options: {
    freshness: CapabilityResponseFreshness;
    heuristic?: boolean;
    partialGraph?: boolean;
    capabilitiesMissing?: readonly string[];
  },
): Record<string, unknown> | undefined {
  const degradedBy = uniqueStrings([
    options.freshness.status !== 'fresh' && options.freshness.status !== 'not-applicable'
      ? `freshness:${options.freshness.status}`
      : '',
    options.heuristic === true ? 'heuristic-upstream-impact' : '',
    options.partialGraph === true ? 'partial-graph-evidence' : '',
    ...((options.capabilitiesMissing ?? []).map((value) => `missing:${value}`) ?? []),
  ]);
  if (degradedBy.length === 0 && baseConfidence === finalConfidence) {
    return undefined;
  }
  return {
    baseConfidence,
    finalConfidence,
    freshness: options.freshness,
    degradedBy,
  };
}

function createBaseDiffImpactReport(
  commitRange: string,
  warnings: string[],
  overrides: Partial<DiffImpactReport> = {},
): DiffImpactReport {
  return {
    version: 1,
    commitRange,
    basedOnReads: summarizeBasedOnReads(),
    changedFiles: [],
    affectedProcesses: [],
    totalSymbolsChanged: 0,
    highRiskSymbols: [],
    testCoverageDelta: { coveredBefore: 0, coveredAfter: 0, deltaPp: 0 },
    recommendations: [],
    warnings,
    warningDetails: [],
    graphSections: null,
    capabilityState: {
      freshness: DEFAULT_FRESHNESS,
      capabilitiesUsed: ['git-diff', 'graph-review', 'blast-radius'],
      capabilitiesMissing: [],
      warnings: [],
    },
    evidence: [],
    ...overrides,
  };
}

function collectWarningEvidenceIds(
  message: string,
  options: {
    explicit: Map<string, string[]>;
    fileEvidenceByPath: Map<string, string>;
    symbolEvidenceEntries: Array<{ token: string; id: string }>;
    processEvidenceEntries: Array<{ token: string; id: string }>;
  },
): string[] {
  const explicit = options.explicit.get(message);
  if (explicit !== undefined) {
    return uniqueStrings(explicit);
  }

  const evidenceIds: string[] = [];
  for (const [filePath, evidenceId] of options.fileEvidenceByPath.entries()) {
    if (message.includes(filePath)) evidenceIds.push(evidenceId);
  }
  for (const { token, id } of options.symbolEvidenceEntries) {
    if (token.length > 0 && message.includes(token)) evidenceIds.push(id);
  }
  for (const { token, id } of options.processEvidenceEntries) {
    if (token.length > 0 && message.includes(token)) evidenceIds.push(id);
  }
  return uniqueStrings(evidenceIds);
}

function reviewDiffDiagnosticRecord(
  record: Omit<ReviewDiffDiagnosticRecord, 'advisory' | 'auditAuthority'> & {
    advisory?: boolean;
  },
): ReviewDiffDiagnosticRecord {
  return {
    ...record,
    advisory: record.advisory ?? record.authority === 'advisory',
    auditAuthority: false,
  };
}

function summarizeReviewDiffDiagnostics(
  records: readonly ReviewDiffDiagnosticRecord[],
): Pick<ReviewDiffDiagnostics, 'schemaVersion' | 'summary' | 'records'> {
  return summarizeEvidenceDiagnostics(records, {
    maxRecords: MAX_REVIEW_DIFF_DIAGNOSTIC_RECORDS,
    createTruncationRecord: (omitted) =>
      reviewDiffDiagnosticRecord({
        category: 'runtime',
        kind: 'truncated',
        source: 'runtime',
        authority: 'advisory',
        evidenceClass: 'runtime_diagnostic',
        subject: 'diagnostic records',
        reason: `${omitted} diagnostic records omitted by gn_review_diff response limit.`,
        count: omitted,
        truncated: true,
        limit: 'diagnostic-records',
      }),
  });
}

function buildReviewDiffDiagnostics(options: {
  changedPathCount: number;
  reviewResult: DiffReviewResult;
  warnings: readonly string[];
  freshness: CapabilityResponseFreshness;
  budget: QueryBudgetSnapshot;
}): ReviewDiffDiagnostics {
  const { changedPathCount, reviewResult, warnings, freshness, budget } = options;
  const graphEvidenceAuthority = freshness.actionable ? 'authoritative' : 'advisory';
  const graphEvidenceAdvisory = graphEvidenceAuthority === 'advisory';
  const records: ReviewDiffDiagnosticRecord[] = [
    reviewDiffDiagnosticRecord({
      category: 'code-graph',
      kind: 'extracted',
      source: 'git-diff',
      authority: 'authoritative',
      evidenceClass: 'code_evidence',
      subject: 'changed files',
      reason: 'Changed files were read from the requested git diff scope.',
      count: changedPathCount,
    }),
    reviewDiffDiagnosticRecord({
      category: 'code-graph',
      kind: graphEvidenceAdvisory ? 'degraded' : 'extracted',
      source: 'graph-review',
      authority: graphEvidenceAuthority,
      evidenceClass: 'graph_evidence',
      subject: 'changed symbols',
      reason: graphEvidenceAdvisory
        ? 'Graph review evidence is freshness-gated and downgraded to advisory diagnostics.'
        : 'Graph review evidence is freshness-gated code graph evidence.',
      count: reviewResult.totalSymbolsChanged,
      freshness: freshness.status,
      degraded: graphEvidenceAdvisory,
    }),
  ];

  const heuristicImpactCount = reviewResult.reviewedFiles.reduce(
    (count, file) =>
      count + file.changedSymbols.filter((symbol) => symbol.impact.heuristic === true).length,
    0,
  );
  if (heuristicImpactCount > 0) {
    records.push(
      reviewDiffDiagnosticRecord({
        category: 'code-graph',
        kind: 'ambiguous',
        source: 'graph-review',
        authority: 'advisory',
        evidenceClass: 'graph_evidence',
        subject: 'heuristic symbol impact',
        reason: 'One or more impact counts came from fallback heuristic graph evidence.',
        count: heuristicImpactCount,
        freshness: freshness.status,
        ambiguous: true,
      }),
    );
  }

  if ((reviewResult.affectedProcesses ?? []).length > 0) {
    records.push(
      reviewDiffDiagnosticRecord({
        category: 'code-graph',
        kind: graphEvidenceAdvisory ? 'degraded' : 'extracted',
        source: 'graph-review',
        authority: graphEvidenceAuthority,
        evidenceClass: 'graph_evidence',
        subject: 'affected execution flows',
        reason: graphEvidenceAdvisory
          ? 'Affected process evidence is freshness-gated and downgraded to advisory diagnostics.'
          : 'Affected process evidence came from the graph review section.',
        count: reviewResult.affectedProcesses?.length ?? 0,
        freshness: freshness.status,
        degraded: graphEvidenceAdvisory,
      }),
    );
  }

  if (reviewResult.graphSections?.processesAvailable === false) {
    records.push(
      reviewDiffDiagnosticRecord({
        category: 'code-graph',
        kind: 'degraded',
        source: 'graph-review',
        authority: 'advisory',
        evidenceClass: 'runtime_diagnostic',
        subject: 'affected execution flows',
        reason:
          'Process enrichment was unavailable; missing process rows are not evidence of no impact.',
        freshness: freshness.status,
        degraded: true,
      }),
    );
  }

  if ((reviewResult.affectedCommunities ?? []).length > 0) {
    records.push(
      reviewDiffDiagnosticRecord({
        category: 'code-graph',
        kind: graphEvidenceAdvisory ? 'degraded' : 'extracted',
        source: 'graph-review',
        authority: graphEvidenceAuthority,
        evidenceClass: 'graph_evidence',
        subject: 'affected communities',
        reason: graphEvidenceAdvisory
          ? 'Affected community evidence is freshness-gated and downgraded to advisory diagnostics.'
          : 'Affected community evidence came from the graph review section.',
        count: reviewResult.affectedCommunities?.length ?? 0,
        freshness: freshness.status,
        degraded: graphEvidenceAdvisory,
      }),
    );
  }

  if (reviewResult.graphSections?.communitiesAvailable === false) {
    records.push(
      reviewDiffDiagnosticRecord({
        category: 'code-graph',
        kind: 'degraded',
        source: 'graph-review',
        authority: 'advisory',
        evidenceClass: 'runtime_diagnostic',
        subject: 'affected communities',
        reason:
          'Community enrichment was unavailable; missing community rows are not evidence of no impact.',
        freshness: freshness.status,
        degraded: true,
      }),
    );
  }

  if ((reviewResult.crossCommunityRiskReasons ?? []).length > 0) {
    records.push(
      reviewDiffDiagnosticRecord({
        category: 'ranked-discovery',
        kind: 'ambiguous',
        source: 'graph-review',
        authority: 'advisory',
        evidenceClass: 'graph_evidence',
        subject: 'cross-community risk hints',
        reason:
          'Cross-community risk reasons are review hints, not complete impact or audit findings.',
        count: reviewResult.crossCommunityRiskReasons?.length ?? 0,
        freshness: freshness.status,
      }),
    );
  }

  for (const reason of budget.truncatedReasons) {
    records.push(
      reviewDiffDiagnosticRecord({
        category: 'runtime',
        kind: 'truncated',
        source: 'runtime',
        authority: 'advisory',
        evidenceClass: 'runtime_diagnostic',
        subject: reason,
        reason: `Runtime budget limit applied: ${reason}.`,
        truncated: true,
        limit: 'query-budget',
      }),
    );
  }

  for (const reason of budget.degradedReasons) {
    records.push(
      reviewDiffDiagnosticRecord({
        category: 'runtime',
        kind: 'degraded',
        source: 'runtime',
        authority: 'advisory',
        evidenceClass: 'runtime_diagnostic',
        subject: reason,
        reason: `Runtime budget degradation applied: ${reason}.`,
        degraded: true,
        limit: 'query-budget',
      }),
    );
  }

  for (const warning of warnings) {
    const truncated = isEvidenceDiagnosticTruncationReason(warning);
    records.push(
      reviewDiffDiagnosticRecord({
        category: 'runtime',
        kind: truncated ? 'truncated' : 'degraded',
        source: 'runtime',
        authority: 'advisory',
        evidenceClass: 'runtime_diagnostic',
        subject: warning,
        reason: warning,
        degraded: !truncated,
        truncated,
      }),
    );
  }

  return {
    note: REVIEW_DIFF_DIAGNOSTICS_NOTE,
    limits: { maxRecords: MAX_REVIEW_DIFF_DIAGNOSTIC_RECORDS },
    ...summarizeReviewDiffDiagnostics(records),
  };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function gnDiffImpact(
  repoId: string,
  params: DiffImpactParams,
): Promise<DiffImpactReport> {
  const warnings: string[] = [];
  const repoRoot = resolveRepoRoot();

  // ---- 1. Build git diff args based on scope / commitRange ----------------
  const { commitRange, scope, includeReviewers = true } = params;

  let nameOnlyArgs: string[];
  let numstatArgs: string[];
  let resolvedRange: string;

  if (commitRange) {
    // explicit range always wins
    nameOnlyArgs = ['diff', commitRange, '--name-only'];
    numstatArgs = ['diff', commitRange, '--numstat'];
    resolvedRange = commitRange;
  } else if (scope === 'branch') {
    nameOnlyArgs = ['diff', 'main...HEAD', '--name-only'];
    numstatArgs = ['diff', 'main...HEAD', '--numstat'];
    resolvedRange = 'main...HEAD';
  } else {
    // 'staged' (default) or 'commit-range' without an explicit range
    nameOnlyArgs = ['diff', '--cached', '--name-only'];
    numstatArgs = ['diff', '--cached', '--numstat'];
    resolvedRange = '--cached';
  }

  // ---- 2. Fetch changed file paths ----------------------------------------
  let changedPaths: string[] = [];
  try {
    const out = gitCapture(repoRoot, nameOnlyArgs);
    const limited = applyChangedPathLimitForReview(out.split('\n').filter(Boolean));
    changedPaths = limited.changedPaths;
    if (limited.truncated) {
      if (limited.warning) warnings.push(limited.warning);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return createBaseDiffImpactReport(resolvedRange, [`git diff failed: ${msg}`]);
  }

  // ---- 3. Empty diff — return empty report --------------------------------
  if (changedPaths.length === 0) {
    let freshness = DEFAULT_FRESHNESS;
    const capabilityWarnings: string[] = [];
    try {
      const targetContext = await resolveTargetContext({ repo: repoId });
      if (targetContext && typeof targetContext === 'object') {
        freshness = deriveEnvelopeFreshness(targetContext);
        capabilityWarnings.push(...targetContext.warnings);
      }
    } catch (err) {
      capabilityWarnings.push(
        `target context unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return createBaseDiffImpactReport(resolvedRange, [], {
      capabilityState: {
        freshness,
        capabilitiesUsed: ['git-diff', 'graph-review', 'blast-radius'],
        capabilitiesMissing: [],
        warnings: uniqueStrings(capabilityWarnings),
      },
    });
  }

  // ---- 4. Fetch line-count stats ------------------------------------------
  let numstatMap = new Map<string, { added: number; removed: number }>();
  try {
    const numstatOut = gitCapture(repoRoot, numstatArgs);
    numstatMap = parseNumstat(numstatOut);
  } catch {
    // best-effort — continue with zero counts
    warnings.push('git diff --numstat failed; line counts will be 0');
  }

  // ---- 5. Per-file: symbols + upstream/downstream impact ------------------
  // Delegated to the shared review core.  The impact kernel is used for
  // authoritative upstream counts; downstream counts are heuristic.
  const reviewResult = await buildDiffReview(repoId, changedPaths, numstatMap);
  warnings.push(...reviewResult.warnings);

  let freshness = DEFAULT_FRESHNESS;
  const capabilityWarnings: string[] = [];
  try {
    const targetContext = await resolveTargetContext({ repo: repoId });
    if (targetContext && typeof targetContext === 'object') {
      freshness = deriveEnvelopeFreshness(targetContext);
      capabilityWarnings.push(...targetContext.warnings);
    }
  } catch (err) {
    capabilityWarnings.push(
      `target context unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const evidence: DiffImpactReport['evidence'] = [];
  const fileEvidenceByPath = new Map<string, string>();
  const symbolEvidenceEntries: Array<{ token: string; id: string }> = [];

  recordEvidenceReadSafe({
    readClass: 'graph_evidence',
    surface: 'mcp',
    tool: 'gn_diff_impact',
    target: commitRange || 'staged',
    targetType: 'commit_range',
    repo: repoId,
  });

  const changedFiles: DiffImpactReport['changedFiles'] = reviewResult.reviewedFiles.map((rf) => {
    const fileEvidenceId = makeEvidenceId('diff-file', rf.path);
    fileEvidenceByPath.set(rf.path, fileEvidenceId);

    evidence.push({
      id: fileEvidenceId,
      kind: 'changed-file',
      summary: `Changed file ${rf.path} (+${rf.addedLines}/-${rf.removedLines}).`,
      target: { kind: 'file', name: rf.path, filePath: rf.path },
      metadata: {
        addedLines: rf.addedLines,
        removedLines: rf.removedLines,
      },
    });

    return {
      path: rf.path,
      addedLines: rf.addedLines,
      removedLines: rf.removedLines,
      evidenceIds: [fileEvidenceId],
      changedSymbols: rf.changedSymbols.map((sym) => {
        const lookupKey = sym.nodeId || `${rf.path}::${sym.name}`;
        const symbolEvidenceId = makeEvidenceId('diff-symbol', lookupKey);
        symbolEvidenceEntries.push({ token: sym.name, id: symbolEvidenceId });

        evidence.push({
          id: symbolEvidenceId,
          kind: 'changed-symbol',
          summary: `Changed symbol ${sym.name} in ${rf.path} has ${sym.impact.upstreamCount} upstream callers and ${sym.impact.downstreamCount} downstream edges.`,
          target: { kind: 'symbol', name: sym.name, filePath: rf.path, nodeId: sym.nodeId },
          metadata: {
            upstreamCount: sym.impact.upstreamCount,
            downstreamCount: sym.impact.downstreamCount,
            risk: sym.impact.risk,
            heuristic: sym.impact.heuristic,
          },
        });

        return {
          nodeId: sym.nodeId,
          name: sym.name,
          evidenceIds: uniqueStrings([fileEvidenceId, symbolEvidenceId]),
          impact: {
            upstreamCount: sym.impact.upstreamCount,
            downstreamCount: sym.impact.downstreamCount,
            risk: sym.impact.risk,
            ...(sym.impact.heuristic ? { heuristic: true } : {}),
          },
        };
      }),
    };
  });

  const processEvidenceEntries: Array<{ token: string; id: string }> = [];
  const affectedProcesses: DiffImpactReport['affectedProcesses'] = (
    reviewResult.affectedProcesses ?? []
  ).map((process) => {
    const processEvidenceId = makeEvidenceId('diff-process', process.id || process.name);
    processEvidenceEntries.push({ token: process.name, id: processEvidenceId });

    evidence.push({
      id: processEvidenceId,
      kind: 'affected-process',
      summary: `Affected process ${process.name} includes ${process.changedStepCount} changed steps.`,
      target: { kind: 'process', name: process.name },
      metadata: {
        processId: process.id,
        processType: process.processType,
        changedStepCount: process.changedStepCount,
      },
    });
    return {
      id: process.id,
      name: process.name,
      processType: process.processType,
      changedStepCount: process.changedStepCount,
      evidenceIds: [processEvidenceId],
    };
  });

  // Reconstruct docs-evidence targets from the review result.
  const docsEvidenceTargets: AdvisoryDocsEvidenceTarget[] = [];
  for (const rf of reviewResult.reviewedFiles) {
    docsEvidenceTargets.push({ filePath: rf.path });
    for (const sym of rf.changedSymbols) {
      if (sym.nodeId || (sym.name && sym.name !== '(unknown)')) {
        docsEvidenceTargets.push({ nodeId: sym.nodeId, name: sym.name, filePath: rf.path });
      }
    }
  }

  const { totalSymbolsChanged, highRiskSymbols } = reviewResult;

  // ---- 6. Test coverage delta (heuristic — same as pre-commit-audit) ------
  let coveredAfter = 0;
  let coverageQueryFailed = false;
  const missingCoveragePaths = new Set<string>();
  const explicitWarningEvidenceIds = new Map<string, string[]>();
  for (const filePath of changedPaths) {
    try {
      const testRows = (await executeParameterized(
        repoId,
        `MATCH (t:File)-[r:CodeRelation {type: 'IMPORTS'}]->(target:File {filePath: $path})
         WHERE t.filePath =~ '.*test.*' OR t.filePath =~ '.*spec.*'
         RETURN t.filePath AS testPath`,
        { path: filePath },
      )) as TestCoverageRow[];
      if (testRows.length > 0) {
        coveredAfter += 1;
      } else {
        missingCoveragePaths.add(filePath);
        const fileEvidenceId = fileEvidenceByPath.get(filePath);
        const gapEvidenceId = makeEvidenceId('diff-warning:test-gap', filePath);
        const warningMessage = `No linked test import evidence found for ${filePath}.`;
        evidence.push({
          id: gapEvidenceId,
          kind: 'warning',
          summary: warningMessage,
          target: { kind: 'warning', name: warningMessage, filePath },
          metadata: { warningType: 'test-gap' },
        });
        warnings.push(warningMessage);
        explicitWarningEvidenceIds.set(
          warningMessage,
          uniqueStrings([gapEvidenceId, fileEvidenceId ?? '']),
        );
      }
    } catch (err) {
      coverageQueryFailed = true;
      capabilityWarnings.push(
        `test coverage graph query unavailable for ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const coveredBefore = coveredAfter;
  const testCoverageDelta = { coveredBefore, coveredAfter, deltaPp: 0 };

  // ---- 7. Suggested reviewers (best-effort) --------------------------------
  let suggestedReviewers: string[] | undefined;
  if (includeReviewers) {
    try {
      const reviewerPaths = changedPaths.slice(0, MAX_REVIEWER_PATHS);
      if (changedPaths.length > reviewerPaths.length) {
        warnings.push(`Reviewer lookup capped at ${MAX_REVIEWER_PATHS} paths`);
      }
      const gitLogOut = gitCapture(repoRoot, [
        'log',
        '--format=%aN',
        '-n',
        '20',
        '--',
        ...reviewerPaths,
      ]);
      const authorCounts = new Map<string, number>();
      for (const author of gitLogOut.split('\n').filter(Boolean)) {
        authorCounts.set(author, (authorCounts.get(author) ?? 0) + 1);
      }
      suggestedReviewers = [...authorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]) => name);
    } catch {
      // optional — skip silently
    }
  }

  const capabilitiesMissing = uniqueStrings([
    freshness.status === 'stale' ? 'fresh-graph' : '',
    freshness.status === 'degraded' ? 'clean-worktree' : '',
    freshness.status === 'unknown' ? 'target-context' : '',
    reviewResult.graphSections?.processesAvailable === false ? 'process-enrichment' : '',
    reviewResult.graphSections?.communitiesAvailable === false ? 'community-enrichment' : '',
    reviewResult.reviewedFiles.some((rf) => rf.changedSymbols.some((sym) => sym.impact.heuristic))
      ? 'authoritative-upstream-impact'
      : '',
    coverageQueryFailed ? 'test-coverage-graph' : '',
  ]);

  const partialGraph =
    reviewResult.graphSections?.processesAvailable === false ||
    reviewResult.graphSections?.communitiesAvailable === false ||
    coverageQueryFailed;

  const recommendations: OrganicRecommendation[] = [];

  for (const file of changedFiles) {
    for (const symbol of file.changedSymbols
      .filter((entry) => entry.impact.risk === 'HIGH')
      .slice(0, 3)) {
      const baseConfidence: OrganicRecommendation['confidence'] = 'high';
      const confidence = downgradeRecommendationConfidence(baseConfidence, {
        freshness,
        heuristic: symbol.impact.heuristic === true,
        partialGraph,
        capabilitiesMissing,
      });
      recommendations.push(
        emitOrganicRecommendation({
          id: makeEvidenceId(
            'recommendation:high-risk-symbol',
            symbol.nodeId || `${file.path}:${symbol.name}`,
          ),
          action: 'review-high-risk-symbol',
          target: { kind: 'symbol', name: symbol.name, filePath: file.path },
          reason: `${symbol.name} in ${file.path} is flagged by ${symbol.evidenceIds[0]} with ${symbol.impact.upstreamCount} upstream callers.`,
          confidence,
          evidenceIds: symbol.evidenceIds,
          evidenceClasses: ['graph_evidence'],
          scoreTrace: buildRecommendationTrace(baseConfidence, confidence, {
            freshness,
            heuristic: symbol.impact.heuristic === true,
            partialGraph,
            capabilitiesMissing,
          }),
          nextTools: ['gn_review_diff'],
        }),
      );
    }
  }

  for (const process of affectedProcesses.slice(0, 3)) {
    const baseConfidence: OrganicRecommendation['confidence'] = 'medium';
    const confidence = downgradeRecommendationConfidence(baseConfidence, {
      freshness,
      partialGraph,
      capabilitiesMissing,
    });
    recommendations.push(
      emitOrganicRecommendation({
        id: makeEvidenceId('recommendation:affected-process', process.id || process.name),
        action: 'review-affected-process',
        target: { kind: 'process', name: process.name },
        reason: `${process.name} includes ${process.changedStepCount} changed steps in ${process.evidenceIds[0]}.`,
        confidence,
        evidenceIds: process.evidenceIds,
        evidenceClasses: ['graph_evidence'],
        scoreTrace: buildRecommendationTrace(baseConfidence, confidence, {
          freshness,
          partialGraph,
          capabilitiesMissing,
        }),
        nextTools: ['gn_review_diff'],
      }),
    );
  }

  for (const filePath of Array.from(missingCoveragePaths).slice(0, 3)) {
    const file = changedFiles.find((entry) => entry.path === filePath);
    if (file === undefined) continue;
    const targetSymbol = file.changedSymbols[0];
    const warningMessage = `No linked test import evidence found for ${filePath}.`;
    const warningEvidenceIds = explicitWarningEvidenceIds.get(warningMessage) ?? [];
    const evidenceIds = uniqueStrings([
      ...warningEvidenceIds,
      ...(targetSymbol?.evidenceIds ?? file.evidenceIds),
    ]);
    const baseConfidence: OrganicRecommendation['confidence'] = 'medium';
    const confidence = downgradeRecommendationConfidence(baseConfidence, {
      freshness,
      partialGraph,
      capabilitiesMissing,
    });
    recommendations.push(
      emitOrganicRecommendation({
        id: makeEvidenceId('recommendation:test-gap', targetSymbol?.nodeId || filePath),
        action: 'review-test-gap',
        target: targetSymbol
          ? { kind: 'symbol', name: targetSymbol.name, filePath }
          : { kind: 'file', name: filePath, filePath },
        reason: `${targetSymbol?.name ?? filePath} in ${filePath} has no linked test import evidence in ${warningEvidenceIds[0] ?? makeEvidenceId('diff-warning:test-gap', filePath)}.`,
        confidence,
        evidenceIds,
        evidenceClasses: ['graph_evidence', 'runtime_diagnostic'],
        scoreTrace: buildRecommendationTrace(baseConfidence, confidence, {
          freshness,
          partialGraph,
          capabilitiesMissing,
        }),
        nextTools: ['gn_test_gap'],
      }),
    );
  }

  const uniqueWarnings = uniqueStrings(warnings);
  const warningDetails: DiffImpactReport['warningDetails'] = uniqueWarnings.map(
    (message, index) => {
      const evidenceIds = collectWarningEvidenceIds(message, {
        explicit: explicitWarningEvidenceIds,
        fileEvidenceByPath,
        symbolEvidenceEntries,
        processEvidenceEntries,
      });
      const warningId = makeEvidenceId('diff-warning', `${index + 1}:${message}`);
      evidence.push({
        id: warningId,
        kind: 'warning',
        summary: message,
        target: { kind: 'warning', name: message },
        metadata: {
          evidenceIds,
        },
      });
      return {
        id: warningId,
        message,
        evidenceIds,
      };
    },
  );

  const docsEvidence =
    params.docsEvidence === true
      ? await collectAdvisoryDocsEvidence(repoId, docsEvidenceTargets)
      : undefined;

  return {
    ...createBaseDiffImpactReport(resolvedRange, uniqueWarnings),
    changedFiles,
    affectedProcesses,
    totalSymbolsChanged,
    highRiskSymbols,
    testCoverageDelta,
    recommendations,
    suggestedReviewers,
    warningDetails,
    graphSections: reviewResult.graphSections ?? null,
    capabilityState: {
      freshness,
      capabilitiesUsed: uniqueStrings([
        'git-diff',
        'graph-review',
        'blast-radius',
        includeReviewers ? 'git-history-reviewers' : '',
      ]),
      capabilitiesMissing,
      warnings: uniqueStrings(capabilityWarnings),
    },
    evidence,
    ...(docsEvidence ? { docEvidence: docsEvidence, relatedDocs: docsEvidence.relatedDocs } : {}),
  };
}

// ---------------------------------------------------------------------------
// gn_review_diff — MCP wrapper with ADR 0018 review envelope (REV-5)
// ---------------------------------------------------------------------------

/**
 * Parameters for gn_review_diff.
 *
 * Intentionally a subset of DiffImpactParams: no docsEvidence (out of scope
 * for REV-5) and no includeReviewers (reviewers belong to the blast-radius
 * report, not the review envelope).
 */
export interface ReviewDiffParams {
  /** Explicit git range ('HEAD~5..HEAD', 'main...feature'). Omit for staged. */
  commitRange?: string;
  /** Which changes to diff. Default: 'staged'. */
  scope?: 'staged' | 'commit-range' | 'branch';
  /** Repository identifier. Required when multiple repos are indexed. */
  repo?: string;
}

export type ReviewDiffEnvelope = CapabilityResponseEnvelope<{
  resolvedRange: string;
  reviewedFiles: DiffReviewResult['reviewedFiles'];
  totalSymbolsChanged: number;
  highRiskSymbols: string[];
  affectedProcesses: NonNullable<DiffReviewResult['affectedProcesses']>;
  affectedCommunities: NonNullable<DiffReviewResult['affectedCommunities']>;
  crossCommunityRiskReasons: NonNullable<DiffReviewResult['crossCommunityRiskReasons']>;
  graphSections: DiffReviewResult['graphSections'] | null;
  diagnostics: ReviewDiffDiagnostics;
}>;

/**
 * MCP-native review-diff super-function.
 *
 * Runs `buildDiffReview` (the same shared builder used by `gnDiffImpact` and
 * the CLI `review diff` command) and wraps the result in the ADR 0018
 * capability-response envelope.  This keeps the MCP response shape aligned
 * with the now-stable `review diff` CLI contract without duplicating any
 * review logic.
 *
 * Backward compatibility: existing callers of `gn_diff_impact` are
 * unaffected — that function's response shape is unchanged.
 */
export async function gnReviewDiff(
  repoId: string,
  params: ReviewDiffParams,
): Promise<ReviewDiffEnvelope> {
  const budgetStartedAtMs = Date.now();
  let budget = createQueryBudgetSnapshot({
    maxCandidates: MAX_CHANGED_PATHS,
    emitted: 0,
  });
  const warnings: string[] = [];
  const repoRoot = resolveRepoRoot();

  // ---- 1. Resolve git diff args -------------------------------------------
  const { commitRange, scope } = params;

  let nameOnlyArgs: string[];
  let numstatArgs: string[];
  let resolvedRange: string;

  if (commitRange) {
    nameOnlyArgs = ['diff', commitRange, '--name-only'];
    numstatArgs = ['diff', commitRange, '--numstat'];
    resolvedRange = commitRange;
  } else if (scope === 'branch') {
    nameOnlyArgs = ['diff', 'main...HEAD', '--name-only'];
    numstatArgs = ['diff', 'main...HEAD', '--numstat'];
    resolvedRange = 'main...HEAD';
  } else {
    nameOnlyArgs = ['diff', '--cached', '--name-only'];
    numstatArgs = ['diff', '--cached', '--numstat'];
    resolvedRange = '--cached';
  }

  // ---- 2. Fetch changed file paths ----------------------------------------
  let changedPaths: string[] = [];
  try {
    const out = gitCapture(repoRoot, nameOnlyArgs);
    const limited = applyChangedPathLimitForReview(out.split('\n').filter(Boolean));
    changedPaths = limited.changedPaths;
    if (limited.truncated) {
      if (limited.warning) warnings.push(limited.warning);
      budget = addQueryBudgetTruncatedReason(budget, 'changed-path-cap');
    }
    budget = updateQueryBudgetSnapshot(budget, { emitted: changedPaths.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`git diff failed: ${msg}`);
    budget = addQueryBudgetDegradedReason(budget, 'git-diff-name-only-failed');
  }

  // ---- 3. Fetch line-count stats ------------------------------------------
  let numstatMap = new Map<string, { added: number; removed: number }>();
  if (changedPaths.length > 0) {
    try {
      const numstatOut = gitCapture(repoRoot, numstatArgs);
      numstatMap = parseNumstat(numstatOut);
    } catch {
      warnings.push('git diff --numstat failed; line counts will be 0');
      budget = addQueryBudgetDegradedReason(budget, 'git-diff-numstat-failed');
    }
  }

  // ---- 4. Build review via shared core ------------------------------------
  let reviewResult: DiffReviewResult;
  if (changedPaths.length === 0) {
    reviewResult = {
      reviewedFiles: [],
      totalSymbolsChanged: 0,
      highRiskSymbols: [],
      warnings: [],
      affectedProcesses: [],
      affectedCommunities: [],
      crossCommunityRiskReasons: [],
      graphSections: { processesAvailable: true, communitiesAvailable: true },
    };
  } else {
    reviewResult = await buildDiffReview(repoId, changedPaths, numstatMap);
  }

  const allWarnings = [...new Set([...warnings, ...reviewResult.warnings])];

  // ---- 5. Target context for provenance envelope --------------------------
  const targetContext = await resolveTargetContext({ repo: repoId }).catch(() =>
    resolveTargetContext(),
  );
  const freshness = deriveEnvelopeFreshness(targetContext);
  const finalBudget = finishQueryBudgetSnapshot(budget, { startedAtMs: budgetStartedAtMs });
  const diagnostics = buildReviewDiffDiagnostics({
    changedPathCount: changedPaths.length,
    reviewResult,
    warnings: allWarnings,
    freshness,
    budget: finalBudget,
  });

  // ---- 6. Wrap in ADR 0018 envelope ---------------------------------------
  return createCapabilityResponseEnvelope({
    tool: 'gn_review_diff',
    version: 1,
    status:
      freshness.status === 'stale' || freshness.status === 'degraded' || allWarnings.length > 0
        ? 'degraded'
        : 'ok',
    targetContext,
    capabilitiesUsed: ['git-diff', 'graph-review', 'blast-radius'],
    freshness,
    results: {
      resolvedRange,
      reviewedFiles: reviewResult.reviewedFiles,
      totalSymbolsChanged: reviewResult.totalSymbolsChanged,
      highRiskSymbols: reviewResult.highRiskSymbols,
      affectedProcesses: reviewResult.affectedProcesses ?? [],
      affectedCommunities: reviewResult.affectedCommunities ?? [],
      crossCommunityRiskReasons: reviewResult.crossCommunityRiskReasons ?? [],
      graphSections: reviewResult.graphSections ?? null,
      diagnostics,
    },
    warnings: allWarnings,
    limits: { maxChangedPaths: MAX_CHANGED_PATHS, budget: finalBudget },
  });
}
