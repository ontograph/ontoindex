/**
 * gn_pre_commit_audit — Ship-readiness verdict super-function.
 *
 * Gets changed files via `git diff`, finds changed symbols for each file,
 * runs impact analysis per symbol, and synthesises a READY / REVIEW /
 * DO-NOT-COMMIT verdict so callers never need to wire multiple primitives
 * together manually.
 */

import { execFileSync } from 'child_process';
import { emitOrganicRecommendation } from '../../core/recommendations/organic.js';
import type { OrganicRecommendation } from '../../core/recommendations/types.js';
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import type { AffectedProcess } from '../../core/review/review-types.js';
import {
  deriveEnvelopeFreshness,
  type CapabilityResponseFreshness,
} from '../shared/response-envelope.js';
import { resolveTargetContext, type TargetContext } from '../shared/target-context.js';
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PreCommitAuditParams {
  scope?: 'staged' | 'unstaged' | 'all' | 'branch'; // default: 'staged'
  expectedSymbols?: string[]; // user's stated intent
  docsEvidence?: boolean; // opt-in advisory Markdown docs evidence
}

export interface CommitAuditReport {
  version: 1;
  verdict: 'READY' | 'REVIEW' | 'DO-NOT-COMMIT';
  reasoning: string;
  basedOnReads?: BasedOnReadsSummary;
  changedFiles: Array<{
    path: string;
    changedSymbols: string[];
    perSymbolImpact: { upstream: number; downstream: number; risk: 'LOW' | 'MEDIUM' | 'HIGH' };
  }>;
  unexpectedSymbols: string[];
  testCoverageDelta: {
    coveredBefore: number;
    coveredAfter: number;
    deltaPp: number;
  };
  suggestedReviewers?: string[];
  preCommitChecklist: Array<{ check: string; passed: boolean; detail: string }>;
  warnings: string[];
  docEvidence?: AdvisoryDocsEvidenceReport;
  relatedDocs?: AdvisoryDocsEvidenceReport['relatedDocs'];
  status: 'ok' | 'degraded';
  targetContext?: TargetContext;
  freshness: CapabilityResponseFreshness;
  capabilitiesUsed: string[];
  capabilitiesMissing: string[];
  limits: {
    maxChangedPaths: number;
    maxReviewerPaths: number;
    maxSymbolsPerFile: number;
  };
  nextTools: string[];
  evidence: CommitAuditEvidence[];
  recommendations: OrganicRecommendation[];
  affectedProcesses: AffectedProcess[];
  graphSections: {
    processesAvailable: boolean;
    hunkCoverageAvailable: boolean;
  };
}

