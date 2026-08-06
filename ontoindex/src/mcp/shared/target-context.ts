import path from 'node:path';

import { execFileText } from '../../core/process/exec-file.js';
import {
  getSidecarStorePath,
  loadSidecarStoreState,
} from '../../core/ingestion/enrichment/index.js';
import {
  summarizeGitPorcelainStatus,
  type AuditDirtyFile,
  type GitPorcelainWorkspaceSummary,
} from '../../core/audit-lifecycle/freshness.js';
import { loadIgnoreRules, shouldIgnorePath } from '../../config/ignore-service.js';
import { readRegistry, type RegistryEntry } from '../../storage/repo-manager.js';
import { loadMeta, resolveActiveIndexGeneration } from '../../storage/repo-manager.js';
import {
  computeSourceManifest,
  manifestsMatch,
  SOURCE_MANIFEST_CONTRACT,
  SOURCE_MANIFEST_VERSION,
  sourceManifestDigest,
} from '../../core/indexing/source-manifest.js';
import {
  formatRepoResolutionError,
  repoResolutionCandidatesFromEntries,
  repoResolutionEnvironmentFromProcess,
} from './repo-resolution-errors.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export type TargetContextStatus = 'ok' | 'ambiguous' | 'no-index' | 'not-found';
export type SnapshotMode = 'committed-head' | 'dirty-worktree-overlay' | 'diff-ref' | 'unknown';
export type ReadinessStatus = 'available' | 'unavailable' | 'unknown' | 'degraded';
export type QualityMode = 'fast' | 'balanced' | 'thorough';
export type ScopeConfidence = 'high' | 'medium' | 'low' | 'unknown';
export type DirtyWorkspaceState =
  | 'clean'
  | 'dirty-file'
  | 'stale-index'
  | 'unknown-untracked'
  | 'unknown';

export type GraphAuthorityState = 'authoritative' | 'review' | 'degraded';
export type GraphAuthorityCapability = 'symbols' | 'impact' | 'processes';

export interface TargetContextGraphAuthority {
  state: GraphAuthorityState;
  reason: string;
  generationId?: string;
  manifestDigest?: string;
  coverage?: 'complete' | 'degraded' | 'unknown';
}

export interface TargetContextReadiness {
  status: ReadinessStatus;
  reason?: string;
}

export interface TargetContextLspReadiness extends TargetContextReadiness {
  servers?: { typescript: boolean; python: boolean; rust: boolean };
}

export interface TargetContextEmbeddingsReadiness extends TargetContextReadiness {
  count?: number;
}

export interface TargetContextSidecarReadiness extends TargetContextReadiness {
  requests?: number;
  enrichments?: number;
  running?: boolean;
}

export interface TargetContextPolicyReadiness extends TargetContextReadiness {
  profile?: string;
}

export interface TargetContextRepoSummary {
  key: string;
  path: string;
}

export interface TargetContextDirtyWorkspace {
  state: DirtyWorkspaceState;
  fileCount: number | null;
  sourceFileCount: number | null;
  stagedSourceFileCount: number | null;
  unstagedSourceFileCount: number | null;
  untrackedSourceFileCount: number | null;
  unknownGraphCoverageCount: number | null;
}

export interface TargetContext {
  version: 1;
  status: TargetContextStatus;
  repoKey?: string;
  repoLabel?: string;
  repoPath?: string;
  branch?: string;
  targetRef: string;
  targetHead?: string;
  currentHead?: string;
  indexedHead?: string;
  graphIndexId?: string;
  graphAuthority?: TargetContextGraphAuthority;
  dirtyWorktree: boolean | null;
  dirtyFileCount?: number | null;
  dirtyWorkspace?: TargetContextDirtyWorkspace;
  scopePaths?: string[];
  scopedDirtyWorkspace?: TargetContextDirtyWorkspace;
  changedSinceIndex: boolean | null;
  snapshotMode: SnapshotMode;
  qualityMode: QualityMode;
  scopeConfidence?: ScopeConfidence;
  scopeConfidenceReason?: string;
  repairCommand?: string;
  embeddings: TargetContextEmbeddingsReadiness;
  lsp: TargetContextLspReadiness;
  sidecar: TargetContextSidecarReadiness;
  policy: TargetContextPolicyReadiness;
  availableRepos?: TargetContextRepoSummary[];
  action?: string;
  warnings: string[];
}

