/**
 * Status Command
 *
 * Shows the indexing status of the current repository.
 */

import { readFile } from 'node:fs/promises';
import path from 'path';
import type { RepoMeta } from '../storage/repo-manager.js';
import {
  findRepo,
  getStoragePaths,
  hasKuzuIndex,
  listRegisteredRepos,
  loadRepo,
} from '../storage/repo-manager.js';
import { isGitRepo, getGitRoot } from '../storage/git.js';
import { getNativeGraphWriterStatus, type GraphWriterRuntime } from '../native/graph-writer.js';
import {
  formatRuntimeHealthDetailLines,
  formatRuntimeHealthStatusLine,
  readRuntimeHealth,
} from '../core/runtime/runtime-health.js';
export { formatIndexCapabilityWarnings } from '../storage/index-capabilities.js';
import { formatIndexCapabilityWarnings } from '../storage/index-capabilities.js';

export const formatNativeGraphWriterStatus = (runtime: GraphWriterRuntime = {}): string => {
  const status = getNativeGraphWriterStatus(runtime);
  const configured = status.configured ? 'configured' : 'not configured';
  const enabled = status.enabled ? 'enabled' : 'disabled';
  const available = status.available ? 'available' : 'unavailable';
  return `Native graph writer: ${status.flagName} ${enabled}, ${configured}, ${available} (${status.reason})`;
};

export const formatSemanticSearchStatus = (
  meta?: Pick<RepoMeta, 'stats' | 'indexMode' | 'pipelineProfile'>,
): string => {
  const embeddings = meta?.stats?.embeddings;
  if (typeof embeddings !== 'number') {
    return 'Semantic search: absent (no index metadata yet; run ontoindex analyze --embeddings to populate)';
  }

  if (embeddings > 0) {
    return `Semantic search: available (${embeddings.toLocaleString()} embeddings recorded)`;
  }

  const isSymbolsOnly =
    meta?.indexMode === 'symbols-only' ||
    meta?.pipelineProfile === 'symbols' ||
    meta?.pipelineProfile === 'huge-repo-symbols';
  const source = isSymbolsOnly ? 'symbols-only index' : '0 embeddings recorded';
  return `Semantic search: absent (${source}; run ontoindex analyze --embeddings to populate)`;
};

async function resolveRepoStartPath(repoOpt?: string): Promise<string> {
  if (!repoOpt?.trim()) return process.cwd();

  const resolvedPath = path.resolve(repoOpt);
  const directRepo = await loadRepo(resolvedPath);
  if (directRepo) return directRepo.repoPath;

  const isExplicitPath =
    path.isAbsolute(repoOpt) ||
    repoOpt.startsWith('.') ||
    repoOpt.includes(path.sep) ||
    repoOpt.includes(path.win32.sep);
  if (isExplicitPath) return resolvedPath;

  const entries = await listRegisteredRepos({ validate: true });
  const lower = repoOpt.toLowerCase();
  const matches = entries.filter(
    (entry) => entry.name.toLowerCase() === lower || path.resolve(entry.path) === resolvedPath,
  );

  if (matches.length === 1) return matches[0].path;
  if (matches.length > 1) {
    throw new Error(
      `Repository "${repoOpt}" is ambiguous. Use an absolute path. Matches: ${matches
        .map((entry) => `${entry.name} (${entry.path})`)
        .join(', ')}`,
    );
  }

  throw new Error(
    `Repository "${repoOpt}" is not indexed. Available: ${entries
      .map((entry) => entry.name)
      .join(', ')}`,
  );
}

