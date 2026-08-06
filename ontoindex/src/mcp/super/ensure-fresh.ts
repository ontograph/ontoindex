/**
 * gn_ensure_fresh — Index lifecycle helper super-function.
 *
 * Reports whether the OntoIndex index is stale (indexed commit ≠ current HEAD),
 * surfaces embeddings status, and optionally submits a durable `ontoindex analyze`
 * job when `autoAnalyze: true` is passed.
 *
 * This is a READ-ONLY super-function by default (autoAnalyze defaults to false).
 * It never modifies the index without explicit caller consent.
 */

import { readFileSync } from 'fs';
import path, { join } from 'path';
import { homedir } from 'os';
import { execFileText } from '../../core/process/exec-file.js';
import {
  submitAnalysisJob,
  type AnalysisJobRecord,
} from '../../core/analysis/analysis-coordinator.js';
import {
  readRuntimeHealth,
  type RuntimeHealthSnapshot,
} from '../../core/runtime/runtime-health.js';
import { loadMeta, type RepoMeta } from '../../storage/repo-manager.js';
import type { ScopeConfidence } from '../shared/target-context.js';
import { resolveTargetContext } from '../shared/target-context.js';
import { createEnvelopeFromLegacy } from '../shared/response-envelope.js';

const GIT_PROBE_TIMEOUT_MS = 5_000;
const GIT_PROBE_MAX_BUFFER = 1024 * 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnsureFreshParams {
  repo?: string;
  withEmbeddings?: boolean; // default: false
  autoAnalyze?: boolean; // default: false (require explicit confirm)
  killMcpForLock?: boolean; // deprecated; advisory only for safety
  legacyResponse?: boolean; // default: true
}

export type EmbeddingDriftStatus = 'ok' | 'missing' | 'metadata-unavailable' | 'drifted';

export type AnalysisSubmission =
  | { status: 'not-requested' }
  | { status: 'not-needed' }
  | { status: 'blocked'; reasonCode: string; message: string }
  | { status: 'queued'; jobId: string }
  | { status: 'reused'; jobId: string }
  | {
      status: 'failed';
      errorCode: 'ANALYZE_JOB_SUBMISSION_FAILED';
      causeCode?: string;
      message: string;
    };