export interface ResolveTargetContextOptions {
  repo?: string;
  projectPath?: string;
  targetRef?: string;
  scopePaths?: string[];
  checkSidecar?: boolean;
  verifyGraphAuthority?: boolean;
  requiredGraphCapabilities?: readonly GraphAuthorityCapability[];
  readiness?: {
    embeddingsCount?: number;
    lspAvailable?: { typescript: boolean; python: boolean; rust: boolean };
  };
}

export interface ResolveTargetContextDeps {
  readRegistry?: () => Promise<RegistryEntry[]>;
  execGit?: (cwd: string, args: string[]) => Promise<string>;
  loadIgnoreRules?: typeof loadIgnoreRules;
  loadSidecarState?: typeof loadSidecarStoreState;
  loadMeta?: typeof loadMeta;
  computeSourceManifest?: typeof computeSourceManifest;
  resolveActiveIndexGeneration?: typeof resolveActiveIndexGeneration;
}

export async function resolveTargetContext(
  options: ResolveTargetContextOptions = {},
  deps: ResolveTargetContextDeps = {},
): Promise<TargetContext> {
  const warnings: string[] = [];
  const registry = await readRegistrySafely(deps, warnings);
  const targetRef = options.targetRef?.trim() || 'HEAD';
  const base = createBaseContext(targetRef, warnings);
  const explicitRepo = options.repo?.trim() || undefined;
  const explicitProjectPath = options.projectPath?.trim()
    ? path.resolve(options.projectPath.trim())
    : undefined;
  const envRepo = process.env.ONTOINDEX_MCP_REPO?.trim() || undefined;
  const envProjectPath = process.env.ONTOINDEX_MCP_PROJECT_CWD?.trim()
    ? path.resolve(process.env.ONTOINDEX_MCP_PROJECT_CWD.trim())
    : undefined;
  const cwdRepoRoot = path.resolve(process.cwd());
  const explicitResolution = explicitRepo ? resolveRegistryEntry(registry, explicitRepo) : null;
  const explicitProjectResolution = explicitProjectPath
    ? resolveRegistryEntryByPath(registry, explicitProjectPath)
    : null;
  const envResolution = envRepo ? resolveRegistryEntry(registry, envRepo) : null;
  const envProjectResolution = envProjectPath
    ? resolveRegistryEntryByPath(registry, envProjectPath)
    : null;
  const cwdResolution = resolveRegistryEntryByPath(registry, cwdRepoRoot);
  const noSelectorResolution = resolveRegistryEntry(registry, undefined);
  const selectionSource: 'explicit' | 'env' | 'cwd' | 'single' | 'project' = explicitRepo
    ? 'explicit'
    : explicitProjectPath
      ? 'project'
      : cwdResolution.status === 'ok'
        ? 'cwd'
        : envResolution?.status === 'ok' || envProjectResolution?.status === 'ok'
          ? 'env'
          : noSelectorResolution.status === 'ok'
            ? 'single'
            : 'cwd';

  const selectedResolution = explicitRepo
    ? explicitResolution
    : explicitProjectPath
      ? (explicitProjectResolution ?? {
          status: 'not-found',
          action: `Repository "${explicitProjectPath}" is not indexed. Run ontoindex analyze or pass a listed repo name/path.`,
        })
      : cwdResolution.status === 'ok'
        ? cwdResolution
        : envResolution?.status === 'ok'
          ? envResolution
          : envProjectResolution?.status === 'ok'
            ? envProjectResolution
            : noSelectorResolution;

  if (selectedResolution.status !== 'ok') {
    return {
      ...base,
      status: selectedResolution.status,
      availableRepos: registry.map(toRepoSummary),
      action: actionWithRetryExamples(
        selectedResolution.status,
        registry,
        explicitRepo ?? explicitProjectPath ?? envRepo ?? envProjectPath,
      ),
      warnings,
    };
  }

  const { entry } = selectedResolution;
  const repoPath = path.resolve(entry.path);
  const execGit = deps.execGit ?? defaultExecGit;

  if (
    explicitRepo &&
    cwdResolution.status === 'ok' &&
    !sameResolvedPath(cwdResolution.entry.path, repoPath)
  ) {
    warnings.push(
      repoPathMismatchWarning({
        selector: `explicit repo "${explicitRepo}"`,
        selectedPath: repoPath,
        conflictingSource: `MCP cwd ${cwdRepoRoot}`,
        conflictingPath: cwdResolution.entry.path,
      }),
    );
  }
  if (
    explicitRepo &&
    envResolution?.status === 'ok' &&
    !sameResolvedPath(envResolution.entry.path, repoPath)
  ) {
    warnings.push(
      repoPathMismatchWarning({
        selector: `explicit repo "${explicitRepo}"`,
        selectedPath: repoPath,
        conflictingSource: `ONTOINDEX_MCP_REPO "${envRepo}"`,
        conflictingPath: envResolution.entry.path,
      }),
    );
  }
  if (
    explicitProjectPath &&
    cwdResolution.status === 'ok' &&
    !sameResolvedPath(cwdResolution.entry.path, repoPath)
  ) {
    warnings.push(
      repoPathMismatchWarning({
        selector: `explicit project "${explicitProjectPath}"`,
        selectedPath: repoPath,
        conflictingSource: `MCP cwd ${cwdRepoRoot}`,
        conflictingPath: cwdResolution.entry.path,
      }),
    );
  }
  if (
    explicitProjectPath &&
    envResolution?.status === 'ok' &&
    !sameResolvedPath(envResolution.entry.path, repoPath)
  ) {
    warnings.push(
      repoPathMismatchWarning({
        selector: `explicit project "${explicitProjectPath}"`,
        selectedPath: repoPath,
        conflictingSource: `ONTOINDEX_MCP_REPO "${envRepo}"`,
        conflictingPath: envResolution.entry.path,
      }),
    );
  }

  const [branch, currentHead, targetHead, statusOutput] = await Promise.all([
    gitProbe(execGit, repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], warnings),
    gitProbe(execGit, repoPath, ['rev-parse', 'HEAD'], warnings),
    gitProbe(execGit, repoPath, ['rev-parse', targetRef], warnings),
    gitProbe(
      execGit,
      repoPath,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      warnings,
      false,
    ),
  ]);
  const workspaceSummary = summarizeGitPorcelainStatus(statusOutput);
  const dirtyWorktree = workspaceSummary !== null ? workspaceSummary.dirtyFileCount > 0 : null;
  const dirtyFileCount = workspaceSummary?.dirtyFileCount ?? null;
  const indexedHead = entry.lastCommit || undefined;
  const graphAuthority = options.verifyGraphAuthority
    ? await resolveGraphAuthority(
        repoPath,
        await (deps.loadMeta ?? loadMeta)(entry.storagePath),
        deps.computeSourceManifest ?? computeSourceManifest,
        (
          await (deps.resolveActiveIndexGeneration ?? resolveActiveIndexGeneration)(
            entry.storagePath,
          )
        )?.generationId,
        options.requiredGraphCapabilities ?? [],
        targetHead,
        currentHead,
      )
    : undefined;
  const headChangedSinceIndex = !!currentHead && !!indexedHead && currentHead !== indexedHead;
  const changedSinceIndex =
    dirtyWorktree === null && (!currentHead || !indexedHead)
      ? null
      : dirtyWorktree === true || headChangedSinceIndex;
  const selectionMismatch =
    (envResolution?.status === 'ok' && !sameResolvedPath(envResolution.entry.path, repoPath)) ||
    (cwdResolution.status === 'ok' && !sameResolvedPath(cwdResolution.entry.path, repoPath));
  const dirtyWorkspace = resolveDirtyWorkspace({
    dirtyWorktree,
    changedSinceIndex,
    summary: workspaceSummary,
  });
  const scopePaths = normalizeScopePaths(options.scopePaths);
  const scopedWorkspaceSummary =
    scopePaths.length > 0
      ? await resolveScopedWorkspaceSummary(repoPath, workspaceSummary, scopePaths, deps, warnings)
      : null;
  const scopedDirtyWorkspace =
    scopedWorkspaceSummary !== null
      ? resolveDirtyWorkspace({
          dirtyWorktree: scopedWorkspaceSummary.dirtyFileCount > 0,
          changedSinceIndex: headChangedSinceIndex,
          summary: scopedWorkspaceSummary,
        })
      : undefined;
  const confidence = resolveScopeConfidence({
    status: 'ok',
    dirtyWorktree,
    changedSinceIndex,
    headChangedSinceIndex,
    selectionSource,
    selectionMismatch,
    dirtyWorkspace: scopedDirtyWorkspace ?? dirtyWorkspace,
    scoped: scopedDirtyWorkspace !== undefined,
  });

  return {
    ...base,
    status: 'ok',
    repoKey: entry.name,
    repoLabel: entry.name ?? path.basename(repoPath),
    repoPath,
    ...(branch ? { branch } : {}),
    ...(targetHead ? { targetHead } : {}),
    ...(currentHead ? { currentHead } : {}),
    ...(indexedHead ? { indexedHead } : {}),
    ...(entry.indexedAt ? { graphIndexId: entry.indexedAt } : {}),
    ...(graphAuthority ? { graphAuthority } : {}),
    dirtyWorktree,
    dirtyFileCount,
    dirtyWorkspace,
    ...(scopePaths.length > 0 ? { scopePaths } : {}),
    ...(scopedDirtyWorkspace ? { scopedDirtyWorkspace } : {}),
    changedSinceIndex,
    snapshotMode: resolveSnapshotMode(targetRef, dirtyWorktree),
    scopeConfidence: confidence.value,
    scopeConfidenceReason: confidence.reason,
    ...(confidence.repairCommand ? { repairCommand: confidence.repairCommand } : {}),
    embeddings: resolveEmbeddingsReadiness(entry, options.readiness?.embeddingsCount),
    lsp: resolveLspReadiness(options.readiness?.lspAvailable),
    sidecar: await resolveSidecarReadiness(entry, options.checkSidecar === true, deps, warnings),
    policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
    warnings,
  };
}

