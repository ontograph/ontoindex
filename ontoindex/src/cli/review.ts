/**
 * CLI `review` command group — REV-2.
 *
 * Adds `ontoindex review diff` for local, graph-aware diff review.
 * Works without MCP or hosted credentials.
 * Output is wrapped in the ADR 0018 envelope so agents and humans can
 * distinguish fresh graph facts from stale or candidate-only output.
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { getGitRoot } from '../storage/git.js';
import { getStoragePaths, loadMeta } from '../storage/repo-manager.js';
import { initLbug, closeLbug } from '../core/lbug/pool-adapter.js';
import { buildDiffReview } from '../core/review/diff-review.js';
import type { DiffReviewResult } from '../core/review/review-types.js';
import { resolveTargetContext } from '../mcp/shared/target-context.js';
import type { TargetContext } from '../mcp/shared/target-context.js';
import {
  deriveEnvelopeFreshness,
  createCapabilityResponseEnvelope,
  type CapabilityResponseFreshness,
} from '../mcp/shared/response-envelope.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_CHANGED_PATHS = 500;
const REVIEW_DIFF_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewDiffOptions {
  base?: string;
  head?: string;
  range?: string;
  staged?: boolean;
  json?: boolean;
  repo?: string;
}

export interface ReviewDiffArgs {
  nameOnly: string[];
  numstat: string[];
  resolvedRange: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Build git diff args from CLI options.
 * Priority: --range > --base[+--head] > --staged > default (staged).
 */
export function buildReviewDiffArgs(opts: ReviewDiffOptions): ReviewDiffArgs {
  if (opts.range) {
    return {
      nameOnly: ['diff', opts.range, '--name-only'],
      numstat: ['diff', opts.range, '--numstat'],
      resolvedRange: opts.range,
    };
  }
  if (opts.base) {
    const head = opts.head ?? 'HEAD';
    const range = `${opts.base}..${head}`;
    return {
      nameOnly: ['diff', range, '--name-only'],
      numstat: ['diff', range, '--numstat'],
      resolvedRange: range,
    };
  }
  // --staged or default
  return {
    nameOnly: ['diff', '--cached', '--name-only'],
    numstat: ['diff', '--cached', '--numstat'],
    resolvedRange: '--cached',
  };
}

/** Parse `git diff --numstat` output → map of path → { added, removed }. */
export function parseReviewNumstat(
  output: string,
): Map<string, { added: number; removed: number }> {
  const result = new Map<string, { added: number; removed: number }>();
  for (const line of output.split('\n').filter(Boolean)) {
    // numstat format: "<added>\t<removed>\t<path>"
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = Number(parts[0]) || 0;
    const removed = Number(parts[1]) || 0;
    const filePath = parts.slice(2).join('\t');
    result.set(filePath, { added, removed });
  }
  return result;
}

/**
 * Format a compact text summary of the diff review.
 * Honest about stale or partial inputs.
 * REV-3: includes optional process/community sections.
 */
