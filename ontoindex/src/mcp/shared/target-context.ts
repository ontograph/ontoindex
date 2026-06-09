import path from 'node:path';

import { execFileText } from '../../core/process/exec-file.js';
import {
  getSidecarStorePath,
  loadSidecarStoreState,
} from '../../core/ingestion/enrichment/index.js';
import { readRegistry, type RegistryEntry } from '../../storage/repo-manager.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export type TargetContextStatus = 'ok' | 'ambiguous' | 'no-index' | 'not-found';
export type SnapshotMode = 'committed-head' | 'dirty-worktree-overlay' | 'diff-ref' | 'unknown';
export type ReadinessStatus = 'available' | 'unavailable' | 'unknown' | 'degraded';
export type QualityMode = 'fast' | 'balanced' | 'thorough';

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

export interface TargetContext {
  version: 1;
  status: TargetContextStatus;
  repoKey?: string;
  repoPath?: string;
  branch?: string;
  targetRef: string;
  targetHead?: string;
  currentHead?: string;
  indexedHead?: string;
  graphIndexId?: string;
  dirtyWorktree: boolean | null;
  changedSinceIndex: boolean | null;
  snapshotMode: SnapshotMode;
  qualityMode: QualityMode;
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
  targetRef?: string;
  checkSidecar?: boolean;
  readiness?: {
    embeddingsCount?: number;
    lspAvailable?: { typescript: boolean; python: boolean; rust: boolean };
  };
}

export interface ResolveTargetContextDeps {
  readRegistry?: () => Promise<RegistryEntry[]>;
  execGit?: (cwd: string, args: string[]) => Promise<string>;
  loadSidecarState?: typeof loadSidecarStoreState;
}

export async function resolveTargetContext(
  options: ResolveTargetContextOptions = {},
  deps: ResolveTargetContextDeps = {},
): Promise<TargetContext> {
  const warnings: string[] = [];
  const registry = await readRegistrySafely(deps, warnings);
  const targetRef = options.targetRef?.trim() || 'HEAD';
  const base = createBaseContext(targetRef, warnings);
  const resolution = resolveRegistryEntry(registry, options.repo);

  if (resolution.status !== 'ok') {
    return {
      ...base,
      status: resolution.status,
      availableRepos: registry.map(toRepoSummary),
      action: resolution.action,
      warnings,
    };
  }

  const entry = resolution.entry;
  const repoPath = path.resolve(entry.path);
  const execGit = deps.execGit ?? defaultExecGit;
  const [branch, currentHead, targetHead, statusOutput] = await Promise.all([
    gitProbe(execGit, repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], warnings),
    gitProbe(execGit, repoPath, ['rev-parse', 'HEAD'], warnings),
    gitProbe(execGit, repoPath, ['rev-parse', targetRef], warnings),
    gitProbe(execGit, repoPath, ['status', '--porcelain'], warnings),
  ]);
  const dirtyWorktree = statusOutput !== null ? statusOutput.trim().length > 0 : null;
  const indexedHead = entry.lastCommit || undefined;
  const changedSinceIndex =
    dirtyWorktree === null && (!currentHead || !indexedHead)
      ? null
      : dirtyWorktree === true || (!!currentHead && !!indexedHead && currentHead !== indexedHead);

  return {
    ...base,
    status: 'ok',
    repoKey: entry.name,
    repoPath,
    ...(branch ? { branch } : {}),
    ...(targetHead ? { targetHead } : {}),
    ...(currentHead ? { currentHead } : {}),
    ...(indexedHead ? { indexedHead } : {}),
    ...(entry.indexedAt ? { graphIndexId: entry.indexedAt } : {}),
    dirtyWorktree,
    changedSinceIndex,
    snapshotMode: resolveSnapshotMode(targetRef, dirtyWorktree),
    embeddings: resolveEmbeddingsReadiness(entry, options.readiness?.embeddingsCount),
    lsp: resolveLspReadiness(options.readiness?.lspAvailable),
    sidecar: await resolveSidecarReadiness(entry, options.checkSidecar === true, deps, warnings),
    policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
    warnings,
  };
}

function createBaseContext(targetRef: string, warnings: string[]): TargetContext {
  return {
    version: 1,
    status: 'no-index',
    targetRef,
    dirtyWorktree: null,
    changedSinceIndex: null,
    snapshotMode: 'unknown',
    qualityMode: resolveQualityMode(),
    embeddings: { status: 'unknown', reason: 'repo-not-resolved' },
    lsp: { status: 'unknown', reason: 'not-probed' },
    sidecar: { status: 'unknown', reason: 'not-probed' },
    policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
    warnings,
  };
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
  if (path.resolve(entry.path) === path.resolve(repo)) return true;
  return allowFuzzy && entry.name.toLowerCase().includes(repoLower);
}

async function gitProbe(
  execGit: (cwd: string, args: string[]) => Promise<string>,
  cwd: string,
  args: string[],
  warnings: string[],
): Promise<string | null> {
  try {
    return (await execGit(cwd, args)).trim();
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