async function resolveGraphAuthority(
  repoPath: string,
  meta: Awaited<ReturnType<typeof loadMeta>>,
  computeManifest: typeof computeSourceManifest,
  activeGenerationId: string | undefined,
  requiredCapabilities: readonly GraphAuthorityCapability[],
  targetHead: string | undefined,
  currentHead: string | undefined,
): Promise<TargetContextGraphAuthority> {
  if (!meta?.sourceManifest) {
    return { state: 'degraded', reason: 'index manifest missing', coverage: 'unknown' };
  }
  if (!activeGenerationId || !meta.generationId || activeGenerationId !== meta.generationId) {
    return {
      state: 'degraded',
      reason: 'active graph generation does not match metadata generation',
      generationId: meta.generationId ?? meta.indexedAt,
      manifestDigest: sourceManifestDigest(meta.sourceManifest),
      coverage: meta.sourceManifest.coverage,
    };
  }
  const manifestVersion: unknown = (meta.sourceManifest as { version?: unknown }).version;
  const analyzerContractVersion: unknown = (
    meta.sourceManifest as { analyzerContractVersion?: unknown }
  ).analyzerContractVersion;
  if (
    manifestVersion !== SOURCE_MANIFEST_VERSION ||
    analyzerContractVersion !== SOURCE_MANIFEST_CONTRACT
  ) {
    return {
      state: 'degraded',
      reason: 'index manifest version or analyzer contract is unsupported',
      generationId: meta.generationId ?? meta.indexedAt,
      coverage: meta.sourceManifest.coverage,
    };
  }
  const manifestDigest = sourceManifestDigest(meta.sourceManifest);
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !generationHasCapability(meta, capability),
  );
  if (missingCapabilities.length > 0) {
    return {
      state: 'degraded',
      reason: `required graph capabilities unavailable: ${missingCapabilities.join(', ')}`,
      generationId: meta.generationId ?? meta.indexedAt,
      manifestDigest,
      coverage: meta.sourceManifest.coverage,
    };
  }
  if (!targetHead || !currentHead) {
    return {
      state: 'degraded',
      reason: 'target commit unavailable for graph authority',
      generationId: meta.generationId ?? meta.indexedAt,
      manifestDigest,
      coverage: meta.sourceManifest.coverage,
    };
  }
  if (targetHead && currentHead && targetHead !== currentHead) {
    return {
      state: 'review',
      reason: 'graph authority describes current checkout, not requested target ref',
      generationId: meta.generationId ?? meta.indexedAt,
      manifestDigest,
      coverage: meta.sourceManifest.coverage,
    };
  }
  try {
    const current = await computeManifest(repoPath, {
      includePaths: meta.sourceManifest.includePaths,
      pipelineProfile: meta.sourceManifest.pipelineProfile,
    });
    if (!manifestsMatch(meta.sourceManifest, current)) {
      return {
        state: 'review',
        reason: 'current source manifest does not match indexed manifest',
        generationId: meta.generationId ?? meta.indexedAt,
        manifestDigest,
        coverage: meta.sourceManifest.coverage,
      };
    }
    if (meta.sourceManifest.coverage !== 'complete') {
      return {
        state: 'degraded',
        reason: `indexed coverage is ${meta.sourceManifest.coverage}`,
        generationId: meta.generationId ?? meta.indexedAt,
        manifestDigest,
        coverage: meta.sourceManifest.coverage,
      };
    }
    return {
      state: 'authoritative',
      reason: 'current source manifest matches indexed generation',
      generationId: meta.generationId ?? meta.indexedAt,
      manifestDigest,
      coverage: 'complete',
    };
  } catch (err) {
    return {
      state: 'degraded',
      reason: `source manifest unavailable: ${err instanceof Error ? err.message : String(err)}`,
      generationId: meta.generationId ?? meta.indexedAt,
      coverage: meta.sourceManifest.coverage,
    };
  }
}