export interface CommitAuditEvidence {
  id: string;
  kind: 'hunk' | 'symbol' | 'process' | 'coverage' | 'freshness';
  summary: string;
  status: 'info' | 'warning' | 'degraded';
  filePath?: string;
  startLine?: number;
  endLine?: number;
  symbolName?: string;
  nodeId?: string;
  processId?: string;
  processType?: string;
  relatedEvidenceIds?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_CHANGED_PATHS = 500;
const MAX_REVIEWER_PATHS = 100;
const MAX_SYMBOLS_PER_FILE = 50;
const MAX_RECOMMENDATIONS = 12;

type QueryRow = Record<string, unknown> | readonly unknown[];
type SymbolRow = QueryRow;
type CountRow = QueryRow;
type TestCoverageRow = QueryRow;
type LineRange = { startLine: number; endLine: number };
type ProcessRow = QueryRow;

function gitCapture(repoRoot: string | undefined, args: string[]): string {
  return execFileSync('git', args, {
    ...(repoRoot ? { cwd: repoRoot } : {}),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function rowValue(row: QueryRow, key: string, index: number, fallback: unknown): unknown {
  const keyed = row[key as keyof typeof row];
  return keyed ?? row[index] ?? fallback;
}

function rowString(row: QueryRow, key: string, index: number, fallback = ''): string {
  return rowValue(row, key, index, fallback) as string;
}

function rowNumber(row: QueryRow, key: string, index: number): number {
  return Number(rowValue(row, key, index, 0));
}

function rowOptionalNumber(row: QueryRow, key: string, index: number): number | undefined {
  const value = rowValue(row, key, index, undefined);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Classify upstream caller count into risk tier. */
function classifyRisk(upstreamCount: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (upstreamCount > 50) return 'HIGH';
  if (upstreamCount >= 10) return 'MEDIUM';
  return 'LOW';
}

/** Resolve the repo root. Uses process.cwd() as the fallback. */
function resolveRepoRoot(): string {
  try {
    const out = gitCapture(undefined, ['rev-parse', '--show-toplevel']).trim();
    return out;
  } catch {
    return process.cwd();
  }
}

function parseChangedLineRanges(diffOutput: string): Map<string, LineRange[]> {
  const ranges = new Map<string, LineRange[]>();
  let currentPath: string | null = null;
  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice('+++ b/'.length);
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      currentPath = null;
      continue;
    }
    if (!currentPath || !line.startsWith('@@')) continue;

    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    const startLine = Number(match[1]);
    const length = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(startLine) || !Number.isFinite(length)) continue;

    const endLine = length <= 0 ? startLine : startLine + length - 1;
    const pathRanges = ranges.get(currentPath) ?? [];
    pathRanges.push({ startLine, endLine });
    ranges.set(currentPath, pathRanges);
  }
  return ranges;
}

function overlapsChangedRange(row: SymbolRow, ranges: LineRange[]): boolean {
  if (ranges.length === 0) return true;
  const startLine = rowOptionalNumber(row, 'startLine', 2);
  const endLine = rowOptionalNumber(row, 'endLine', 3) ?? startLine;
  if (startLine === undefined || endLine === undefined) return true;
  return ranges.some((range) => startLine <= range.endLine && endLine >= range.startLine);
}

function createEvidenceId(nextId: number): string {
  return `ev-${nextId}`;
}

function pushEvidence(
  evidence: CommitAuditEvidence[],
  nextIdRef: { value: number },
  entry: Omit<CommitAuditEvidence, 'id'>,
): string {
  const id = createEvidenceId(nextIdRef.value++);
  evidence.push({ id, ...entry });
  return id;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function symbolEvidenceKey(filePath: string, symbolName: string): string {
  return `${filePath}::${symbolName}`;
}

function summarizeFreshness(freshness: CapabilityResponseFreshness): string | null {
  switch (freshness.status) {
    case 'stale':
      return `Audit freshness stale: indexed ${freshness.indexedHead ?? 'unknown'} vs target ${freshness.targetHead ?? 'unknown'}.`;
    case 'degraded':
      return freshness.reason === 'dirty-worktree-overlay'
        ? 'Audit freshness degraded: dirty worktree overlay in effect.'
        : `Audit freshness degraded: ${freshness.reason}.`;
    case 'unknown':
      return `Audit freshness unknown: ${freshness.reason}.`;
    default:
      return null;
  }
}

function createUnknownTargetContext(reason: string): TargetContext {
  return {
    version: 1,
    status: 'no-index',
    targetRef: 'HEAD',
    dirtyWorktree: null,
    changedSinceIndex: null,
    snapshotMode: 'unknown',
    qualityMode: 'balanced',
    embeddings: { status: 'unknown', reason },
    lsp: { status: 'unknown', reason },
    sidecar: { status: 'unknown', reason },
    policy: { status: 'unknown', reason },
    warnings: [`target context unavailable: ${reason}`],
  };
}

async function queryAffectedProcesses(
  repoId: string,
  nodeIds: string[],
  warnings: string[],
): Promise<{ affectedProcesses: AffectedProcess[]; processesAvailable: boolean }> {
  if (nodeIds.length === 0) {
    return { affectedProcesses: [], processesAvailable: true };
  }

  try {
    const rows = (await executeParameterized(
      repoId,
      `MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
       WHERE n.id IN $ids
       RETURN p.id AS pid, p.heuristicLabel AS name, p.processType AS processType,
              count(DISTINCT n.id) AS changedStepCount
       ORDER BY changedStepCount DESC
       LIMIT 50`,
      { ids: nodeIds },
    )) as ProcessRow[];

    const seen = new Map<string, AffectedProcess>();
    for (const row of rows) {
      const id = rowString(row, 'pid', 0);
      if (!id || seen.has(id)) continue;
      seen.set(id, {
        id,
        name: rowString(row, 'name', 1, '(unknown process)'),
        processType: rowString(row, 'processType', 2, 'unknown'),
        changedStepCount: rowNumber(row, 'changedStepCount', 3),
      });
    }
    return { affectedProcesses: Array.from(seen.values()), processesAvailable: true };
  } catch (err) {
    warnings.push(
      `process enrichment unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { affectedProcesses: [], processesAvailable: false };
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function gnPreCommitAudit(
  repoId: string,
  params: PreCommitAuditParams,
): Promise<CommitAuditReport> {
  const warnings: string[] = [];
  const repoRoot = resolveRepoRoot();
  const evidence: CommitAuditEvidence[] = [];
  const evidenceIdRef = { value: 1 };
  const capabilitiesMissing = new Set<string>();
  const capabilitiesUsed = [
    'git-diff',
    'graph-symbol-audit',
    'graph-impact-counts',
    'graph-test-coverage',
    'reviewer-history',
    'target-context',
  ];
  const limits: CommitAuditReport['limits'] = {
    maxChangedPaths: MAX_CHANGED_PATHS,
    maxReviewerPaths: MAX_REVIEWER_PATHS,
    maxSymbolsPerFile: MAX_SYMBOLS_PER_FILE,
  };

  const targetContext = await resolveTargetContext({ repo: repoId })
    .catch(() => resolveTargetContext())
    .catch((err) => createUnknownTargetContext(err instanceof Error ? err.message : String(err)));
  const freshness = deriveEnvelopeFreshness(targetContext);
  const freshnessWarning = summarizeFreshness(freshness);
  if (freshnessWarning !== null) {
    warnings.push(freshnessWarning);
    pushEvidence(evidence, evidenceIdRef, {
      kind: 'freshness',
      summary: freshnessWarning,
      status:
        freshness.status === 'stale' || freshness.status === 'degraded' ? 'degraded' : 'warning',
    });
  }
  if (freshness.status === 'stale') capabilitiesMissing.add('fresh-index');
  if (freshness.status === 'degraded') capabilitiesMissing.add('clean-worktree');
  if (freshness.status === 'unknown') capabilitiesMissing.add('target-context');
  if (targetContext.dirtyWorktree === true) {
    capabilitiesMissing.add('clean-worktree');
    const dirtyWarning = 'Audit target context includes a dirty worktree overlay.';
    warnings.push(dirtyWarning);
    pushEvidence(evidence, evidenceIdRef, {
      kind: 'freshness',
      summary: dirtyWarning,
      status: 'degraded',
    });
  }

  const baseReport = (input: {
    verdict: CommitAuditReport['verdict'];
    reasoning: string;
    changedFiles?: CommitAuditReport['changedFiles'];
    unexpectedSymbols?: string[];
    testCoverageDelta?: CommitAuditReport['testCoverageDelta'];
    suggestedReviewers?: string[];
    preCommitChecklist: CommitAuditReport['preCommitChecklist'];
    warnings?: string[];
    docEvidence?: AdvisoryDocsEvidenceReport;
    recommendations?: OrganicRecommendation[];
    affectedProcesses?: AffectedProcess[];
    graphSections?: CommitAuditReport['graphSections'];
  }): CommitAuditReport => {
    const recommendations = input.recommendations ?? [];
    const docEvidence = input.docEvidence;
    if (docEvidence !== undefined && docEvidence.sidecar.status !== 'available') {
      capabilitiesMissing.add('docs-sidecar');
    }
    const combinedWarnings = uniqueStrings([
      ...warnings,
      ...targetContext.warnings,
      ...(input.warnings ?? []),
      ...(docEvidence !== undefined && docEvidence.sidecar.status !== 'available'
        ? [
            `Docs evidence sidecar ${docEvidence.sidecar.status}; advisory docs quality is degraded.`,
          ]
        : []),
    ]);
    const nextTools = uniqueStrings(
      recommendations.flatMap((recommendation) => recommendation.nextTools),
    );
    const status: CommitAuditReport['status'] =
      freshness.status === 'stale' ||
      freshness.status === 'degraded' ||
      capabilitiesMissing.size > 0 ||
      combinedWarnings.length > 0
        ? 'degraded'
        : 'ok';

    return {
      version: 1,
      verdict: input.verdict,
      reasoning: input.reasoning,
      basedOnReads: summarizeBasedOnReads(),
      changedFiles: input.changedFiles ?? [],
      unexpectedSymbols: input.unexpectedSymbols ?? [],
      testCoverageDelta: input.testCoverageDelta ?? {
        coveredBefore: 0,
        coveredAfter: 0,
        deltaPp: 0,
      },
      suggestedReviewers: input.suggestedReviewers,
      preCommitChecklist: input.preCommitChecklist,
      warnings: combinedWarnings,
      ...(docEvidence ? { docEvidence, relatedDocs: docEvidence.relatedDocs } : {}),
      status,
      targetContext,
      freshness,
      capabilitiesUsed,
      capabilitiesMissing: [...capabilitiesMissing].sort(),
      limits,
      nextTools,
      evidence,
      recommendations,
      affectedProcesses: input.affectedProcesses ?? [],
      graphSections: input.graphSections ?? {
        processesAvailable: true,
        hunkCoverageAvailable: true,
      },
    };
  };

  // ---- 1. Build git diff args per scope ----------------------------------
  const scope = params.scope ?? 'staged';
  let diffArgs: string[];
  let patchArgs: string[];
  switch (scope) {
    case 'staged':
      diffArgs = ['diff', '--cached', '--name-only'];
      patchArgs = ['diff', '--cached', '--unified=0'];
      break;
    case 'unstaged':
      diffArgs = ['diff', '--name-only'];
      patchArgs = ['diff', '--unified=0'];
      break;
    case 'all':
      diffArgs = ['diff', 'HEAD', '--name-only'];
      patchArgs = ['diff', 'HEAD', '--unified=0'];
      break;
    case 'branch':
      diffArgs = ['diff', 'main...HEAD', '--name-only'];
      patchArgs = ['diff', 'main...HEAD', '--unified=0'];
      break;
    default:
      diffArgs = ['diff', '--cached', '--name-only'];
      patchArgs = ['diff', '--cached', '--unified=0'];
  }

  // ---- 2. Get changed file paths -----------------------------------------
  let changedPaths: string[] = [];
  let changedPathScanCapped = false;
  let graphQueryFailed = false;
  try {
    const out = gitCapture(repoRoot, diffArgs);
    changedPaths = out.split('\n').filter(Boolean);
    if (changedPaths.length > MAX_CHANGED_PATHS) {
      changedPaths = changedPaths.slice(0, MAX_CHANGED_PATHS);
      changedPathScanCapped = true;
      warnings.push(`Changed file scan capped at ${MAX_CHANGED_PATHS} paths`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return baseReport({
      verdict: 'DO-NOT-COMMIT',
      reasoning: 'git diff failed — cannot audit without diff output',
      preCommitChecklist: [{ check: 'git diff reachable', passed: false, detail: msg }],
      warnings: [`git diff failed: ${msg}`],
    });
  }

  // ---- 3. Empty diff — nothing to audit ---------------------------------
  if (changedPaths.length === 0) {
    return baseReport({
      verdict: 'READY',
      reasoning: 'No staged changes to audit',
      preCommitChecklist: [{ check: 'staged diff non-empty', passed: false, detail: 'no changes' }],
    });
  }

  let changedLineRanges = new Map<string, LineRange[]>();
  let hunkCoverageAvailable = true;
  try {
    changedLineRanges = parseChangedLineRanges(gitCapture(repoRoot, patchArgs));
  } catch (err) {
    hunkCoverageAvailable = false;
    capabilitiesMissing.add('changed-hunks');
    warnings.push(
      `git diff hunks unavailable; falling back to file-level symbol audit: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // ---- 4. Per-file: find symbols + impact --------------------------------
  const changedFiles: CommitAuditReport['changedFiles'] = [];
  const allChangedSymbolNames: string[] = [];
  const docsEvidenceTargets: AdvisoryDocsEvidenceTarget[] = [];

  recordEvidenceReadSafe({
    readClass: 'graph_evidence',
    surface: 'mcp',
    tool: 'gn_pre_commit_audit',
    target: params.scope || 'staged',
    targetType: 'scope',
    repo: repoId,
  });

  const allChangedNodeIds: string[] = [];
  const symbolEvidenceIds = new Map<string, string[]>();
  const hunkEvidenceIds = new Map<string, string[]>();
  const changedFilesWithoutCoverage = new Set<string>();

  for (const filePath of changedPaths) {
    docsEvidenceTargets.push({ filePath });
    const ranges = changedLineRanges.get(filePath) ?? [];
    const fileHunkEvidenceIds =
      ranges.length > 0
        ? ranges.map((range) =>
            pushEvidence(evidence, evidenceIdRef, {
              kind: 'hunk',
              summary: `${filePath} changed lines ${range.startLine}-${range.endLine}.`,
              status: 'info',
              filePath,
              startLine: range.startLine,
              endLine: range.endLine,
            }),
          )
        : [
            pushEvidence(evidence, evidenceIdRef, {
              kind: 'hunk',
              summary: hunkCoverageAvailable
                ? `${filePath} changed, but hunk-level line spans were not available.`
                : `${filePath} changed; audit fell back to file-level hunk coverage.`,
              status: hunkCoverageAvailable ? 'info' : 'warning',
              filePath,
            }),
          ];
    hunkEvidenceIds.set(filePath, fileHunkEvidenceIds);
    // Find symbols defined in this file
    let symbolRows: SymbolRow[] = [];
    try {
      symbolRows = (await executeParameterized(
        repoId,
        `MATCH (f:File {filePath: $path})-[r:CodeRelation {type: 'DEFINES'}]->(s)
         RETURN s.id AS id, s.name AS name, s.startLine AS startLine, s.endLine AS endLine LIMIT ${MAX_SYMBOLS_PER_FILE}`,
        { path: filePath },
      )) as SymbolRow[];
      symbolRows = symbolRows
        .filter((row) => overlapsChangedRange(row, ranges))
        .slice(0, MAX_SYMBOLS_PER_FILE);
    } catch (err) {
      graphQueryFailed = true;
      warnings.push(
        `graph query failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const changedSymbolNames: string[] = [];
    let totalUpstream = 0;
    let totalDownstream = 0;

    for (const row of symbolRows) {
      const symbolId = rowString(row, 'id', 0);
      const symbolName = rowString(row, 'name', 1, '(unknown)');

      const startLine = rowOptionalNumber(row, 'startLine', 2);
      const endLine = rowOptionalNumber(row, 'endLine', 3);
      if (symbolName && symbolName !== '(unknown)') {
        changedSymbolNames.push(symbolName);
        allChangedSymbolNames.push(symbolName);
        docsEvidenceTargets.push({ nodeId: symbolId, name: symbolName, filePath });
      }

      if (!symbolId) continue;

      // Upstream count (callers)
      let upstreamCount = 0;
      try {
        const upRows = (await executeParameterized(
          repoId,
          `MATCH (caller)-[r:CodeRelation]->(target {id: $id})
           WHERE r.type IN ['CALLS', 'REFERENCES']
           RETURN count(*) AS count`,
          { id: symbolId },
        )) as CountRow[];
        upstreamCount = upRows.length > 0 ? rowNumber(upRows[0], 'count', 0) : 0;
      } catch (err) {
        graphQueryFailed = true;
        warnings.push(
          `upstream impact graph query failed for ${symbolName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Downstream count (callees)
      let downstreamCount = 0;
      try {
        const downRows = (await executeParameterized(
          repoId,
          `MATCH (target {id: $id})-[r:CodeRelation]->(callee)
           WHERE r.type IN ['CALLS', 'REFERENCES', 'IMPORTS']
           RETURN count(*) AS count`,
          { id: symbolId },
        )) as CountRow[];
        downstreamCount = downRows.length > 0 ? rowNumber(downRows[0], 'count', 0) : 0;
      } catch (err) {
        graphQueryFailed = true;
        warnings.push(
          `downstream impact graph query failed for ${symbolName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      totalUpstream += upstreamCount;
      totalDownstream += downstreamCount;
      const evidenceId = pushEvidence(evidence, evidenceIdRef, {
        kind: 'symbol',
        summary: `${symbolName} in ${filePath} has ${upstreamCount} upstream caller(s), ${downstreamCount} downstream dependency(ies), and ${classifyRisk(upstreamCount)} risk.`,
        status: classifyRisk(upstreamCount) === 'HIGH' ? 'warning' : 'info',
        filePath,
        ...(startLine !== undefined ? { startLine } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
        symbolName,
        ...(symbolId ? { nodeId: symbolId } : {}),
        relatedEvidenceIds: fileHunkEvidenceIds,
      });
      symbolEvidenceIds.set(symbolEvidenceKey(filePath, symbolName), [evidenceId]);
      if (symbolId) allChangedNodeIds.push(symbolId);
    }

    const risk = classifyRisk(totalUpstream);

    changedFiles.push({
      path: filePath,
      changedSymbols: changedSymbolNames,
      perSymbolImpact: { upstream: totalUpstream, downstream: totalDownstream, risk },
    });
  }

  // ---- 5. Unexpected symbols ---------------------------------------------
  const unexpectedSymbols: string[] = [];
  if (params.expectedSymbols !== undefined && params.expectedSymbols.length > 0) {
    const expectedSet = new Set(params.expectedSymbols);
    for (const name of allChangedSymbolNames) {
      if (!expectedSet.has(name)) {
        unexpectedSymbols.push(name);
      }
    }
  }

  // ---- 6. Test coverage delta (heuristic) --------------------------------
  // Count test files importing changed files (before/after distinction is
  // approximate — deltaPp is 0 if no test file pattern matches changed paths).
  let coveredAfter = 0;
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
        pushEvidence(evidence, evidenceIdRef, {
          kind: 'coverage',
          summary: `${filePath} has ${testRows.length} linked test import(s) in graph coverage.`,
          status: 'info',
          filePath,
          relatedEvidenceIds: hunkEvidenceIds.get(filePath) ?? [],
        });
      } else {
        changedFilesWithoutCoverage.add(filePath);
        pushEvidence(evidence, evidenceIdRef, {
          kind: 'coverage',
          summary: `${filePath} has no linked test imports in graph coverage evidence.`,
          status: 'warning',
          filePath,
          relatedEvidenceIds: hunkEvidenceIds.get(filePath) ?? [],
        });
      }
    } catch (err) {
      graphQueryFailed = true;
      capabilitiesMissing.add('graph-test-coverage');
      warnings.push(
        `test coverage graph query failed for ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const coveredBefore = coveredAfter; // heuristic: pre-commit count unknown statically
  const deltaPp = 0; // static analysis cannot compute true delta

  const testCoverageDelta = { coveredBefore, coveredAfter, deltaPp };

  const { affectedProcesses, processesAvailable } = await queryAffectedProcesses(
    repoId,
    uniqueStrings(allChangedNodeIds),
    warnings,
  );
  if (!processesAvailable) {
    graphQueryFailed = true;
    capabilitiesMissing.add('process-enrichment');
  } else {
    capabilitiesUsed.push('process-enrichment');
  }
  const processEvidenceIds = affectedProcesses.map((process) =>
    pushEvidence(evidence, evidenceIdRef, {
      kind: 'process',
      summary: `${process.name} (${process.processType}) contains ${process.changedStepCount} changed step(s).`,
      status: 'info',
      processId: process.id,
      processType: process.processType,
    }),
  );

  // ---- 7. Suggested reviewers (best-effort) ------------------------------
  let suggestedReviewers: string[] | undefined;
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

  // ---- 8. Verdict synthesis ----------------------------------------------
  const hasHighRisk = changedFiles.some((f) => f.perSymbolImpact.risk === 'HIGH');
  const hasUnexpected = unexpectedSymbols.length > 0 && params.expectedSymbols !== undefined;
  const coverageDrop = deltaPp < -5;

  let verdict: CommitAuditReport['verdict'];
  let reasoning: string;

  if (hasHighRisk) {
    verdict = 'DO-NOT-COMMIT';
    const highFiles = changedFiles
      .filter((f) => f.perSymbolImpact.risk === 'HIGH')
      .map((f) => f.path)
      .join(', ');
    reasoning = `HIGH-risk symbols changed in: ${highFiles}. Upstream impact > 50 callers. Manual review required before committing.`;
  } else if (graphQueryFailed || changedPathScanCapped || hasUnexpected || coverageDrop) {
    verdict = 'REVIEW';
    const reasons: string[] = [];
    if (graphQueryFailed) {
      reasons.push('graph audit incomplete');
    }
    if (changedPathScanCapped) {
      reasons.push(`changed file scan capped at ${MAX_CHANGED_PATHS} paths`);
    }
    if (hasUnexpected) {
      reasons.push(`unexpected symbols changed: ${unexpectedSymbols.slice(0, 5).join(', ')}`);
    }
    if (coverageDrop) {
      reasons.push(`test coverage dropped by ${Math.abs(deltaPp).toFixed(1)}pp`);
    }
    reasoning = `Review required: ${reasons.join('; ')}.`;
  } else {
    verdict = 'READY';
    reasoning = `All ${changedPaths.length} changed file(s) have LOW/MEDIUM risk symbols. No unexpected symbols. Coverage held.`;
  }

  // ---- 9. Pre-commit checklist -------------------------------------------
  const preCommitChecklist: CommitAuditReport['preCommitChecklist'] = [
    {
      check: 'staged diff non-empty',
      passed: changedPaths.length > 0,
      detail: `${changedPaths.length} file(s) changed`,
    },
    {
      check: 'changed file scan complete',
      passed: !changedPathScanCapped,
      detail: changedPathScanCapped
        ? `audit capped at ${MAX_CHANGED_PATHS} changed paths; review required`
        : 'all changed paths included in audit',
    },
    {
      check: 'graph audit complete',
      passed: !graphQueryFailed,
      detail: graphQueryFailed
        ? 'one or more graph queries failed; manual review required'
        : 'graph queries completed',
    },
    {
      check: 'no HIGH-risk symbols',
      passed: !hasHighRisk,
      detail: hasHighRisk
        ? 'HIGH-risk impact detected — upstream callers > 50'
        : 'all symbol risks are LOW or MEDIUM',
    },
    {
      check: 'symbols match expected scope',
      passed: !hasUnexpected,
      detail: hasUnexpected
        ? `unexpected: ${unexpectedSymbols.slice(0, 3).join(', ')}`
        : params.expectedSymbols !== undefined
          ? 'all changed symbols are within expected scope'
          : 'expectedSymbols not provided — skipped',
    },
    {
      check: 'test coverage stable',
      passed: !coverageDrop,
      detail: coverageDrop
        ? `coverage dropped ${Math.abs(deltaPp).toFixed(1)}pp`
        : 'coverage held or improved',
    },
  ];
  const docsEvidence =
    params.docsEvidence === true
      ? await collectAdvisoryDocsEvidence(repoId, docsEvidenceTargets)
      : undefined;
  const recommendations: OrganicRecommendation[] = [];
  const pushRecommendation = (draft: Parameters<typeof emitOrganicRecommendation>[0]) => {
    if (recommendations.length >= MAX_RECOMMENDATIONS) return;
    try {
      recommendations.push(emitOrganicRecommendation(draft));
    } catch (err) {
      warnings.push(
        `organic recommendation rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  changedFiles
    .filter((file) => file.perSymbolImpact.risk === 'HIGH')
    .slice(0, MAX_RECOMMENDATIONS)
    .forEach((file, index) => {
      const fileSymbolEvidenceIds = file.changedSymbols.flatMap(
        (symbolName) => symbolEvidenceIds.get(symbolEvidenceKey(file.path, symbolName)) ?? [],
      );
      pushRecommendation({
        id: `pre-commit-high-risk-${index + 1}`,
        action: 'review-high-risk-change',
        target: { kind: 'file', name: file.path, filePath: file.path },
        reason: `${file.path} is backed by ${fileSymbolEvidenceIds[0] ?? 'ev-unknown'} and carries HIGH pre-commit risk before commit.`,
        confidence: 'high',
        evidenceIds: uniqueStrings([
          ...(hunkEvidenceIds.get(file.path) ?? []),
          ...fileSymbolEvidenceIds,
          ...processEvidenceIds,
        ]),
        evidenceClasses: ['graph_evidence', 'runtime_diagnostic'],
        nextTools: ['gn_review_diff', 'gn_verify_diff'],
        scoreTrace: {
          upstream: file.perSymbolImpact.upstream,
          downstream: file.perSymbolImpact.downstream,
          risk: file.perSymbolImpact.risk,
        },
      });
    });

  unexpectedSymbols
    .slice(0, MAX_RECOMMENDATIONS - recommendations.length)
    .forEach((symbolName, index) => {
      const file = changedFiles.find((entry) => entry.changedSymbols.includes(symbolName));
      if (!file) return;
      const symbolKey = symbolEvidenceKey(file.path, symbolName);
      pushRecommendation({
        id: `pre-commit-unexpected-${index + 1}`,
        action: 'review-unexpected-scope',
        target: { kind: 'symbol', name: symbolName, filePath: file.path },
        reason: `${symbolName} is backed by ${(symbolEvidenceIds.get(symbolKey) ?? ['ev-unknown'])[0]} and sits outside expectedSymbols scope.`,
        confidence: 'medium',
        evidenceIds: uniqueStrings([
          ...(symbolEvidenceIds.get(symbolKey) ?? []),
          ...(hunkEvidenceIds.get(file.path) ?? []),
        ]),
        evidenceClasses: ['graph_evidence', 'runtime_diagnostic'],
        nextTools: ['gn_verify_diff', 'gn_review_diff'],
        scoreTrace: { unexpected: true, filePath: file.path },
      });
    });

  Array.from(changedFilesWithoutCoverage)
    .slice(0, MAX_RECOMMENDATIONS - recommendations.length)
    .forEach((filePath, index) => {
      const file = changedFiles.find((entry) => entry.path === filePath);
      const fileSymbolEvidenceIds =
        file?.changedSymbols.flatMap(
          (symbolName) => symbolEvidenceIds.get(symbolEvidenceKey(filePath, symbolName)) ?? [],
        ) ?? [];
      const coverageEvidenceIds = evidence
        .filter(
          (entry) =>
            entry.kind === 'coverage' && entry.filePath === filePath && entry.status === 'warning',
        )
        .map((entry) => entry.id);
      pushRecommendation({
        id: `pre-commit-coverage-${index + 1}`,
        action: 'review-test-gap',
        target: { kind: 'file', name: filePath, filePath },
        reason: `${filePath} is referenced by ${coverageEvidenceIds[0] ?? 'ev-unknown'} and lacks linked graph coverage before commit.`,
        confidence: 'medium',
        evidenceIds: uniqueStrings([
          ...coverageEvidenceIds,
          ...(hunkEvidenceIds.get(filePath) ?? []),
          ...fileSymbolEvidenceIds,
        ]),
        evidenceClasses: ['graph_evidence', 'runtime_diagnostic'],
        nextTools: ['gn_test_gap', 'gn_verify_diff'],
        scoreTrace: { coveredAfter: 0, deltaPp: testCoverageDelta.deltaPp },
      });
    });

  return baseReport({
    verdict,
    reasoning,
    changedFiles,
    unexpectedSymbols,
    testCoverageDelta,
    suggestedReviewers,
    preCommitChecklist,
    docEvidence: docsEvidence,
    recommendations,
    affectedProcesses,
    graphSections: {
      processesAvailable,
      hunkCoverageAvailable,
    },
  });
}
