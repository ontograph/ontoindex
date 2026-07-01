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
import { gnDiagnose } from '../mcp/super/diagnose.js';
import type { AuditFreshnessReport, DiagnoseReport } from '../mcp/super/diagnose.js';

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
  console.log(formatRuntimeHealthStatusLine(runtimeHealth));
  for (const line of formatRuntimeHealthDetailLines(runtimeHealth)) {
    console.log(line);
  }
  console.log(`Status: ${describeRuntimeStatus(runtimeHealth)}`);
  console.log(formatSemanticSearchStatus(repo.meta));
  for (const line of formatIndexCapabilityWarnings(repo.meta)) {
    console.log(line);
  }
  printNeedsUpdateStatus(needsUpdateReason);
  console.log(nativeGraphWriterStatus);
  await printDiagnosticsSummary(repoRoot, storagePath);
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

function formatGraphIndexStatus(freshness: DiagnoseReport['runtimeContextSummary']['freshness']): string {
  switch (freshness) {
    case 'fresh':
      return 'clean';
    case 'stale':
      return 'stale';
    default:
      return 'unknown';
  }
}

function formatDirtyWorktreeStatus(
  dirtyWorktree: boolean | null,
  dirtyFileCount: number | null,
): string {
  if (dirtyWorktree === null) return 'unknown';
  if (!dirtyWorktree) return 'no';
  return `yes, ${dirtyFileCount ?? 0} files changed`;
}

function formatEmbeddingsDiagnostics(report: DiagnoseReport): string {
  const count = report.embeddings?.count ?? 0;
  const status = report.embeddings?.status;
  switch (status) {
    case 'ok':
      return `Embeddings: available, ${count} recorded`;
    case 'drifted':
      return `Embeddings: drifted metadata, ${count} recorded`;
    case 'metadata-unavailable':
      return `Embeddings: metadata unavailable, ${count} recorded`;
    case 'missing':
      return `Embeddings: missing, ${count} recorded`;
    default:
      return `Embeddings: ${report.runtimeContextSummary.embeddings}`;
  }
}

function formatAuditProjectionStatus(audit: AuditFreshnessReport | undefined): string {
  if (!audit) return 'Audit projection: unknown';
  if (audit.status === 'clean') {
    return `Audit projection: clean, target ${audit.targetHead?.slice(0, 8) ?? 'unknown'}`;
  }
  if (audit.status === 'stale') {
    return `Audit projection: stale, target ${audit.targetHead?.slice(0, 8) ?? 'unknown'} vs current ${
      audit.currentHead?.slice(0, 8) ?? 'unknown'
    }`;
  }
  if (audit.status === 'dirty') {
    return `Audit projection: dirty, target ${audit.targetHead?.slice(0, 8) ?? 'unknown'}`;
  }
  if (audit.status === 'missing') {
    return 'Audit projection: absent';
  }
  return `Audit projection: ${audit.status}`;
}

function formatMcpResourcesStatus(report: DiagnoseReport): string {
  const bridge = report.mcpResourceBridge;
  if (!bridge) return 'MCP resources: unknown';
  if (!bridge.exposed) return 'MCP resources: not exposed';
  return `MCP resources: exposed (${bridge.exposedTo.join(', ')})`;
}

export function formatSupportLines(report: DiagnoseReport): string[] {
  const support = report.support;
  if (!support) return [];

  const lines = [
    support.lbugStore.exists
      ? `Ladybug store: present (${formatStoreSize(support.lbugStore.sizeBytes)}, modified ${support.lbugStore.modifiedAt ?? 'unknown'})`
      : 'Ladybug store: absent',
    `Ladybug sidecars: wal ${support.lbugStore.walPresent ? 'present' : 'absent'}, lock ${support.lbugStore.lockPresent ? 'present' : 'absent'}`,
    `Ladybug extensions: fts ${support.ladybugExtensions.ftsAvailable ? 'available' : 'missing'}, vector ${support.ladybugExtensions.vectorAvailable ? 'available' : 'missing'}`,
    `Ladybug timeout: native getAll ${support.timeoutHints.nativeGetAllMs}ms`,
  ];

  if (
    support.ladybugExtensions.hintDir &&
    (!support.ladybugExtensions.ftsAvailable || !support.ladybugExtensions.vectorAvailable)
  ) {
    lines.push(`Ladybug extension hint: ${support.ladybugExtensions.hintDir}`);
  }
  if (report.auditFreshness?.repairCommand) {
    lines.push(`Audit replay: ${report.auditFreshness.repairCommand}`);
  }
  return lines;
}

function formatStoreSize(sizeBytes: number | undefined): string {
  const size = sizeBytes ?? 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function printDiagnosticsSummary(repoRoot: string, _storagePath: string) {
  let diagnose: DiagnoseReport;
  try {
    diagnose = await gnDiagnose(repoRoot, {
      legacyResponse: true,
      checkLsp: false,
      checkEmbeddings: true,
      checkIndexFreshness: true,
      checkToolContract: false,
    });
  } catch (error) {
    console.log('');
    console.log(`Diagnostics: unavailable (${error instanceof Error ? error.message : String(error)})`);
    return;
  }

  console.log('');
  console.log(`Graph index: ${formatGraphIndexStatus(diagnose.runtimeContextSummary.freshness)}`);
  console.log(
    `Dirty worktree: ${formatDirtyWorktreeStatus(
      diagnose.runtimeContextSummary.dirtyWorktree,
      diagnose.runtimeContextSummary.dirtyFileCount,
    )}`,
  );
  console.log(`Scope confidence: ${diagnose.runtimeContextSummary.scopeConfidence ?? 'unknown'}`);
  console.log(formatEmbeddingsDiagnostics(diagnose));
  console.log(formatAuditProjectionStatus(diagnose.auditFreshness));
  console.log(formatMcpResourcesStatus(diagnose));
  for (const line of formatSupportLines(diagnose)) {
    console.log(line);
  }
}