export interface EnsureFreshReport {
  version: 1;
  preCheck: { indexedCommit: string; currentCommit: string; isStale: boolean };
  embeddingsStatus: {
    count: number;
    required: boolean;
    status: EmbeddingDriftStatus;
    reason?: string;
    repairCommand?: string;
  };
  repoLabel?: string;
  repoPath?: string;
  indexedCommit?: string;
  headCommit?: string;
  isStale?: boolean;
  dirtyFileCount?: number | null;
  scopeConfidence?: ScopeConfidence;
  runtimeHealth?: RuntimeHealthSnapshot;
  actionsTaken: string[];
  analysisSubmission: AnalysisSubmission;
  analysisJob?: AnalysisJobRecord;
  postCheck?: { indexedCommit: string; currentCommit: string; isStale: boolean };
  warnings: string[];
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RegistryEntry {
  name?: string;
  path?: string;
  lastCommit?: string;
  stats?: {
    embeddings?: number;
  };
}

function parseRegistryJson(rawRegistry: string): RegistryEntry[] {
  const parsedRegistry: unknown = JSON.parse(rawRegistry);
  return parsedRegistry as RegistryEntry[];
}

/** Resolve the repo root via `git rev-parse --show-toplevel`, fallback to cwd. */
async function resolveCwdRepoRoot(): Promise<string> {
  try {
    return (
      await execFileText('git', ['rev-parse', '--show-toplevel'], {
        timeoutMs: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: GIT_PROBE_MAX_BUFFER,
      })
    ).trim();
  } catch {
    return process.cwd();
  }
}

function normalizeRepoPath(repoPath: string | undefined): string | null {
  if (!repoPath?.trim()) return null;
  return path.resolve(repoPath);
}

function buildRegistryIds(registry: RegistryEntry[]): Map<RegistryEntry, string> {
  const ids = new Map<RegistryEntry, string>();
  const seen = new Map<string, string>();
  for (const entry of registry) {
    const base = entry.name?.toLowerCase();
    const repoPath = normalizeRepoPath(entry.path);
    if (!base || !repoPath) continue;

    const previousPath = seen.get(base);
    if (previousPath && previousPath !== repoPath) {
      ids.set(entry, `${base}-${Buffer.from(repoPath).toString('base64url').slice(0, 6)}`);
    } else {
      seen.set(base, repoPath);
      ids.set(entry, base);
    }
  }
  return ids;
}

function findRegistryEntry(
  registry: RegistryEntry[],
  selector: string | undefined,
  cwdRepoRoot: string | undefined,
): RegistryEntry | undefined {
  const registryIds = buildRegistryIds(registry);
  const selectorLower = selector?.trim().toLowerCase();
  const selectorPath = normalizeRepoPath(selector);
  const cwdPath = normalizeRepoPath(cwdRepoRoot);

  if (selectorLower || selectorPath) {
    const selected = registry.find((entry) => {
      const entryName = entry.name?.toLowerCase();
      const entryPath = normalizeRepoPath(entry.path);
      return (
        (selectorLower !== undefined &&
          (entryName === selectorLower || registryIds.get(entry) === selectorLower)) ||
        (selectorPath !== null && entryPath === selectorPath)
      );
    });
    if (selected) return selected;
  }

  if (cwdPath) {
    return registry.find((entry) => normalizeRepoPath(entry.path) === cwdPath);
  }

  return undefined;
}

function registryEntryMatchesSelector(
  registry: RegistryEntry[],
  entry: RegistryEntry,
  selector: string,
): boolean {
  const registryIds = buildRegistryIds(registry);
  const selectorLower = selector.trim().toLowerCase();
  const selectorPath = normalizeRepoPath(selector);
  const entryName = entry.name?.toLowerCase();
  const entryPath = normalizeRepoPath(entry.path);

  return (
    (entryName !== undefined &&
      (entryName === selectorLower || registryIds.get(entry) === selectorLower)) ||
    (selectorPath !== null && entryPath === selectorPath)
  );
}

/** Build an empty report shell for early-return paths. */
function emptyReport(
  warnings: string[],
  recommendations: string[],
  extras: Partial<
    Pick<
      EnsureFreshReport,
      | 'repoLabel'
      | 'repoPath'
      | 'indexedCommit'
      | 'headCommit'
      | 'isStale'
      | 'dirtyFileCount'
      | 'scopeConfidence'
    >
  > = {},
  analysisSubmission: AnalysisSubmission = { status: 'not-requested' },
): EnsureFreshReport {
  return {
    version: 1,
    preCheck: { indexedCommit: '', currentCommit: '', isStale: false },
    embeddingsStatus: {
      count: 0,
      required: false,
      status: 'metadata-unavailable',
      reason: 'repo metadata is unavailable',
      repairCommand: 'ontoindex analyze',
    },
    ...extras,
    actionsTaken: [],
    analysisSubmission,
    warnings,
    recommendations,
  };
}

function currentCliCommand(): { command: string; argsPrefix: string[]; displayPrefix: string } {
  const cliEntry = process.env.ONTOINDEX_CLI_PATH || process.argv[1];
  if (cliEntry) {
    return {
      command: process.execPath,
      argsPrefix: [cliEntry],
      displayPrefix: `${process.execPath} ${cliEntry}`,
    };
  }
  return { command: 'ontoindex', argsPrefix: [], displayPrefix: 'ontoindex' };
}

async function countDirtyFiles(repoRoot: string): Promise<number | null> {
  try {
    const output = (
      await execFileText('git', ['status', '--porcelain'], {
        cwd: repoRoot,
        timeoutMs: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: GIT_PROBE_MAX_BUFFER,
      })
    ).trim();
    if (output.length === 0) return 0;
    return output.split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

function deriveScopeConfidence(input: {
  selectorProvided: boolean;
  cwdFallbackUsed: boolean;
  dirtyFileCount: number | null;
  isStale: boolean;
}): ScopeConfidence {
  if (!input.selectorProvided && input.cwdFallbackUsed) return 'medium';
  if (!input.selectorProvided) return 'unknown';
  if (input.dirtyFileCount === null) return input.isStale ? 'medium' : 'high';
  if (input.dirtyFileCount > 0 || input.isStale) return 'medium';
  return 'high';
}

function resolveEmbeddingsStatus(input: {
  repoMeta: RepoMeta | null;
  currentEmbeddingModelHash: string | undefined;
  isStale: boolean;
  withEmbeddings: boolean | undefined;
}): EnsureFreshReport['embeddingsStatus'] {
  const count = input.repoMeta?.stats?.embeddings ?? 0;
  const metadataHash = input.repoMeta?.model_hash?.trim() || undefined;
  const currentHash = input.currentEmbeddingModelHash?.trim() || undefined;
  const required = input.withEmbeddings === true && count === 0;

  if (!input.repoMeta) {
    return {
      count,
      required,
      status: 'metadata-unavailable',
      reason: 'repo meta.json is unavailable',
      repairCommand: 'ontoindex analyze',
    };
  }

  if (count === 0) {
    return {
      count,
      required,
      status: 'missing',
      reason: 'embeddings are not populated in repo metadata',
      repairCommand: `ontoindex analyze${input.isStale ? '' : ' --force'} --embeddings`,
    };
  }

  if (!metadataHash || !currentHash) {
    if (metadataHash && !currentHash) {
      return {
        count,
        required,
        status: 'ok',
        reason: 'runtime embedding model hash is not set; drift check skipped',
      };
    }
    return {
      count,
      required,
      status: 'metadata-unavailable',
      reason: !metadataHash
        ? 'embedding fingerprint is missing from repo metadata'
        : 'ONTOINDEX_EMBEDDING_MODEL_HASH is not set',
      repairCommand: 'ontoindex analyze --force --embeddings',
    };
  }

  if (metadataHash !== currentHash) {
    return {
      count,
      required,
      status: 'drifted',
      reason: `embedding model hash mismatch: meta.json has "${metadataHash}" but the current environment has "${currentHash}"`,
      repairCommand: 'ontoindex analyze --force --embeddings',
    };
  }

  return {
    count,
    required,
    status: 'ok',
  };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export function gnEnsureFresh(
  repoId: string,
  params: EnsureFreshParams & { legacyResponse: false },
): Promise<ReturnType<typeof createEnvelopeFromLegacy<EnsureFreshReport>>>;
export function gnEnsureFresh(
  repoId: string,
  params: EnsureFreshParams,
): Promise<EnsureFreshReport>;
export async function gnEnsureFresh(
  repoId: string,
  params: EnsureFreshParams,
): Promise<EnsureFreshReport | ReturnType<typeof createEnvelopeFromLegacy<EnsureFreshReport>>> {
  const report = await buildEnsureFreshReport(repoId, params);
  if (params.legacyResponse !== false) return report;
  const targetContext = await resolveTargetContext({
    repo: params.repo ?? repoId,
    verifyGraphAuthority: true,
    requiredGraphCapabilities: ['symbols'],
  });
  return createEnvelopeFromLegacy({
    legacy: report,
    tool: 'gn_ensure_fresh',
    status:
      report.analysisSubmission.status === 'failed'
        ? 'error'
        : report.analysisSubmission.status === 'blocked'
          ? 'degraded'
          : report.analysisJob
            ? report.analysisJob.status
            : 'success',
    targetContext,
    runtimeHealth: report.runtimeHealth,
    capabilitiesUsed: ['git', 'graph-metadata'],
    nextTools: report.analysisJob ? ['gn_analyze_job'] : [],
    omitResultKeys: [
      'runtimeHealth',
      'preCheck',
      'repoLabel',
      'repoPath',
      'indexedCommit',
      'headCommit',
      'isStale',
      'dirtyFileCount',
      'scopeConfidence',
      'postCheck',
    ],
  });
}

async function buildEnsureFreshReport(
  repoId: string,
  params: EnsureFreshParams,
): Promise<EnsureFreshReport> {
  const warnings: string[] = [];
  const recommendations: string[] = [];
  const actionsTaken: string[] = [];
  let analysisSubmission: AnalysisSubmission = params.autoAnalyze
    ? { status: 'not-needed' }
    : { status: 'not-requested' };

  // ---- 1. Read registry ---------------------------------------------------
  const registryPath = join(homedir(), '.ontoindex', 'registry.json');
  let registry: RegistryEntry[] = [];
  try {
    registry = parseRegistryJson(readFileSync(registryPath, 'utf8'));
  } catch (err) {
    warnings.push('cannot read ~/.ontoindex/registry.json: ' + String(err));
    return emptyReport(
      warnings,
      recommendations,
      {},
      params.autoAnalyze
        ? {
            status: 'blocked',
            reasonCode: 'REGISTRY_UNAVAILABLE',
            message: 'Repository registry is unavailable; analysis cannot be submitted.',
          }
        : { status: 'not-requested' },
    );
  }

  // ---- 2. Resolve the repo from the same registry semantics as MCP --------
  const selector = params.repo?.trim() || repoId.trim() || undefined;
  const cwdRepoRoot = selector ? undefined : await resolveCwdRepoRoot();
  const entry = findRegistryEntry(registry, selector, cwdRepoRoot);
  if (!entry) {
    return emptyReport(
      [...warnings, 'repo not in registry — run ontoindex analyze'],
      recommendations,
      {
        repoLabel: selector,
        repoPath: cwdRepoRoot ?? undefined,
        indexedCommit: '',
        headCommit: '',
        isStale: false,
        dirtyFileCount: null,
        scopeConfidence: selector ? 'low' : 'unknown',
      },
      params.autoAnalyze
        ? {
            status: 'blocked',
            reasonCode: 'REPO_NOT_REGISTERED',
            message: 'Repository is not registered; analysis cannot be submitted.',
          }
        : { status: 'not-requested' },
    );
  }

  const repoRoot = normalizeRepoPath(entry.path) ?? entry.path ?? process.cwd();
  const selectorResolved =
    selector !== undefined && registryEntryMatchesSelector(registry, entry, selector);
  const cwdFallbackUsed = selector !== undefined && !selectorResolved;
  if (cwdFallbackUsed) {
    warnings.push(
      `Repo selector "${selector}" did not match the registry entry that was used; falling back to the cwd-scoped repo ${repoRoot}.`,
    );
  }

  // ---- 3. Get current HEAD commit from the indexed repo path --------------
  const repoMeta = await loadMeta(join(repoRoot, '.ontoindex'));
  let currentCommit = '';
  try {
    currentCommit = (
      await execFileText('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        timeoutMs: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: GIT_PROBE_MAX_BUFFER,
      })
    ).trim();
  } catch (err) {
    warnings.push('git rev-parse HEAD failed: ' + String(err));
  }

  const indexedCommit: string = entry.lastCommit ?? '';
  const isStale = currentCommit !== '' && indexedCommit !== '' && currentCommit !== indexedCommit;
  const dirtyFileCount = await countDirtyFiles(repoRoot);
  const scopeConfidence = deriveScopeConfidence({
    selectorProvided: selectorResolved,
    cwdFallbackUsed: cwdFallbackUsed || selector === undefined,
    dirtyFileCount,
    isStale,
  });

  // ---- 4. Build preCheck --------------------------------------------------
  const preCheck = { indexedCommit, currentCommit, isStale };
  const runtimeHealth = await readRuntimeHealth(repoRoot, {
    repoLabel: entry.name ?? selector ?? repoRoot,
    meta: repoMeta,
  });

  // ---- 5. Embeddings status -----------------------------------------------
  const embeddingsStatus = resolveEmbeddingsStatus({
    repoMeta,
    currentEmbeddingModelHash: process.env.ONTOINDEX_EMBEDDING_MODEL_HASH,
    isStale,
    withEmbeddings: params.withEmbeddings,
  });

  // ---- 6. Recommendations (always populated) ------------------------------
  if (isStale) {
    recommendations.push(
      `Index is stale (indexed ${indexedCommit} vs current ${currentCommit}). Run: ontoindex analyze${params.withEmbeddings ? ' --embeddings' : ''}`,
    );
    recommendations.push(
      'For multi-agent sessions, let one coordinator run analyze; workers should continue with explicit stale-index consent or git-only workflows.',
    );
  }
  if (embeddingsStatus.status !== 'ok') {
    recommendations.push(
      embeddingsStatus.repairCommand ??
        'Embeddings not populated. Stop MCP processes first to release DB lock, then run: ontoindex analyze --embeddings',
    );
  }

  if (
    params.autoAnalyze &&
    runtimeHealth.freshnessState === 'untrusted' &&
    runtimeHealth.analyzeLock.state !== 'stale'
  ) {
    analysisSubmission = {
      status: 'blocked',
      reasonCode: runtimeHealth.freshnessState,
      message: `Index runtime health is ${runtimeHealth.freshnessState}; repair manually before autoAnalyze.`,
    };
    recommendations.push(
      `Index runtime health is ${runtimeHealth.freshnessState}; repair manually before autoAnalyze.`,
    );
    if (runtimeHealth.repairCommand) {
      recommendations.push(runtimeHealth.repairCommand);
    }

    return {
      version: 1,
      preCheck,
      embeddingsStatus,
      repoLabel: entry.name ?? selector ?? repoRoot,
      repoPath: repoRoot,
      indexedCommit,
      headCommit: currentCommit,
      isStale,
      dirtyFileCount,
      scopeConfidence,
      runtimeHealth,
      actionsTaken,
      analysisSubmission,
      warnings,
      recommendations,
    };
  }

  // ---- 7. Auto-analyze (only when explicitly requested AND stale) ---------
  let analysisJob: AnalysisJobRecord | undefined;

  if (
    params.autoAnalyze &&
    (isStale ||
      runtimeHealth.analyzeLock.state === 'stale' ||
      runtimeHealth.freshnessState === 'failed-after-partial-run')
  ) {
    // Note: this CAN block on DuckDB write-lock if MCP processes are running.
    if (params.killMcpForLock) {
      warnings.push(
        'killMcpForLock is advisory only; OntoIndex will not terminate MCP processes automatically.',
      );
      recommendations.push(
        'Stop only the MCP process using this repo before autoAnalyze, or run a repo-scoped MCP server with `ontoindex mcp --repo <repo>`.',
      );
    }

    const cli = currentCliCommand();
    const args = [...cli.argsPrefix, 'analyze'];
    const forceRecovery =
      runtimeHealth.analyzeLock.state === 'stale' ||
      runtimeHealth.freshnessState === 'failed-after-partial-run';
    if (forceRecovery) args.push('--force');
    if (params.withEmbeddings) args.push('--embeddings');

    try {
      const submitted = await submitAnalysisJob({
        repoPath: repoRoot,
        targetHead: currentCommit,
        command: cli.command,
        args,
        options: { withEmbeddings: params.withEmbeddings === true },
      });
      analysisJob = submitted.job;
      analysisSubmission = {
        status: submitted.reused ? 'reused' : 'queued',
        jobId: analysisJob.id,
      };
      actionsTaken.push(
        `${submitted.reused ? 'Reused' : 'Started'} analysis job ${analysisJob.id}: ${cli.displayPrefix} analyze${forceRecovery ? ' --force' : ''}${params.withEmbeddings ? ' --embeddings' : ''}`,
      );
      recommendations.push(
        `Poll gn_analyze_job with jobId "${analysisJob.id}" for terminal status, exit code, generation ID, and log path.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const causeCode =
        err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
          ? err.code
          : undefined;
      analysisSubmission = {
        status: 'failed',
        errorCode: 'ANALYZE_JOB_SUBMISSION_FAILED',
        ...(causeCode ? { causeCode } : {}),
        message,
      };
      warnings.push('analyze job submission failed: ' + message);
      recommendations.push(
        'Inspect any active analysis job under .ontoindex/analysis-jobs before retrying autoAnalyze.',
      );
    }
  }

  // ---- 8. killMcpForLock without autoAnalyze note -------------------------
  if (params.killMcpForLock && !params.autoAnalyze) {
    recommendations.push(
      'killMcpForLock: true has no effect without autoAnalyze: true and is advisory only. Stop MCP manually before running analyze.',
    );
  }

  // ---- 9. Return report ---------------------------------------------------
  return {
    version: 1,
    preCheck,
    embeddingsStatus,
    repoLabel: entry.name ?? selector ?? repoRoot,
    repoPath: repoRoot,
    indexedCommit,
    headCommit: currentCommit,
    isStale,
    dirtyFileCount,
    scopeConfidence,
    runtimeHealth,
    actionsTaken,
    analysisSubmission,
    ...(analysisJob !== undefined ? { analysisJob } : {}),
    warnings,
    recommendations,
  };
}
