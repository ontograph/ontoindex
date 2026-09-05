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
  ANALYSIS_REQUESTED_CAPABILITIES_VERSION,
  commitSourceIdentity,
  worktreeSourceIdentity,
  type AnalysisRequestedCapabilities,
} from '../../core/analysis/analysis-publication-receipt.js';
import {
  computeSourceManifest,
  sourceManifestDigest,
} from '../../core/indexing/source-manifest.js';
import {
  readRuntimeHealth,
  type RuntimeHealthSnapshot,
} from '../../core/runtime/runtime-health.js';
import { readActiveGenerationMeta, type RepoMeta } from '../../storage/repo-manager.js';
import type { GraphAuthorityCapability, ScopeConfidence } from '../shared/target-context.js';
import { resolveTargetContext } from '../shared/target-context.js';
import { createEnvelopeFromLegacy } from '../shared/response-envelope.js';

const GIT_PROBE_TIMEOUT_MS = 5_000;
const GIT_PROBE_MAX_BUFFER = 1024 * 1024;
const GIT_HEAD = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnsureFreshParams {
  repo?: string;
  withEmbeddings?: boolean; // default: false
  requiredGraphCapabilities?: readonly GraphAuthorityCapability[]; // default: ['symbols']
  autoAnalyze?: boolean; // default: false (require explicit confirm)
  killMcpForLock?: boolean; // deprecated; advisory only for safety
  legacyResponse?: boolean; // default: true
}

export type EmbeddingDriftStatus = 'ok' | 'missing' | 'metadata-unavailable' | 'drifted';

export type AnalysisSubmission =
  | { status: 'not-requested' }
  | { status: 'not-needed' }
  | { status: 'blocked'; reasonCode: string; message: string; jobId?: string }
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
    expectedModelHash?: string;
    actualModelHash?: string;
  };
  repoLabel?: string;
  repoPath?: string;
  indexedCommit?: string;
  headCommit?: string;
  isStale?: boolean;
  dirtyFileCount?: number | null;
  /**
   * Bounded split of `dirtyFileCount`. Tracked edits sit on top of an indexed
   * commit; untracked source files are absent from the graph entirely. Optional
   * and additive: consumers that only read `dirtyFileCount` are unaffected.
   */
  dirtyWorktreeBreakdown?: {
    trackedChangedCount: number | null;
    untrackedCount: number | null;
  };
  scopeConfidence?: ScopeConfidence;
  runtimeHealth?: RuntimeHealthSnapshot;
  actionsTaken: string[];
  analysisSubmission: AnalysisSubmission;
  analysisJob?: AnalysisJobRecord;
  postCheck?: { indexedCommit: string; currentCommit: string; isStale: boolean };
  warnings: string[];
  recommendations: string[];
}

const GRAPH_CAPABILITY_ORDER: readonly GraphAuthorityCapability[] = [
  'impact',
  'processes',
  'symbols',
];

