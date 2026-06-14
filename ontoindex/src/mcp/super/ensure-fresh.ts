/**
 * gn_ensure_fresh — Index lifecycle helper super-function.
 *
 * Reports whether the OntoIndex index is stale (indexed commit ≠ current HEAD),
 * surfaces embeddings status, and optionally re-runs `ontoindex analyze`
 * when `autoAnalyze: true` is passed.
 *
 * This is a READ-ONLY super-function by default (autoAnalyze defaults to false).
 * It never modifies the index without explicit caller consent.
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import path, { join } from 'path';
import { homedir } from 'os';
import { execFileText } from '../../core/process/exec-file.js';
import type { ScopeConfidence } from '../shared/target-context.js';

const AUTO_ANALYZE_TIMEOUT_MS = Number.parseInt(
  process.env.ONTOINDEX_AUTO_ANALYZE_TIMEOUT_MS ?? '300000',
  10,
);
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
}

export interface EnsureFreshReport {
  version: 1;
  preCheck: { indexedCommit: string; currentCommit: string; isStale: boolean };
  embeddingsStatus: { count: number; required: boolean };
  repoLabel?: string;
  repoPath?: string;
  indexedCommit?: string;
  headCommit?: string;
  isStale?: boolean;
  dirtyFileCount?: number | null;
  scopeConfidence?: ScopeConfidence;
  actionsTaken: string[];
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
): EnsureFreshReport {
  return {
    version: 1,
    preCheck: { indexedCommit: '', currentCommit: '', isStale: false },
    embeddingsStatus: { count: 0, required: false },
    ...extras,
    actionsTaken: [],
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

function runAnalyzeProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    });

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5_000);
    }, timeoutMs);

    child.once('error', (err) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) {
        resolve();
        return;
      }
      if (timedOut) {
        reject(new Error(`analyze timed out after ${timeoutMs}ms`));
        return;
      }
      reject(
        new Error(`analyze exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`),
      );
    });
  });
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

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function gnEnsureFresh(
  repoId: string,
  params: EnsureFreshParams,
): Promise<EnsureFreshReport> {
  const warnings: string[] = [];
  const recommendations: string[] = [];
  const actionsTaken: string[] = [];

  // ---- 1. Read registry ---------------------------------------------------
  const registryPath = join(homedir(), '.ontoindex', 'registry.json');
  let registry: RegistryEntry[] = [];
  try {
    registry = parseRegistryJson(readFileSync(registryPath, 'utf8'));
  } catch (err) {
    warnings.push('cannot read ~/.ontoindex/registry.json: ' + String(err));
    return emptyReport(warnings, recommendations);
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
  const embeddingsCount: number = entry.stats?.embeddings ?? 0;
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

  // ---- 5. Embeddings status -----------------------------------------------
  const embeddingsStatus = {
    count: embeddingsCount,
    required: params.withEmbeddings === true && embeddingsCount === 0,
  };

  // ---- 6. Recommendations (always populated) ------------------------------
  if (isStale) {
    recommendations.push(
      `Index is stale (indexed ${indexedCommit} vs current ${currentCommit}). Run: ontoindex analyze${params.withEmbeddings ? ' --embeddings' : ''}`,
    );
    recommendations.push(
      'For multi-agent sessions, let one coordinator run analyze; workers should continue with explicit stale-index consent or git-only workflows.',
    );
  }
  if (params.withEmbeddings && embeddingsCount === 0) {
    recommendations.push(
      'Embeddings not populated. Stop MCP processes first to release DB lock, then run: ontoindex analyze --embeddings',
    );
  }

  // ---- 7. Auto-analyze (only when explicitly requested AND stale) ---------
  let postCheck: EnsureFreshReport['postCheck'];

  if (params.autoAnalyze && isStale) {
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
    if (params.withEmbeddings) args.push('--embeddings');

    try {
      await runAnalyzeProcess(
        cli.command,
        args,
        repoRoot,
        Number.isFinite(AUTO_ANALYZE_TIMEOUT_MS) ? AUTO_ANALYZE_TIMEOUT_MS : 300000,
      );
      actionsTaken.push(
        `Ran: ${cli.displayPrefix} analyze${params.withEmbeddings ? ' --embeddings' : ''}`,
      );

      if (params.killMcpForLock) {
        recommendations.push(
          "If you stopped an MCP server manually, restart it via your editor's MCP config or: ontoindex mcp --repo <repo>",
        );
      }

      // Re-read registry for postCheck
      const updatedRegistry = parseRegistryJson(readFileSync(registryPath, 'utf8'));
      const updatedEntry = findRegistryEntry(updatedRegistry, selector, repoRoot);
      if (updatedEntry) {
        postCheck = {
          indexedCommit: updatedEntry.lastCommit ?? '',
          currentCommit,
          isStale: currentCommit !== updatedEntry.lastCommit,
        };
      }
    } catch (err) {
      warnings.push('analyze failed: ' + (err instanceof Error ? err.message : String(err)));
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
    actionsTaken,
    ...(postCheck !== undefined ? { postCheck } : {}),
    warnings,
    recommendations,
  };
}