export const statusCommand = async (options?: { repo?: string }) => {
  const cwd = await resolveRepoStartPath(options?.repo);
  const nativeGraphWriterStatus = formatNativeGraphWriterStatus();

  if (!isGitRepo(cwd)) {
    const needsUpdateReason = await readNeedsUpdateReason(cwd);
    console.log('Not a git repository.');
    console.log(formatSemanticSearchStatus());
    printNeedsUpdateStatus(needsUpdateReason);
    console.log(nativeGraphWriterStatus);
    return;
  }

  const repo = await findRepo(cwd);
  const repoRoot = getGitRoot(cwd) ?? cwd;
  const needsUpdateReason = await readNeedsUpdateReason(repoRoot);
  const { storagePath } = getStoragePaths(repoRoot);
  if (!repo) {
    // Check if there's a stale KuzuDB index that needs migration
    if (await hasKuzuIndex(storagePath)) {
      console.log('Repository has a stale KuzuDB index from a previous version.');
      console.log(
        'Semantic search: absent (stale KuzuDB index; rebuild with ontoindex analyze --embeddings)',
      );
      console.log('Run: ontoindex analyze   (rebuilds the index with LadybugDB)');
    } else {
      console.log('Repository not indexed.');
      const runtimeHealth = await readRuntimeHealth(repoRoot, {
        repoLabel: path.basename(repoRoot),
        storagePath,
      });
      if (runtimeHealth.hasRuntimeArtifacts) {
        console.log(formatRuntimeHealthStatusLine(runtimeHealth));
        for (const line of formatRuntimeHealthDetailLines(runtimeHealth)) {
          console.log(line);
        }
      }
      console.log(
        'Semantic search: absent (no index metadata yet; run ontoindex analyze --embeddings to populate)',
      );
      console.log('Run: ontoindex analyze');
    }
    printNeedsUpdateStatus(needsUpdateReason);
    console.log(nativeGraphWriterStatus);
    return;
  }

  const runtimeHealth = await readRuntimeHealth(repo.repoPath, {
    repoLabel: path.basename(repo.repoPath),
    storagePath: repo.storagePath,
    meta: repo.meta,
  });

  console.log(`Repository: ${repo.repoPath}`);
  console.log(`Indexed: ${new Date(repo.meta.indexedAt).toLocaleString()}`);
  console.log(`Indexed commit: ${runtimeHealth.indexedCommit?.slice(0, 7) ?? 'unavailable'}`);
  console.log(`Current commit: ${runtimeHealth.currentCommit?.slice(0, 7) ?? 'unavailable'}`);
  console.log(`Status: ${describeRuntimeStatus(runtimeHealth)}`);
  console.log(formatRuntimeHealthStatusLine(runtimeHealth));
  for (const line of formatRuntimeHealthDetailLines(runtimeHealth)) {
    console.log(line);
  }
  console.log(formatSemanticSearchStatus(repo.meta));
  for (const line of formatIndexCapabilityWarnings(repo.meta)) {
    console.log(line);
  }
  printNeedsUpdateStatus(needsUpdateReason);
  console.log(nativeGraphWriterStatus);
};

async function readNeedsUpdateReason(repoRoot: string): Promise<string | null> {
  try {
    const marker = await readFile(path.join(repoRoot, '.ontoindex', 'needs_update'), 'utf8');
    return parseNeedsUpdateReason(marker);
  } catch {
    return null;
  }
}

function parseNeedsUpdateReason(marker: string): string {
  const trimmed = marker.trim();
  if (!trimmed) return 'marker present';
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { reason?: unknown };
      if (typeof parsed.reason === 'string') {
        const reason = parsed.reason.trim();
        if (reason) return reason;
      }
    } catch {
      // Fall through to the default passive marker message.
    }
  }
  return 'marker present';
}

function printNeedsUpdateStatus(reason: string | null): void {
  if (!reason) return;
  console.log(`Needs update: ${reason}`);
  console.log('Repair: ontoindex analyze');
}

function describeRuntimeStatus(health: Awaited<ReturnType<typeof readRuntimeHealth>>): string {
  switch (health.freshnessState) {
    case 'clean':
      return '✅ up-to-date';
    case 'stale':
      return '⚠️ stale (re-run ontoindex analyze)';
    case 'dirty':
      return '⚠️ dirty worktree (commit, stash, or clean before re-running analyze)';
    case 'degraded':
      return '⚠️ degraded (runtime artifacts present)';
    case 'untrusted':
      return '⚠️ untrusted (runtime artifacts need repair)';
    case 'failed-after-partial-run':
      return '⛔ failed after partial analyze (repair required)';
  }
  return '⚠️ degraded (runtime artifacts present)';
}