function generationHasCapability(
  meta: NonNullable<Awaited<ReturnType<typeof loadMeta>>>,
  capability: GraphAuthorityCapability,
): boolean {
  const reducedProfile =
    meta.pipelineProfile === 'symbols' ||
    meta.pipelineProfile === 'huge-repo-symbols' ||
    meta.indexMode === 'symbols-only';
  if (capability === 'symbols') return meta.capabilities?.symbols === true || !reducedProfile;
  if (capability === 'impact') return meta.capabilities?.impact === 'full';
  return meta.capabilities?.processes === true;
}

function createBaseContext(targetRef: string, warnings: string[]): TargetContext {
  return {
    version: 1,
    status: 'no-index',
    targetRef,
    dirtyWorktree: null,
    dirtyFileCount: null,
    dirtyWorkspace: {
      state: 'unknown',
      fileCount: null,
      sourceFileCount: null,
      stagedSourceFileCount: null,
      unstagedSourceFileCount: null,
      untrackedSourceFileCount: null,
      unknownGraphCoverageCount: null,
    },
    changedSinceIndex: null,
    snapshotMode: 'unknown',
    qualityMode: resolveQualityMode(),
    scopeConfidence: 'unknown',
    embeddings: { status: 'unknown', reason: 'repo-not-resolved' },
    lsp: { status: 'unknown', reason: 'not-probed' },
    sidecar: { status: 'unknown', reason: 'not-probed' },
    policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
    warnings,
  };
}