function normalizeRequiredGraphCapabilities(
  capabilities: readonly GraphAuthorityCapability[] | undefined,
): GraphAuthorityCapability[] {
  const requested = capabilities ?? ['symbols'];
  const normalized = [...new Set(requested)].sort() as GraphAuthorityCapability[];
  if (
    normalized.length === 0 ||
    requested.some((capability) => !GRAPH_CAPABILITY_ORDER.includes(capability))
  ) {
    throw new Error(
      'requiredGraphCapabilities must be a non-empty array containing only symbols, impact, or processes.',
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RegistryEntry {
  name?: string;
  path?: string;
  lastCommit?: string;
  indexedAt?: string;
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

/**
 * Bounded worktree breakdown. Tracked edits are already represented in the graph
 * at their indexed commit, while untracked source files are unknown to it, so
 * agents need the two counts separately to calibrate rather than blanket-
 * discount every `dirty` report.
 */
interface DirtyWorktreeSummary {
  dirtyFileCount: number | null;
  trackedChangedCount: number | null;
  untrackedCount: number | null;
}

async function summarizeDirtyWorktree(repoRoot: string): Promise<DirtyWorktreeSummary> {
  try {
    const output = (
      await execFileText('git', ['status', '--porcelain'], {
        cwd: repoRoot,
        timeoutMs: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: GIT_PROBE_MAX_BUFFER,
      })
    ).trim();
    if (output.length === 0) {
      return { dirtyFileCount: 0, trackedChangedCount: 0, untrackedCount: 0 };
    }
    const lines = output.split('\n').filter(Boolean);
    const untrackedCount = lines.filter((line) => line.startsWith('??')).length;
    return {
      dirtyFileCount: lines.length,
      trackedChangedCount: lines.length - untrackedCount,
      untrackedCount,
    };
  } catch {
    return { dirtyFileCount: null, trackedChangedCount: null, untrackedCount: null };
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
  const requested = input.withEmbeddings === true;
  const requestedRepairCommand = `ontoindex analyze${input.isStale ? '' : ' --force'} --embeddings`;

  if (!input.repoMeta) {
    return {
      count,
      required: requested,
      status: 'metadata-unavailable',
      reason: 'repo meta.json is unavailable',
      repairCommand: requested ? requestedRepairCommand : 'ontoindex analyze',
      ...(currentHash ? { expectedModelHash: currentHash } : {}),
    };
  }

  if (count === 0) {
    return {
      count,
      required: requested,
      status: 'missing',
      reason: 'embeddings are not populated in repo metadata',
      repairCommand: requestedRepairCommand,
      ...(currentHash ? { expectedModelHash: currentHash } : {}),
      ...(metadataHash ? { actualModelHash: metadataHash } : {}),
    };
  }

  if (!metadataHash || !currentHash) {
    if (metadataHash && !currentHash) {
      return {
        count,
        required: false,
        status: 'ok',
        reason: 'runtime embedding model hash is not set; drift check skipped',
        actualModelHash: metadataHash,
      };
    }
    return {
      count,
      required: requested,
      status: 'metadata-unavailable',
      reason: !metadataHash
        ? 'embedding fingerprint is missing from repo metadata'
        : 'ONTOINDEX_EMBEDDING_MODEL_HASH is not set',
      repairCommand: 'ontoindex analyze --force --embeddings',
      ...(currentHash ? { expectedModelHash: currentHash } : {}),
      ...(metadataHash ? { actualModelHash: metadataHash } : {}),
    };
  }

  if (metadataHash !== currentHash) {
    return {
      count,
      required: requested,
      status: 'drifted',
      reason: `embedding model hash mismatch: meta.json has "${metadataHash}" but the current environment has "${currentHash}"`,
      repairCommand: 'ontoindex analyze --force --embeddings',
      expectedModelHash: currentHash,
      actualModelHash: metadataHash,
    };
  }

  return {
    count,
    required: false,
    status: 'ok',
    expectedModelHash: currentHash,
    actualModelHash: metadataHash,
  };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Short-lived cache for read-only freshness probes.
 *
 * Freshness is the single most-called OntoIndex surface, and repeated probes
 * within one agent turn re-derive an answer that cannot have changed. Only
 * read-only calls are cached: any `autoAnalyze` request submits work and must
 * always execute. The TTL is deliberately short to bound how long a verdict can
 * lag a concurrent edit; set ONTOINDEX_FRESHNESS_CACHE_MS=0 to disable.
 */
const DEFAULT_FRESHNESS_CACHE_MS = 3_000;

interface FreshnessCacheEntry {
  expiresAt: number;
  report: EnsureFreshReport;
}

const freshnessCache = new Map<string, FreshnessCacheEntry>();

function freshnessCacheTtlMs(): number {
  const raw = process.env.ONTOINDEX_FRESHNESS_CACHE_MS;
  if (raw == null || raw.trim() === '') return DEFAULT_FRESHNESS_CACHE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_FRESHNESS_CACHE_MS;
  return Math.floor(value);
}

/** Test seam: drop every cached freshness verdict. */
export function resetFreshnessCache(): void {
  freshnessCache.clear();
}

function freshnessCacheKey(
  repoId: string,
  params: EnsureFreshParams,
  requiredGraphCapabilities: readonly GraphAuthorityCapability[],
): string {
  return JSON.stringify([
    repoId,
    params.repo ?? null,
    params.withEmbeddings === true,
    requiredGraphCapabilities,
  ]);
}

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
  const requiredGraphCapabilities = normalizeRequiredGraphCapabilities(
    params.requiredGraphCapabilities,
  );
  const cacheable = params.autoAnalyze !== true;
  const ttlMs = freshnessCacheTtlMs();
  const cacheKey = freshnessCacheKey(repoId, params, requiredGraphCapabilities);
  let report: EnsureFreshReport | undefined;

  if (cacheable && ttlMs > 0) {
    const cached = freshnessCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      report = structuredClone(cached.report);
    } else if (cached) {
      freshnessCache.delete(cacheKey);
    }
  }

  if (report === undefined) {
    report = await buildEnsureFreshReport(repoId, {
      ...params,
      requiredGraphCapabilities,
    });
    if (cacheable && ttlMs > 0) {
      freshnessCache.set(cacheKey, {
        expiresAt: Date.now() + ttlMs,
        report: structuredClone(report),
      });
    }
  }

  if (params.legacyResponse !== false) return report;
  const targetContext = await resolveTargetContext({
    repo: params.repo ?? repoId,
    verifyGraphAuthority: true,
    requiredGraphCapabilities,
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
  const requiredGraphCapabilities = normalizeRequiredGraphCapabilities(
    params.requiredGraphCapabilities,
  );
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
  const repoStoragePath = join(repoRoot, '.ontoindex');
  const generationMeta = await readActiveGenerationMeta(repoStoragePath);
  const repoMeta = generationMeta.meta;
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

  const registryIndexedCommit: string = entry.lastCommit ?? '';
  const trustedMetadataIndexedCommit =
    generationMeta.authority !== 'untrusted' ? (repoMeta?.lastCommit ?? '') : '';
  const indexedCommit = trustedMetadataIndexedCommit || registryIndexedCommit;
  if (generationMeta.authority === 'untrusted') {
    warnings.push(
      `Active generation metadata authority is untrusted (${generationMeta.reason ?? 'unknown reason'}); ${
        registryIndexedCommit
          ? `using registry commit ${registryIndexedCommit} as a conservative indexed-commit fallback`
          : 'no trusted indexed-commit fallback is available'
      }. Generation metadata is excluded from commit, embeddings, and runtime claims.`,
    );
  }
  if (
    trustedMetadataIndexedCommit &&
    registryIndexedCommit &&
    trustedMetadataIndexedCommit !== registryIndexedCommit
  ) {
    warnings.push(
      `The registry indexed commit ${registryIndexedCommit} lags trusted index metadata ${trustedMetadataIndexedCommit}; using trusted metadata as local freshness authority.`,
    );
  }
  const currentHeadAvailable = GIT_HEAD.test(currentCommit);
  if (currentCommit && !currentHeadAvailable) {
    warnings.push('git rev-parse HEAD returned a malformed commit identity.');
  }
  const isStale = currentCommit !== '' && indexedCommit !== '' && currentCommit !== indexedCommit;
  const dirtyWorktree = await summarizeDirtyWorktree(repoRoot);
  const dirtyFileCount = dirtyWorktree.dirtyFileCount;
  const dirtyWorktreeBreakdown = {
    trackedChangedCount: dirtyWorktree.trackedChangedCount,
    untrackedCount: dirtyWorktree.untrackedCount,
  };
  const scopeConfidence = deriveScopeConfidence({
    selectorProvided: selectorResolved,
    cwdFallbackUsed: cwdFallbackUsed || selector === undefined,
    dirtyFileCount,
    isStale,
  });
  if ((dirtyWorktree.untrackedCount ?? 0) > 0) {
    warnings.push(
      `${dirtyWorktree.untrackedCount} untracked file${dirtyWorktree.untrackedCount === 1 ? ' is' : 's are'} absent from the graph entirely; ${dirtyWorktree.trackedChangedCount} tracked change${dirtyWorktree.trackedChangedCount === 1 ? ' is' : 's are'} indexed at the indexed commit.`,
    );
  }

  // ---- 4. Build preCheck --------------------------------------------------
  const preCheck = { indexedCommit, currentCommit, isStale };
  const runtimeFallbackMeta: RepoMeta | null =
    repoMeta ??
    (registryIndexedCommit
      ? {
          repoPath: repoRoot,
          lastCommit: registryIndexedCommit,
          indexedAt: entry.indexedAt ?? '',
        }
      : null);
  let runtimeHealth = await readRuntimeHealth(repoRoot, {
    repoLabel: entry.name ?? selector ?? repoRoot,
    meta: runtimeFallbackMeta,
  });
  if (
    generationMeta.authority === 'untrusted' &&
    runtimeHealth.freshnessState !== 'failed-after-partial-run'
  ) {
    runtimeHealth = {
      ...runtimeHealth,
      indexedCommit: registryIndexedCommit || null,
      freshnessState: 'untrusted',
      degradedReason: 'active generation metadata authority is untrusted',
      repairCommand: 'ontoindex analyze --force',
      repairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: ['--force'],
        reason: 'rebuild untrusted generation metadata through managed analysis',
      },
    };
  }

  // ---- 5. Embeddings status -----------------------------------------------
  const embeddingsStatus = resolveEmbeddingsStatus({
    repoMeta,
    currentEmbeddingModelHash: process.env.ONTOINDEX_EMBEDDING_MODEL_HASH,
    isStale,
    withEmbeddings: params.withEmbeddings,
  });
  const embeddingsRepairRequired = embeddingsStatus.required && embeddingsStatus.status !== 'ok';
  const refreshWorkNeeded =
    isStale ||
    // Uncommitted edits are absent from a commit-scoped graph, so a dirty tree
    // is refreshable work even when HEAD already matches the indexed commit.
    (dirtyFileCount !== null && dirtyFileCount > 0) ||
    (!currentHeadAvailable && indexedCommit !== '') ||
    embeddingsRepairRequired ||
    runtimeHealth.analyzeLock.state === 'stale' ||
    runtimeHealth.freshnessState === 'failed-after-partial-run';

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

  if (params.autoAnalyze && !currentHeadAvailable) {
    analysisSubmission = {
      status: 'blocked',
      reasonCode: 'HEAD_UNAVAILABLE',
      message: 'A valid 40- or 64-character git HEAD is unavailable; analysis cannot be submitted.',
    };
    recommendations.push('Restore a valid git HEAD before retrying autoAnalyze.');
  } else if (params.autoAnalyze && dirtyFileCount === null) {
    analysisSubmission = {
      status: 'blocked',
      reasonCode: 'WORKTREE_STATUS_UNAVAILABLE',
      message: 'Worktree status is unavailable; analysis cannot be submitted safely.',
    };
    recommendations.push('Confirm the repository worktree is clean before retrying autoAnalyze.');
  } else if (
    params.autoAnalyze &&
    params.withEmbeddings === true &&
    !process.env.ONTOINDEX_EMBEDDING_MODEL_HASH?.trim()
  ) {
    analysisSubmission = {
      status: 'blocked',
      reasonCode: 'EMBEDDING_MODEL_IDENTITY_UNAVAILABLE',
      message:
        'ONTOINDEX_EMBEDDING_MODEL_HASH must be set to a non-empty model identity before requesting managed embedding analysis.',
    };
  } else if (
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
      dirtyWorktreeBreakdown,
      scopeConfidence,
      runtimeHealth,
      actionsTaken,
      analysisSubmission,
      warnings,
      recommendations,
    };
  }

  // ---- 7. Auto-analyze (only when explicitly requested and work is needed) -
  let analysisJob: AnalysisJobRecord | undefined;

  if (params.autoAnalyze && refreshWorkNeeded && analysisSubmission.status === 'not-needed') {
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
    const forceEmbeddingsRepair = !isStale && embeddingsRepairRequired;
    const forceAnalyze = forceRecovery || forceEmbeddingsRepair;
    if (forceAnalyze) args.push('--force');
    if (params.withEmbeddings) args.push('--embeddings');

    try {
      const requestedCapabilities: AnalysisRequestedCapabilities = {
        version: ANALYSIS_REQUESTED_CAPABILITIES_VERSION,
        graph: true,
        graphCapabilities: requiredGraphCapabilities,
        embeddings: params.withEmbeddings === true,
        embeddingModelHash:
          params.withEmbeddings === true
            ? process.env.ONTOINDEX_EMBEDDING_MODEL_HASH!.trim()
            : null,
      };
      const manifest = await computeSourceManifest(repoRoot, {
        includePaths: [],
        pipelineProfile: 'full',
      });
      const manifestDigest = sourceManifestDigest(manifest);
      // A dirty tree is analyzed as-is, but it must not be published under a
      // commit identity whose content it does not match. Identify those runs by
      // the manifest digest that hashed the exact analyzed bytes.
      const analyzingDirtyWorktree = dirtyFileCount > 0;
      const sourceIdentity = analyzingDirtyWorktree
        ? worktreeSourceIdentity(manifestDigest)
        : commitSourceIdentity(currentCommit);
      if (analyzingDirtyWorktree) {
        warnings.push(
          `Analyzing ${dirtyFileCount} uncommitted change${dirtyFileCount === 1 ? '' : 's'}; results publish under working-tree identity "${sourceIdentity}" rather than commit ${currentCommit}.`,
        );
      }
      const submitted = await submitAnalysisJob({
        repoPath: repoRoot,
        targetHead: currentCommit,
        sourceIdentity,
        requestedCapabilities,
        sourceManifestDigest: manifestDigest,
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
        `${submitted.reused ? 'Reused' : 'Started'} analysis job ${analysisJob.id}: ${cli.displayPrefix} analyze${forceAnalyze ? ' --force' : ''}${params.withEmbeddings ? ' --embeddings' : ''}`,
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
      if (causeCode === 'LOCK_CONFLICT' || causeCode === 'ACTIVE_JOB_CONFLICT') {
        const activeJobId =
          causeCode === 'ACTIVE_JOB_CONFLICT' &&
          err &&
          typeof err === 'object' &&
          'activeJobId' in err &&
          typeof err.activeJobId === 'string'
            ? err.activeJobId
            : undefined;
        analysisSubmission = {
          status: 'blocked',
          reasonCode: causeCode,
          message,
          ...(activeJobId ? { jobId: activeJobId } : {}),
        };
        warnings.push('analyze job submission blocked: ' + message);
      } else {
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
    dirtyWorktreeBreakdown,
    scopeConfidence,
    runtimeHealth,
    actionsTaken,
    analysisSubmission,
    ...(analysisJob !== undefined ? { analysisJob } : {}),
    warnings,
    recommendations,
  };
}