export function formatReviewDiffText(
  resolvedRange: string,
  result: DiffReviewResult,
  freshnessStatus: string,
  freshnessReason: string,
  warnings: string[],
): string {
  const lines: string[] = [];

  lines.push(`review diff: ${resolvedRange}`);
  lines.push(`freshness: ${freshnessStatus} — ${freshnessReason}`);
  lines.push(`files: ${result.reviewedFiles.length}  symbols: ${result.totalSymbolsChanged}`);

  if (result.highRiskSymbols.length > 0) {
    lines.push(`high-risk: ${result.highRiskSymbols.join(', ')}`);
  }

  for (const file of result.reviewedFiles) {
    const lineStat =
      file.addedLines || file.removedLines ? ` (+${file.addedLines} -${file.removedLines})` : '';
    lines.push(`\n  ${file.path}${lineStat}`);
    for (const sym of file.changedSymbols) {
      const heuristic = sym.impact.heuristic ? '~' : '';
      lines.push(
        `    [${sym.impact.risk}] ${sym.name}  ↑${heuristic}${sym.impact.upstreamCount} callers  ↓${sym.impact.downstreamCount} deps`,
      );
    }
  }

  // ---- REV-3: affected processes section ------------------------------------
  const gs = result.graphSections;
  if (gs?.processesAvailable === false) {
    lines.push(`\nprocesses: unavailable`);
  } else if (result.affectedProcesses && result.affectedProcesses.length > 0) {
    lines.push(`\nprocesses (${result.affectedProcesses.length}):`);
    for (const p of result.affectedProcesses) {
      lines.push(`  • ${p.name} [${p.processType}]  steps changed: ${p.changedStepCount}`);
    }
  }

  // ---- REV-3: affected communities section ----------------------------------
  if (gs?.communitiesAvailable === false) {
    lines.push(`communities: unavailable`);
  } else if (result.affectedCommunities && result.affectedCommunities.length > 0) {
    lines.push(`communities (${result.affectedCommunities.length}):`);
    for (const c of result.affectedCommunities) {
      lines.push(`  • ${c.name}  symbols changed: ${c.changedSymbolCount}`);
    }
  }

  // ---- REV-3: cross-community risk hints ------------------------------------
  if (result.crossCommunityRiskReasons && result.crossCommunityRiskReasons.length > 0) {
    lines.push(`cross-community hints:`);
    for (const r of result.crossCommunityRiskReasons) {
      lines.push(`  ⚑ ${r}`);
    }
  }

  if (warnings.length > 0) {
    lines.push(`\nwarnings:`);
    for (const w of warnings) {
      lines.push(`  • ${w}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function emitOutput(
  json: boolean | undefined,
  resolvedRange: string,
  result: DiffReviewResult,
  targetContext: TargetContext,
  freshness: CapabilityResponseFreshness,
  warnings: string[],
): void {
  const allWarnings = [...new Set([...result.warnings, ...warnings])];

  if (json) {
    const envelope = createCapabilityResponseEnvelope({
      tool: 'review_diff',
      version: REVIEW_DIFF_VERSION,
      status:
        freshness.status === 'stale' || freshness.status === 'degraded' || allWarnings.length > 0
          ? 'degraded'
          : 'ok',
      targetContext,
      capabilitiesUsed: ['git-diff', 'graph-review', 'blast-radius'],
      freshness,
      results: {
        resolvedRange,
        reviewedFiles: result.reviewedFiles,
        totalSymbolsChanged: result.totalSymbolsChanged,
        highRiskSymbols: result.highRiskSymbols,
        affectedProcesses: result.affectedProcesses ?? [],
        affectedCommunities: result.affectedCommunities ?? [],
        crossCommunityRiskReasons: result.crossCommunityRiskReasons ?? [],
        graphSections: result.graphSections ?? null,
      },
      warnings: allWarnings,
      limits: { maxChangedPaths: MAX_CHANGED_PATHS },
    });
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    console.log(
      formatReviewDiffText(resolvedRange, result, freshness.status, freshness.reason, allWarnings),
    );
  }
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export async function reviewDiffCommand(opts: ReviewDiffOptions): Promise<void> {
  // Resolve git root
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

  const { nameOnly, numstat, resolvedRange } = buildReviewDiffArgs(opts);
  const warnings: string[] = [];

  // ---- 1. Git diff: changed paths ------------------------------------------
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: git diff failed: ${msg}`);
    process.exitCode = 1;
    return;
  }

  // ---- 2. Target context for provenance envelope ---------------------------
  const targetContext = await resolveTargetContext({ repo: opts.repo ?? repoRoot });
  const freshness = deriveEnvelopeFreshness(targetContext);

  // ---- 3. Empty diff — fast path -------------------------------------------
  if (changedPaths.length === 0) {
    emitOutput(
      opts.json,
      resolvedRange,
      { reviewedFiles: [], totalSymbolsChanged: 0, highRiskSymbols: [], warnings: [] },
      targetContext,
      freshness,
      warnings,
    );
    return;
  }

  // ---- 4. Line count stats --------------------------------------------------
  let numstatMap = new Map<string, { added: number; removed: number }>();
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

  // ---- 5. Graph-aware symbol review (needs an indexed repo) ----------------
  const { storagePath, lbugPath } = getStoragePaths(repoRoot);
  const meta = await loadMeta(storagePath);

  let reviewResult: DiffReviewResult;

  if (meta) {
    const repoId = path.basename(repoRoot).toLowerCase();
    try {
      await initLbug(repoId, lbugPath);
      const graphResult = await buildDiffReview(repoId, changedPaths, numstatMap);
      warnings.push(...graphResult.warnings);
      reviewResult = { ...graphResult, warnings };
    } catch (err) {
      warnings.push(
        `graph review failed, showing file list only: ${err instanceof Error ? err.message : String(err)}`,
      );
      reviewResult = fileListFallback(changedPaths, numstatMap, warnings);
    } finally {
      const repoId = path.basename(repoRoot).toLowerCase();
      try {
        await closeLbug(repoId);
      } catch {
        // best-effort
      }
    }
  } else {
    warnings.push(
      'no OntoIndex index found; symbol analysis unavailable — run `ontoindex analyze` first',
    );
    reviewResult = fileListFallback(changedPaths, numstatMap, warnings);
  }

  emitOutput(opts.json, resolvedRange, reviewResult, targetContext, freshness, warnings);
}

function fileListFallback(
  changedPaths: string[],
  numstatMap: Map<string, { added: number; removed: number }>,
  warnings: string[],
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
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerReviewCommands(program: Command): void {
  const review = program
    .command('review')
    .description('Graph-aware code review commands (local-only; no hosted provider required)');

  review
    .command('diff')
    .description(
      'Review changed symbols and blast radius for a local git diff.\n' +
        'Works entirely offline — no GitHub/GitLab credentials or MCP session required.\n' +
        'Requires a OntoIndex index for full symbol and graph analysis.\n' +
        'Run `ontoindex analyze` first if the index is missing or stale.',
    )
    .option('--base <ref>', 'Base git ref for diff (e.g. main, HEAD~5)')
    .option('--head <ref>', 'Head git ref (default: HEAD; used with --base)')
    .option('--range <range>', 'Explicit diff range (e.g. main...feature), overrides --base/--head')
    .option('--staged', 'Compare staged changes only (default when no range is given)')
    .option('--json', 'Emit ADR 0018 JSON envelope (machine-readable)')
    .option('-r, --repo <name>', 'Indexed repository name or path (default: current git root)')
    .addHelpText(
      'after',
      `
Examples:
  # Staged changes (default — review what you are about to commit):
  ontoindex review diff
  ontoindex review diff --staged

  # Branch diff against main (review a feature branch):
  ontoindex review diff --base main
  ontoindex review diff --base main --head HEAD

  # Explicit range:
  ontoindex review diff --range main...feature/my-branch

  # Last 5 commits:
  ontoindex review diff --range HEAD~5..HEAD

  # JSON output (ADR 0018 envelope — for agents or CI):
  ontoindex review diff --base main --json

Fresh index:
  Run this before reviewing if the repo has changed since the last analyze:
    ontoindex analyze
  Then review:
    ontoindex review diff --base main

Stale or missing index:
  If no index is found, file names are still listed but symbol/blast-radius
  analysis is skipped.  The output includes a warning and the suggested command.

Hosted PR export:
  Use \`ontoindex export review-bundle\` to write a deterministic snapshot bundle
  (freshness.json, graph-summary.json, risk-summary.json, REVIEW_REPORT.md) under
  .ontoindex/review/ (gitignored).
`,
    )
    .action(reviewDiffCommand);
}