function sameResolvedPath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function readRegistrySafely(
  deps: ResolveTargetContextDeps,
  warnings: string[],
): Promise<RegistryEntry[]> {
  try {
    return await (deps.readRegistry ?? readRegistry)();
  } catch (err) {
    warnings.push(`target context registry probe failed: ${formatError(err)}`);
    return [];
  }
}

function resolveRegistryEntry(
  registry: RegistryEntry[],
  repo: string | undefined,
):
  | { status: 'ok'; entry: RegistryEntry }
  | { status: Exclude<TargetContextStatus, 'ok'>; action: string } {
  if (registry.length === 0) {
    return { status: 'no-index', action: 'Run ontoindex analyze for the target repository.' };
  }

  if (!repo) {
    if (registry.length === 1) return { status: 'ok', entry: registry[0] };
    return {
      status: 'ambiguous',
      action: `Specify one repository with the "repo" parameter: ${registry
        .map((entry) => entry.name)
        .join(', ')}`,
    };
  }

  const exactMatches = registry.filter((entry) => matchesRepo(entry, repo, false));
  if (exactMatches.length === 1) return { status: 'ok', entry: exactMatches[0] };
  if (exactMatches.length > 1) {
    return {
      status: 'ambiguous',
      action: `Repository "${repo}" matches multiple indexes. Use an absolute repo path.`,
    };
  }

  const fuzzyMatches = registry.filter((entry) => matchesRepo(entry, repo, true));
  if (fuzzyMatches.length === 1) return { status: 'ok', entry: fuzzyMatches[0] };
  if (fuzzyMatches.length > 1) {
    return {
      status: 'ambiguous',
      action: `Repository "${repo}" is ambiguous. Use one of: ${fuzzyMatches
        .map((entry) => entry.path)
        .join(', ')}`,
    };
  }

  return {
    status: 'not-found',
    action: `Repository "${repo}" is not indexed. Run ontoindex analyze or pass a listed repo name/path.`,
  };
}

