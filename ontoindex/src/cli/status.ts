/**
 * Status Command
 *
 * Shows the indexing status of the current repository.
 */

import path from 'path';
import {
  findRepo,
  getStoragePaths,
  hasKuzuIndex,
  listRegisteredRepos,
  loadRepo,
} from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo, getGitRoot } from '../storage/git.js';
import { getNativeGraphWriterStatus, type GraphWriterRuntime } from '../native/graph-writer.js';
export { formatIndexCapabilityWarnings } from '../storage/index-capabilities.js';
import { formatIndexCapabilityWarnings } from '../storage/index-capabilities.js';

export const formatNativeGraphWriterStatus = (runtime: GraphWriterRuntime = {}): string => {
  const status = getNativeGraphWriterStatus(runtime);
  const configured = status.configured ? 'configured' : 'not configured';
  const enabled = status.enabled ? 'enabled' : 'disabled';
  const available = status.available ? 'available' : 'unavailable';
  return `Native graph writer: ${status.flagName} ${enabled}, ${configured}, ${available} (${status.reason})`;
};

async function resolveRepoStartPath(repoOpt?: string): Promise<string> {
  if (!repoOpt?.trim()) return process.cwd();

  const resolvedPath = path.resolve(repoOpt);
  const directRepo = await loadRepo(resolvedPath);
  if (directRepo) return directRepo.repoPath;

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
    console.log('Not a git repository.');
    console.log(nativeGraphWriterStatus);
    return;
  }

  const repo = await findRepo(cwd);
  if (!repo) {
    // Check if there's a stale KuzuDB index that needs migration
    const repoRoot = getGitRoot(cwd) ?? cwd;
    const { storagePath } = getStoragePaths(repoRoot);
    if (await hasKuzuIndex(storagePath)) {
      console.log('Repository has a stale KuzuDB index from a previous version.');
      console.log('Run: ontoindex analyze   (rebuilds the index with LadybugDB)');
    } else {
      console.log('Repository not indexed.');
      console.log('Run: ontoindex analyze');
    }
    console.log(nativeGraphWriterStatus);
    return;
  }

  const currentCommit = getCurrentCommit(repo.repoPath);
  const isUpToDate = currentCommit === repo.meta.lastCommit;

  console.log(`Repository: ${repo.repoPath}`);
  console.log(`Indexed: ${new Date(repo.meta.indexedAt).toLocaleString()}`);
  console.log(`Indexed commit: ${repo.meta.lastCommit?.slice(0, 7)}`);
  console.log(`Current commit: ${currentCommit?.slice(0, 7)}`);
  console.log(`Status: ${isUpToDate ? '✅ up-to-date' : '⚠️ stale (re-run ontoindex analyze)'}`);
  for (const line of formatIndexCapabilityWarnings(repo.meta)) {
    console.log(line);
  }
  console.log(nativeGraphWriterStatus);
};