function matchesRepo(entry: RegistryEntry, repo: string, allowFuzzy: boolean): boolean {
  const repoLower = repo.toLowerCase();
  if (entry.name.toLowerCase() === repoLower) return true;
  if (sameResolvedPath(entry.path, repo)) return true;
  return allowFuzzy && entry.name.toLowerCase().includes(repoLower);
}

function resolveRegistryEntryByPath(
  registry: RegistryEntry[],
  repoPath: string,
): {
  status: 'ok' | 'not-found' | 'ambiguous' | 'no-index';
  entry?: RegistryEntry;
  action?: string;
} {
  if (registry.length === 0) {
    return { status: 'no-index', action: 'Run ontoindex analyze for the target repository.' };
  }

  const targetPath = path.resolve(repoPath);
  const matches = registry
    .map((entry) => {
      const resolvedEntryPath = path.resolve(entry.path);
      const rel = path.relative(resolvedEntryPath, targetPath);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        return {
          entry,
          depth: resolvedEntryPath.split(path.sep).filter(Boolean).length,
          path: resolvedEntryPath,
        };
      }
      return null;
    })
    .filter(Boolean);

  if (matches.length === 0) {
    return {
      status: 'not-found',
      action: `Repository path "${repoPath}" is not indexed. Run ontoindex analyze or pass a listed repo name/path.`,
    };
  }

  const maxDepth = Math.max(...matches.map((match) => match!.depth));
  const maxDepthMatches = matches.filter((match) => match!.depth === maxDepth);

  if (maxDepthMatches.length === 1) {
    return { status: 'ok', entry: maxDepthMatches[0]!.entry };
  }

  return {
    status: 'ambiguous',
    action: `Repository path "${repoPath}" matches multiple indexes. Use one of: ${maxDepthMatches
      .map((match) => match!.path)
      .join(', ')}`,
  };
}

async function gitProbe(
  execGit: (cwd: string, args: string[]) => Promise<string>,
  cwd: string,
  args: string[],
  warnings: string[],
  trimOutput = true,
): Promise<string | null> {
  try {
    const output = await execGit(cwd, args);
    return trimOutput ? output.trim() : output;
  } catch (err) {
    warnings.push(`git ${args.join(' ')} failed: ${formatError(err)}`);
    return null;
  }
}

async function defaultExecGit(cwd: string, args: string[]): Promise<string> {
  return execFileText('git', args, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function resolveSnapshotMode(targetRef: string, dirtyWorktree: boolean | null): SnapshotMode {
  if (dirtyWorktree === true) return 'dirty-worktree-overlay';
  if (targetRef !== 'HEAD') return 'diff-ref';
  if (dirtyWorktree === false) return 'committed-head';
  return 'unknown';
}

function resolveDirtyWorkspace(input: {
  dirtyWorktree: boolean | null;
  changedSinceIndex: boolean | null;
  summary: GitPorcelainWorkspaceSummary | null;
}): TargetContextDirtyWorkspace {
  if (input.summary === null) {
    return {
      state: input.changedSinceIndex === true ? 'stale-index' : 'unknown',
      fileCount: null,
      sourceFileCount: null,
      stagedSourceFileCount: null,
      unstagedSourceFileCount: null,
      untrackedSourceFileCount: null,
      unknownGraphCoverageCount: null,
    };
  }

  const {
    dirtyFileCount,
    sourceFileCount,
    stagedSourceFileCount,
    unstagedSourceFileCount,
    untrackedSourceFileCount,
    unknownGraphCoverageCount,
  } = input.summary;

  let state: DirtyWorkspaceState = 'clean';
  if (untrackedSourceFileCount > 0) {
    state = 'unknown-untracked';
  } else if (stagedSourceFileCount > 0 || unstagedSourceFileCount > 0 || dirtyFileCount > 0) {
    state = 'dirty-file';
  } else if (input.changedSinceIndex === true) {
    state = 'stale-index';
  } else if (input.dirtyWorktree === null) {
    state = 'unknown';
  }

  return {
    state,
    fileCount: dirtyFileCount,
    sourceFileCount,
    stagedSourceFileCount,
    unstagedSourceFileCount,
    untrackedSourceFileCount,
    unknownGraphCoverageCount,
  };
}

async function resolveScopedWorkspaceSummary(
  repoPath: string,
  summary: GitPorcelainWorkspaceSummary | null,
  scopePaths: string[],
  deps: ResolveTargetContextDeps,
  warnings: string[],
): Promise<GitPorcelainWorkspaceSummary | null> {
  if (summary === null) return null;
  const ignoreRules = await loadIgnoreRulesSafely(repoPath, deps, warnings);
  const dirtyFiles = summary.dirtyFiles.filter((file) => {
    const normalizedPath = normalizeRepoRelativePath(file.path);
    if (!matchesAnyScope(normalizedPath, scopePaths)) return false;
    if (shouldIgnorePath(normalizedPath)) return false;
    return !(ignoreRules?.ignores(normalizedPath) ?? false);
  });

  return summarizeGitPorcelainStatus(formatDirtyFilesAsPorcelain(dirtyFiles));
}

async function loadIgnoreRulesSafely(
  repoPath: string,
  deps: ResolveTargetContextDeps,
  warnings: string[],
) {
  try {
    return await (deps.loadIgnoreRules ?? loadIgnoreRules)(repoPath);
  } catch (err) {
    warnings.push(`target context ignore probe failed: ${formatError(err)}`);
    return null;
  }
}

function formatDirtyFilesAsPorcelain(dirtyFiles: AuditDirtyFile[]): string {
  return dirtyFiles
    .map((file) => `${file.indexStatus}${file.worktreeStatus} ${file.path}`)
    .join('\n');
}

function normalizeScopePaths(paths: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (paths ?? [])
        .map(normalizeRepoRelativePath)
        .map((value) => value.replace(/\/+$/, ''))
        .filter(Boolean),
    ),
  );
}

function normalizeRepoRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
}

function matchesAnyScope(filePath: string, scopePaths: string[]): boolean {
  return scopePaths.some(
    (scopePath) => filePath === scopePath || filePath.startsWith(`${scopePath}/`),
  );
}

function resolveScopeConfidence(input: {
  status: TargetContextStatus;
  dirtyWorktree: boolean | null;
  changedSinceIndex: boolean | null;
  headChangedSinceIndex: boolean;
  selectionSource: 'explicit' | 'env' | 'cwd' | 'single' | 'project';
  selectionMismatch: boolean;
  dirtyWorkspace: TargetContextDirtyWorkspace;
  scoped: boolean;
}): { value: ScopeConfidence; reason: string; repairCommand?: string } {
  if (input.status !== 'ok') {
    return {
      value: input.status === 'ambiguous' ? 'low' : 'unknown',
      reason: `target-context-${input.status}`,
    };
  }
  if (input.selectionMismatch) {
    return {
      value: 'low',
      reason: 'repo-path-mismatch',
      repairCommand: 'Retry with the indexed repo path or matching repo label.',
    };
  }
  if (input.dirtyWorkspace.state === 'unknown-untracked') {
    return {
      value: 'low',
      reason: input.scoped ? 'untracked-source-files-in-scope' : 'untracked-source-files',
      repairCommand: 'Add, ignore, or remove untracked source files, then retry.',
    };
  }
  if (input.dirtyWorkspace.state === 'unknown') {
    return { value: 'unknown', reason: 'workspace-state-unknown' };
  }
  if (input.dirtyWorkspace.state === 'dirty-file' || input.dirtyWorkspace.state === 'stale-index') {
    return {
      value: 'medium',
      reason:
        input.dirtyWorkspace.state === 'stale-index'
          ? 'index-head-stale'
          : input.scoped
            ? 'dirty-source-files-in-scope'
            : 'dirty-source-files',
      repairCommand:
        input.dirtyWorkspace.state === 'stale-index'
          ? 'Re-run ontoindex analyze for the target repo.'
          : 'Clean, stash, or commit dirty files, then retry.',
    };
  }
  if (input.scoped && !input.headChangedSinceIndex && input.dirtyWorkspace.state === 'clean') {
    return { value: 'high', reason: 'scoped-worktree-clean' };
  }
  if (input.selectionSource === 'cwd') return { value: 'medium', reason: 'implicit-cwd-repo' };
  if (input.dirtyWorktree === true || input.changedSinceIndex === true) {
    return {
      value: 'medium',
      reason: input.headChangedSinceIndex ? 'index-head-stale' : 'dirty-worktree',
      repairCommand: input.headChangedSinceIndex
        ? 'Re-run ontoindex analyze for the target repo.'
        : 'Clean, stash, or commit dirty files, then retry.',
    };
  }
  if (input.selectionSource === 'single')
    return { value: 'medium', reason: 'implicit-single-repo' };
  return { value: 'high', reason: 'target-context-aligned' };
}

function repoPathMismatchWarning(input: {
  selector: string;
  selectedPath: string;
  conflictingSource: string;
  conflictingPath: string;
}): string {
  return `REPO_PATH_MISMATCH: ${input.conflictingSource} resolves to ${input.conflictingPath}, but ${input.selector} resolved to ${input.selectedPath}. Retry with repo: "${input.selectedPath}".`;
}

function actionWithRetryExamples(
  status: Exclude<TargetContextStatus, 'ok'>,
  registry: RegistryEntry[],
  requestedRepo?: string,
): string {
  const reason =
    status === 'ambiguous' ? 'ambiguous' : status === 'not-found' ? 'not-found' : 'no-index';
  return formatRepoResolutionError({
    reason,
    requestedRepo,
    candidates: repoResolutionCandidatesFromEntries(registry),
    environment: repoResolutionEnvironmentFromProcess(),
  });
}

function buildAmbiguousRepoAction(
  envRepo: string,
  envRepoPath: string,
  cwdRepoRoot: string,
  cwdRepoPath: string,
): string {
  return `Repository selection is ambiguous: ONTOINDEX_MCP_REPO "${envRepo}" resolves to ${envRepoPath}, while MCP cwd ${cwdRepoRoot} resolves to ${cwdRepoPath}. Retry with repo: "${envRepoPath}" or repo: "${cwdRepoPath}".`;
}

function resolveEmbeddingsReadiness(
  entry: RegistryEntry,
  overrideCount: number | undefined,
): TargetContextEmbeddingsReadiness {
  const count = overrideCount ?? entry.stats?.embeddings;
  if (count === undefined) return { status: 'unknown', reason: 'embedding-stats-unavailable' };
  return count > 0
    ? { status: 'available', count }
    : { status: 'unavailable', count, reason: 'embeddings-not-populated' };
}

function resolveLspReadiness(
  lspAvailable: { typescript: boolean; python: boolean; rust: boolean } | undefined,
): TargetContextLspReadiness {
  if (!lspAvailable) return { status: 'unknown', reason: 'not-probed' };
  const anyAvailable = Object.values(lspAvailable).some(Boolean);
  return {
    status: anyAvailable ? 'available' : 'unavailable',
    servers: lspAvailable,
    ...(!anyAvailable ? { reason: 'no-lsp-server-on-path' } : {}),
  };
}

async function resolveSidecarReadiness(
  entry: RegistryEntry,
  checkSidecar: boolean,
  deps: ResolveTargetContextDeps,
  warnings: string[],
): Promise<TargetContextSidecarReadiness> {
  if (!checkSidecar) return { status: 'unknown', reason: 'not-probed' };
  try {
    const loadState = deps.loadSidecarState ?? loadSidecarStoreState;
    const state = await loadState(getSidecarStorePath(entry.storagePath));
    const running =
      state.lock !== null || state.requests.some((request) => request.status === 'running');
    if (state.requests.length === 0 && state.enrichments.length === 0 && !running) {
      return { status: 'unavailable', reason: 'sidecar-store-empty', requests: 0, enrichments: 0 };
    }
    return {
      status: running ? 'degraded' : 'available',
      ...(running ? { reason: 'sidecar-running' } : {}),
      requests: state.requests.length,
      enrichments: state.enrichments.length,
      running,
    };
  } catch (err) {
    warnings.push(`sidecar readiness probe failed: ${formatError(err)}`);
    return { status: 'unknown', reason: 'sidecar-probe-failed' };
  }
}

function resolveQualityMode(): QualityMode {
  const lspRefs = process.env.ONTOINDEX_LSP_REFERENCES !== undefined;
  const ensemble = process.env.ONTOINDEX_INTENT_ENSEMBLE !== undefined;
  const citations = process.env.ONTOINDEX_CITATIONS !== undefined;
  if (lspRefs && ensemble && citations) return 'thorough';
  if (ensemble && citations) return 'balanced';
  return 'fast';
}

function toRepoSummary(entry: RegistryEntry): TargetContextRepoSummary {
  return { key: entry.name, path: entry.path };
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
