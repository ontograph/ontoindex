/**
 * Analyze Command
 *
 * Indexes a repository and stores the knowledge graph in .ontoindex/
 *
 * Delegates core analysis to the shared runFullAnalysis orchestrator.
 * This CLI wrapper handles: heap management, progress bar, SIGINT,
 * skill generation (--skills), summary output, and process.exit().
 */

import path from 'path';
import { execFileSync } from 'child_process';
import v8 from 'v8';
import cliProgress from 'cli-progress';
import { closeLbug } from '../core/lbug/lbug-adapter.js';
import {
  getStoragePaths,
  getGlobalRegistryPath,
  RegistryNameCollisionError,
  readActiveGenerationMeta,
} from '../storage/repo-manager.js';
import { getGitRoot, hasGitDir } from '../storage/git.js';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  applyLargeRepoSafeAnalyzePreset,
  formatHugeRepoNote,
  formatLargeRepoSafeNote,
  parseLargeRepoSafeAppliedList,
} from './analyze-large-repo-safe.js';
import {
  planExperimentalFileDeltaRefresh,
  planDirtyOverlay,
  type ExperimentalFileDeltaPlan,
} from '../core/analyze-delta.js';
import {
  collectFileScopePreview,
  explainPathScope,
  type FileScopePreview,
} from '../core/indexing/file-scope-preview.js';
import type { PipelineProfile } from '../core/ingestion/pipeline.js';
import type { EmbeddingLifecycleSummary } from '../core/run-analyze.js';
import {
  resolveOverlayDbPath,
  isAutomaticWorkspaceEnabled,
  getOverlaySnapshot,
  evictOverlayState,
  type OverlaySnapshot,
} from '../mcp/local/backend-overlay.js';
import { buildWorkspaceGraph } from '../mcp/local/local-backend-repo-runtime.js';
import { assertWorkspaceBuildAdmission } from '../mcp/local/workspace-build-supervisor.js';
import { parseManagedAnalysisContextFromEnv } from '../core/analysis/analysis-publication-receipt.js';
import { acquireNativeFileLock } from '../native/file-lock.js';

const HEAP_MB = 8192;
const HEAP_FLAG = `--max-old-space-size=${HEAP_MB}`;
/** Increase default stack size (KB) to prevent stack overflow on deep class hierarchies. */
const STACK_KB = 4096;
const STACK_FLAG = `--stack-size=${STACK_KB}`;

interface ErrorWithCode {
  code?: unknown;
}

interface ErrorWithStatus {
  status?: unknown;
}

interface ErrorWithMessage {
  message?: unknown;
}

interface AnalyzeLockRecord {
  pid?: unknown;
  token?: unknown;
  startedAt?: unknown;
  processStartIdentity?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasProperties(
  value: unknown,
): value is ErrorWithCode & ErrorWithStatus & ErrorWithMessage {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function getErrorCode(error: unknown): string | undefined {
  if (!hasProperties(error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

function getErrorStatus(error: unknown): number | undefined {
  if (!hasProperties(error)) return undefined;
  const { status } = error;
  return typeof status === 'number' ? status : undefined;
}

function getErrorMessage(error: unknown): string {
  if (hasProperties(error)) {
    const { message } = error;
    if (message) return String(message);
  }
  return String(error);
}

function formatEmbeddingLifecycle(summary?: EmbeddingLifecycleSummary): string {
  if (!summary) return 'Embedding lifecycle: unknown';

  switch (summary.state) {
    case 'preserved':
      return 'Embedding lifecycle: preserve (embeddings preserved from cache)';
    case 'refreshed':
      return 'Embedding lifecycle: refresh (embeddings refreshed)';
    case 'skipped':
      return `Embedding lifecycle: ${summary.mode} (embeddings skipped)`;
    case 'absent':
      return `Embedding lifecycle: ${summary.mode} (embeddings absent)`;
    case 'available':
      return `Embedding lifecycle: ${summary.mode} (embeddings available)`;
  }

  return 'Embedding lifecycle: unknown';
}

function parseAnalyzeLockRecord(contents: string): AnalyzeLockRecord | null {
  const parsed: unknown = JSON.parse(contents);
  return isObject(parsed) ? parsed : null;
}

/** Re-exec the process with an 8GB heap and larger stack if we're currently below that. */
function ensureHeap(): boolean {
  const nodeOpts = process.env.NODE_OPTIONS || '';
  if (nodeOpts.includes('--max-old-space-size')) return false;

  const v8Heap = v8.getHeapStatistics().heap_size_limit;
  if (v8Heap >= HEAP_MB * 1024 * 1024 * 0.9) return false;

  // --stack-size is a V8 flag not allowed in NODE_OPTIONS on Node 24+,
  // so pass it only as a direct CLI argument, not via the environment.
  const cliFlags = [HEAP_FLAG];
  if (!nodeOpts.includes('--stack-size')) cliFlags.push(STACK_FLAG);

  try {
    execFileSync(process.execPath, [...cliFlags, ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: `${nodeOpts} ${HEAP_FLAG}`.trim() },
    });
  } catch (e: unknown) {
    process.exitCode = getErrorStatus(e) ?? 1;
  }
  return true;
}

interface AnalyzeLock {
  path: string;
  release: () => Promise<void>;
}

function isProcessAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) === 'ESRCH' ? false : null;
  }
}

async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return fields[19] || null;
  } catch {
    return null;
  }
}

async function isAnalyzeLockOwnerActive(record: AnalyzeLockRecord): Promise<boolean | null> {
  if (record.token !== undefined && typeof record.token !== 'string') return null;
  if (
    record.processStartIdentity !== undefined &&
    (typeof record.processStartIdentity !== 'string' || !record.processStartIdentity)
  )
    return null;
  const pid =
    typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0
      ? record.pid
      : null;
  if (pid === null) return null;
  const alive = isProcessAlive(pid);
  if (alive !== true) return alive;

  const recordedIdentity =
    typeof record.processStartIdentity === 'string' ? record.processStartIdentity : null;
  if (!recordedIdentity) return true;
  const currentIdentity = await readProcessStartIdentity(pid);
  if (!currentIdentity) return null;
  return currentIdentity === recordedIdentity;
}

async function archiveStaleAnalyzeDiagnostics(
  storagePath: string,
  lockContents: string,
  token: string | undefined,
): Promise<void> {
  const recoveryPath = path.join(storagePath, 'recovery');
  await fs.mkdir(recoveryPath, { recursive: true });
  let checkpoint: string | undefined;
  try {
    checkpoint = (
      await fs.readFile(path.join(storagePath, 'analysis-checkpoint.json'), 'utf-8')
    ).slice(0, 64 * 1024);
  } catch {}
  const suffix = `${Date.now()}-${(token ?? 'legacy').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)}`;
  await fs.writeFile(
    path.join(recoveryPath, `stale-analyze-${suffix}.json`),
    JSON.stringify(
      {
        archivedAt: new Date().toISOString(),
        lock: lockContents.slice(0, 16 * 1024),
        ...(checkpoint ? { checkpoint } : {}),
      },
      null,
      2,
    ),
    'utf-8',
  );
}

async function removeAnalyzeLockIfOwner(
  lockPath: string,
  expectedPid: number,
  expectedToken?: string,
): Promise<boolean> {
  try {
    const current = parseAnalyzeLockRecord(await fs.readFile(lockPath, 'utf-8'));
    if (current?.pid !== expectedPid) return false;
    if (expectedToken !== undefined && current?.token !== expectedToken) return false;
    if (expectedToken === undefined && current?.token !== undefined) return false;
    await fs.unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function createAnalyzeLockFile(
  lockPath: string,
  token: string,
  processStartIdentity: string | null,
  repoPath: string,
): Promise<AnalyzeLock> {
  const temporaryPath = `${lockPath}.${token}.tmp`;
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(
        JSON.stringify(
          {
            pid: process.pid,
            token,
            startedAt: new Date().toISOString(),
            ...(processStartIdentity ? { processStartIdentity } : {}),
            repoPath,
            command: process.argv.join(' '),
          },
          null,
          2,
        ),
        'utf-8',
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(temporaryPath, lockPath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
  let released = false;
  return {
    path: lockPath,
    release: async () => {
      if (released) return;
      released = true;
      await removeAnalyzeLockIfOwner(lockPath, process.pid, token);
    },
  };
}

export async function acquireAnalyzeLock(repoPath: string): Promise<AnalyzeLock> {
  const { storagePath } = getStoragePaths(repoPath);
  await fs.mkdir(storagePath, { recursive: true });
  const lockPath = path.join(storagePath, 'analyze.lock');
  const recoveryLockPath = `${lockPath}.recovery`;
  const nativeLock = await acquireNativeFileLock(`${lockPath}.kernel`);
  let lock: AnalyzeLock | undefined;
  let transferred = false;
  try {
    // The permanent kernel lock serializes both legacy diagnostics and publication.
    // Validate both records before removing either or publishing a new owner.
    const stale: Array<{ path: string; record: AnalyzeLockRecord; contents: string }> = [];
    for (const diagnosticPath of [recoveryLockPath, lockPath]) {
      let contents: string;
      try {
        contents = await fs.readFile(diagnosticPath, 'utf-8');
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') continue;
        throw new Error(`Cannot safely recover for this repo. Lock: ${diagnosticPath}`, {
          cause: error,
        });
      }
      let record: AnalyzeLockRecord | null = null;
      try {
        record = parseAnalyzeLockRecord(contents);
      } catch {}
      const active = record ? await isAnalyzeLockOwnerActive(record) : null;
      if (active !== false) {
        const owner =
          record && typeof record.pid === 'number' ? `PID ${record.pid}` : 'another process';
        throw new Error(
          `${diagnosticPath === recoveryLockPath ? 'Another process is recovering the analyze lock. ' : ''}` +
            `${active === null ? 'Cannot safely recover' : 'OntoIndex analyze is already running'} for this repo (${owner}). Lock: ${diagnosticPath}`,
        );
      }
      stale.push({ path: diagnosticPath, record: record!, contents });
    }
    // Only the kernel-lock holder can publish staging files; earlier holders are gone.
    for (const name of await fs.readdir(storagePath)) {
      if (
        !/^analyze\.lock\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(
          name,
        )
      )
        continue;
      const stagingPath = path.join(storagePath, name);
      try {
        if ((await fs.lstat(stagingPath)).isFile()) await fs.unlink(stagingPath);
      } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') throw error;
      }
    }
    for (const diagnostic of stale) {
      const staleToken =
        typeof diagnostic.record.token === 'string' ? diagnostic.record.token : undefined;
      if (diagnostic.path === lockPath) {
        await archiveStaleAnalyzeDiagnostics(storagePath, diagnostic.contents, staleToken);
      }
      if (
        !(await removeAnalyzeLockIfOwner(
          diagnostic.path,
          diagnostic.record.pid as number,
          staleToken,
        ))
      ) {
        throw new Error(`Cannot safely recover for this repo. Lock: ${diagnostic.path}`);
      }
    }
    lock = await createAnalyzeLockFile(
      lockPath,
      randomUUID(),
      await readProcessStartIdentity(process.pid),
      repoPath,
    );
    try {
      await assertWorkspaceBuildAdmission(storagePath);
    } catch (error) {
      throw new Error(
        `Cannot safely recover workspace build for this repo. Inspect ${storagePath} before retrying.`,
        { cause: error },
      );
    }
    const diagnosticLock = lock;
    let release: Promise<void> | undefined;
    const result: AnalyzeLock = {
      path: lockPath,
      release: () =>
        (release ??= (async () => {
          try {
            await diagnosticLock.release();
          } finally {
            await nativeLock.release();
          }
        })()),
    };
    transferred = true;
    return result;
  } finally {
    if (!transferred) {
      try {
        await lock?.release();
      } finally {
        await nativeLock.release();
      }
    }
  }
}

interface AnalyzeOptions {
  force?: boolean;
  embeddings?: boolean;
  /** Build ANN_NEIGHBOR edges for symbol-neighborhood retrieval (implies embeddings). */
  annNeighbors?: boolean;
  skills?: boolean;
  skillsTarget?: string;
  verbose?: boolean;
  /** Skip AGENTS.md and CLAUDE.md ontoindex block updates. */
  skipAgentsMd?: boolean;
  /** Omit volatile symbol/relationship counts from AGENTS.md and CLAUDE.md. */
  noStats?: boolean;
  /** Index the folder even when no .git directory is present. */
  skipGit?: boolean;
  /** Deprecated compatibility flag; aliases to the bounded symbols profile. */
  indexOnly?: boolean;
  /** Apply conservative defaults for bounded large-repo analysis. */
  largeRepoSafe?: boolean;
  /** Run the minimal scan/structure/parse pipeline for symbol lookup only. */
  symbolsOnly?: boolean;
  /** Compose symbols-only, large-repo-safe defaults, and scoped-root guardrails. */
  hugeRepo?: boolean;
  /** Allow --huge-repo at repository root without explicit include paths. */
  allowHugeRoot?: boolean;
  /** Limit analysis to repository-relative file or directory roots. */
  includePath?: string[];
  markdownSidecar?: boolean;
  /** Experimental: bounded symbols-only refresh from changed files. */
  experimentalFileDelta?: boolean;
  /** Build a disposable dirty-source graph without changing the active index. */
  dirtyOverlay?: boolean;
  /** Explicitly prepare the full disposable workspace graph. */
  workspaceGraph?: boolean;
  /** Preview file scope without writing .ontoindex. */
  dryRun?: boolean;
  /** Explain why one file would be included or skipped. */
  explainFile?: string;
  /**
   * Override the default basename-derived registry `name` with a
   * user-supplied alias (#829). Disambiguates repos whose paths share a
   * basename. Persisted — subsequent re-analyses of the same path without
   * `--name` preserve the alias.
   */
  name?: string;
  /** Deprecated compatibility flag. Duplicate names are always rejected. */
  allowDuplicateName?: boolean;
}

export function resolveAnalyzePipelineProfile(
  options?: Pick<AnalyzeOptions, 'indexOnly' | 'symbolsOnly' | 'hugeRepo'>,
): PipelineProfile | undefined {
  if (options?.hugeRepo) return 'huge-repo-symbols';
  return options?.symbolsOnly || options?.indexOnly ? 'symbols' : undefined;
}

export function resolveAnalyzeIncludePaths(
  options?: Pick<AnalyzeOptions, 'includePath'>,
): string[] | undefined {
  return options?.includePath && options.includePath.length > 0
    ? [...options.includePath]
    : undefined;
}

function formatFileScopePreview(preview: FileScopePreview, includePaths?: string[]): string {
  const lines = [
    `  File scope preview for ${preview.repoPath}`,
    includePaths?.length
      ? `  Scope: selected include paths: ${includePaths.join(', ')}`
      : '  Scope: repository',
    '  Counts cover matching candidates after ignore rules; skipped files are oversized.',
    ...(includePaths?.length ? ['  Full-root file total is not measured.'] : []),
    '',
    `  Total candidates: ${preview.totalCandidates.toLocaleString()}`,
    `  Included: ${preview.includedCount.toLocaleString()}`,
    `  Skipped: ${preview.skippedCount.toLocaleString()}`,
    '',
    '  Included by extension:',
  ];

  for (const [ext, count] of Object.entries(preview.includedByExtension)) {
    lines.push(`    ${ext}: ${count.toLocaleString()}`);
  }

  if (preview.topSkippedDirectories.length > 0) {
    lines.push('', '  Top skipped directories:');
    for (const item of preview.topSkippedDirectories) {
      lines.push(`    ${item.path}: ${item.count.toLocaleString()} (${item.reason})`);
    }
  }

  if (preview.largestIncludedFiles.length > 0) {
    lines.push('', '  Largest included files:');
    for (const item of preview.largestIncludedFiles) {
      lines.push(`    ${item.path}: ${item.bytes.toLocaleString()} bytes`);
    }
  }

  if (preview.warnings.length > 0) {
    lines.push('', '  Warnings:');
    for (const warning of preview.warnings) lines.push(`    ${warning}`);
  }

  return lines.join('\n');
}

function formatFileScopeExplanation(
  explanation: Awaited<ReturnType<typeof explainPathScope>>,
): string {
  const lines = [
    `  File scope explanation for ${explanation.filePath}`,
    '',
    `  Included: ${explanation.included ? 'yes' : 'no'}`,
    `  Reason: ${explanation.reason}`,
  ];
  if (explanation.source) lines.push(`  Source: ${explanation.source}`);
  if (explanation.matchedPattern) lines.push(`  Matched: ${explanation.matchedPattern}`);
  if (explanation.suggestedFix) lines.push(`  Suggested fix: ${explanation.suggestedFix}`);
  return lines.join('\n');
}

export async function prepareWorkspaceGraphCommand(
  repoPath: string,
  signal?: AbortSignal,
): Promise<{ snapshot: OverlaySnapshot; reused: boolean; baseCurrent: boolean }> {
  signal?.throwIfAborted();
  if (parseManagedAnalysisContextFromEnv()) {
    throw new Error('--workspace-graph cannot run as a managed analysis job.');
  }
  if (!isAutomaticWorkspaceEnabled()) {
    throw new Error(
      '--workspace-graph requires automatic workspace consumption (ONTOINDEX_AUTO_WORKSPACE=1).',
    );
  }
  const canonicalPath = await fs.realpath(repoPath);
  signal?.throwIfAborted();
  const repo = {
    id: canonicalPath,
    repoPath: canonicalPath,
    storagePath: getStoragePaths(canonicalPath).storagePath,
  };
  // Check before taking the lock so an unindexed repository is not initialized by this command.
  if (!(await readActiveGenerationMeta(repo.storagePath)).meta?.lastCommit) {
    throw new Error(
      '--workspace-graph requires an existing committed base; run ontoindex analyze first.',
    );
  }
  signal?.throwIfAborted();
  const lock = await acquireAnalyzeLock(canonicalPath);
  try {
    signal?.throwIfAborted();
    if (!(await readActiveGenerationMeta(repo.storagePath)).meta?.lastCommit) {
      throw new Error(
        '--workspace-graph requires an existing committed base; run ontoindex analyze first.',
      );
    }
    evictOverlayState(repo.id);
    let snapshot = await getOverlaySnapshot(repo);
    signal?.throwIfAborted();
    const baseCurrent =
      snapshot.dirtyPaths.size === 0 &&
      (snapshot.configPaths?.size ?? 0) === 0 &&
      snapshot.baseMatches === true &&
      !snapshot.headChanged;
    if (baseCurrent) return { snapshot, reused: true, baseCurrent: true };
    const ready = (value: OverlaySnapshot) =>
      value.usable &&
      value.capability === 'workspace-graph' &&
      (value.coverage === 'complete' || value.coverage === 'partial');
    if (ready(snapshot)) return { snapshot, reused: true, baseCurrent: false };
    // Await the supervisor, including cancellation/reaping, before releasing the analyze lock.
    await buildWorkspaceGraph(repo, signal, undefined, true);
    signal?.throwIfAborted();
    evictOverlayState(repo.id);
    snapshot = await getOverlaySnapshot(repo);
    signal?.throwIfAborted();
    if (!ready(snapshot)) {
      throw new Error(
        `Workspace graph verification failed: ${snapshot.reason ?? snapshot.coverage ?? 'full workspace capability missing'}.`,
      );
    }
    return { snapshot, reused: false, baseCurrent: false };
  } finally {
    await lock.release();
  }
}

export const analyzeCommand = async (inputPath?: string, options?: AnalyzeOptions) => {
  if (options?.workspaceGraph) {
    const controller = new AbortController();
    let signalExitCode: number | undefined;
    const interrupt = () => {
      signalExitCode ??= 130;
      controller.abort();
    };
    const terminate = () => {
      signalExitCode ??= 143;
      controller.abort();
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
      const incompatible = [
        'dirtyOverlay',
        'symbolsOnly',
        'indexOnly',
        'hugeRepo',
        'allowHugeRoot',
        'largeRepoSafe',
        'experimentalFileDelta',
        'embeddings',
        'annNeighbors',
        'skills',
        'skillsTarget',
        'name',
        'allowDuplicateName',
        'markdownSidecar',
        'skipGit',
        'dryRun',
        'explainFile',
        'force',
      ] as const;
      const conflict = incompatible.find(
        (key) => options[key] !== undefined && options[key] !== false,
      );
      if (conflict || options.includePath?.length) {
        const flag =
          conflict?.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`) ?? 'include-path';
        throw new Error(`--workspace-graph cannot be combined with --${flag}.`);
      }
      const repoPath = inputPath ? path.resolve(inputPath) : getGitRoot(process.cwd());
      if (!repoPath) throw new Error('--workspace-graph requires a Git repository path.');
      const result = await prepareWorkspaceGraphCommand(repoPath, controller.signal);
      console.log(
        result.baseCurrent
          ? 'Committed base is current; no workspace graph preparation is needed.'
          : `Workspace graph ${result.reused ? 'reused' : 'prepared'}; coverage: ${result.snapshot.coverage}.`,
      );
    } catch (error) {
      console.error(`Workspace graph preparation failed: ${getErrorMessage(error)}`);
      process.exitCode = signalExitCode ?? 1;
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      if (signalExitCode !== undefined) process.exitCode = signalExitCode;
    }
    return;
  }
  const managedAnalysis = parseManagedAnalysisContextFromEnv();
  if (ensureHeap()) return;
  if (options?.allowDuplicateName) {
    throw new Error('--allow-duplicate-name is no longer supported. Use --name <unique-alias>.');
  }

  const largeRepoSafeApplied =
    (options?.largeRepoSafe || options?.hugeRepo) &&
    process.env.ONTOINDEX_LARGE_REPO_SAFE_APPLIED !== undefined
      ? parseLargeRepoSafeAppliedList(process.env.ONTOINDEX_LARGE_REPO_SAFE_APPLIED)
      : applyLargeRepoSafeAnalyzePreset(options);

  if (options?.verbose) {
    process.env.ONTOINDEX_VERBOSE = '1';
  }

  console.log('\n  OntoIndex Analyzer\n');

  if (options?.hugeRepo) {
    console.log(`  ${formatHugeRepoNote()}\n`);
  } else if (options?.indexOnly && !options.symbolsOnly) {
    console.log('  --index-only is deprecated; using --symbols-only behavior.\n');
  }

  if (options?.largeRepoSafe || options?.hugeRepo) {
    console.log(`  ${formatLargeRepoSafeNote(largeRepoSafeApplied, options)}\n`);
  }

  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      if (!options?.skipGit) {
        console.log(
          '  Not inside a git repository.\n  Tip: pass --skip-git to index any folder without a .git directory.\n',
        );
        process.exitCode = 1;
        return;
      }
      // --skip-git: fall back to cwd as the root
      repoPath = path.resolve(process.cwd());
    } else {
      repoPath = gitRoot;
    }
  }

  // A subdir inside a git repo (no own .git) is valid \u2014 git log/rev-parse still work from it.
  const repoHasGit = hasGitDir(repoPath) || getGitRoot(repoPath) !== null;
  if (!repoHasGit && !options?.skipGit) {
    console.log(
      '  Not a git repository.\n  Tip: pass --skip-git to index any folder without a .git directory.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (!repoHasGit) {
    console.log(
      '  Warning: no .git directory found \u2014 commit-tracking and incremental updates disabled.\n',
    );
  }

  let includePaths = resolveAnalyzeIncludePaths(options);

  if (options?.dryRun && options.explainFile) {
    console.error('  Choose either --dry-run or --explain-file, not both.\n');
    process.exitCode = 1;
    return;
  }

  if (options?.dryRun) {
    const preview = await collectFileScopePreview(repoPath, { includePaths });
    console.log(`${formatFileScopePreview(preview, includePaths)}\n`);
    return;
  }

  if (options?.explainFile) {
    const explanation = await explainPathScope(repoPath, options.explainFile);
    console.log(`${formatFileScopeExplanation(explanation)}\n`);
    return;
  }

  let overlayPaths: string[] | undefined;
  if (options?.dirtyOverlay) {
    try {
      const plan = await planDirtyOverlay(repoPath);
      overlayPaths = plan.includePaths;
      includePaths = overlayPaths;
      if (plan.tooMany) {
        console.log(
          `  Dirty overlay covers ${plan.includePaths.length} source file(s); ${plan.uncoveredPaths.length + plan.tombstones.length} dirty source path(s) are not fully covered.\n`,
        );
      }
    } catch (err) {
      console.error(
        `  Dirty overlay planning failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  let experimentalFileDeltaPlan: ExperimentalFileDeltaPlan | null = null;
  const experimentalFileDeltaEligible =
    options?.experimentalFileDelta === true &&
    !options?.dirtyOverlay &&
    !includePaths &&
    options?.embeddings !== true &&
    options?.annNeighbors !== true &&
    options?.skills !== true;

  if (experimentalFileDeltaEligible) {
    experimentalFileDeltaPlan = await planExperimentalFileDeltaRefresh(repoPath);
    console.log(`  ${experimentalFileDeltaPlan.report}\n`);
    if (experimentalFileDeltaPlan.safeToBound) {
      includePaths = experimentalFileDeltaPlan.boundedIncludePaths;
    }
  } else if (options?.experimentalFileDelta && !options?.dirtyOverlay) {
    console.log(
      '  Experimental file-delta refresh is disabled for this run; falling back to full analyze.\n',
    );
  }

  if (options?.hugeRepo && !options.allowHugeRoot && !includePaths) {
    console.error(
      '  --huge-repo requires at least one --include-path, or pass --allow-huge-root explicitly.\n',
    );
    process.exitCode = 1;
    return;
  }

  // KuzuDB migration cleanup is handled by runFullAnalysis internally.
  // Note: --skills is handled after runFullAnalysis using the returned pipelineResult.

  if (process.env.ONTOINDEX_NO_GITIGNORE) {
    console.log(
      '  ONTOINDEX_NO_GITIGNORE is set — skipping .gitignore (still reading .ontoindexignore)\n',
    );
  }

  // ── CLI progress bar setup ─────────────────────────────────────────
  const bar = new cliProgress.SingleBar(
    {
      format: '  {bar} {percentage}% | {phase}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      barGlue: '',
      autopadding: true,
      clearOnComplete: false,
      stopOnComplete: false,
    },
    cliProgress.Presets.shades_grey,
  );

  bar.start(100, 0, { phase: 'Initializing...' });

  // Graceful SIGINT handling
  let aborted = false;
  let analyzeLock: AnalyzeLock | null = null;
  const sigintHandler = () => {
    if (aborted) process.exit(1);
    aborted = true;
    bar.stop();
    console.log('\n  Interrupted — cleaning up...');
    closeLbug()
      .catch(() => {})
      .then(() => analyzeLock?.release())
      .catch(() => {})
      .finally(() => process.exit(130));
  };
  process.on('SIGINT', sigintHandler);

  // Route console output through bar.log() to prevent progress bar corruption
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  let barCurrentValue = 0;
  const barLog = (...args: unknown[]) => {
    process.stdout.write('\x1b[2K\r');
    origLog(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    bar.update(barCurrentValue);
  };
  console.log = barLog;
  console.warn = barLog;
  console.error = barLog;

  // Track elapsed time per phase
  let lastPhaseLabel = 'Initializing...';
  let phaseStart = Date.now();

  const updateBar = (value: number, phaseLabel: string) => {
    barCurrentValue = value;
    if (phaseLabel !== lastPhaseLabel) {
      lastPhaseLabel = phaseLabel;
      phaseStart = Date.now();
    }
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    const display = elapsed >= 3 ? `${phaseLabel} (${elapsed}s)` : phaseLabel;
    bar.update(value, { phase: display });
  };

  const elapsedTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    if (elapsed >= 3) {
      bar.update({ phase: `${lastPhaseLabel} (${elapsed}s)` });
    }
  }, 1000);

  const t0 = Date.now();

  // ── Run shared analysis orchestrator ───────────────────────────────
  try {
    analyzeLock = await acquireAnalyzeLock(repoPath);
    const { runFullAnalysis } = await import('../core/run-analyze.js');
    const profile = experimentalFileDeltaPlan?.safeToBound
      ? 'symbols'
      : resolveAnalyzePipelineProfile(options);
    const result = await runFullAnalysis(
      repoPath,
      {
        // Pipeline re-index — OR'd with --skills because skill generation
        // needs a fresh pipelineResult.
        force:
          managedAnalysis !== undefined ||
          options?.force ||
          options?.skills ||
          experimentalFileDeltaPlan?.forceFullAnalyze,
        embeddings: options?.embeddings,
        annNeighbors: options?.annNeighbors,
        skipGit: options?.skipGit,
        markdownSidecar: options?.markdownSidecar,
        ...(profile ? { profile } : {}),
        ...(includePaths ? { includePaths } : {}),
        skipAgentsMd: experimentalFileDeltaPlan?.safeToBound ? true : options?.skipAgentsMd,
        noStats: experimentalFileDeltaPlan?.safeToBound ? true : options?.noStats,
        skipNativeClose: process.env.ONTOINDEX_ANALYZE_NATIVE_CLOSE !== '1',
        registryName: options?.name,
        ...(options?.dirtyOverlay ? { dirtyOverlay: true, overlayPaths } : {}),
        ...(managedAnalysis ? { managedAnalysis } : {}),
      },
      {
        onProgress: (_phase, percent, message) => {
          updateBar(percent, message);
        },
        onLog: barLog,
      },
    );

    if (options?.dirtyOverlay) {
      clearInterval(elapsedTimer);
      process.removeListener('SIGINT', sigintHandler);
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      bar.stop();
      console.log(
        `\n  Dirty overlay built: ${result.stats.files ?? 0} file(s), ${result.stats.nodes ?? 0} nodes, ${result.stats.edges ?? 0} edges`,
      );
      console.log(`  ${await resolveOverlayDbPath(getStoragePaths(repoPath).storagePath)}`);
      console.log('  Active index unchanged; embeddings and skill generation skipped.\n');
      return;
    }

    console.log(`  ${formatEmbeddingLifecycle(result.embeddingLifecycle)}`);

    if (experimentalFileDeltaPlan?.safeToBound) {
      if (result.alreadyUpToDate) {
        clearInterval(elapsedTimer);
        process.removeListener('SIGINT', sigintHandler);
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
        bar.stop();
        console.log('  Experimental file-delta refresh: no changes to apply\n');
        return;
      }
      const s = result.stats;
      const changedCount = experimentalFileDeltaPlan.changedFiles.length;
      const totalTime = ((Date.now() - t0) / 1000).toFixed(1);

      clearInterval(elapsedTimer);
      process.removeListener('SIGINT', sigintHandler);
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      bar.update(100, { phase: 'Done' });
      bar.stop();

      console.log(`\n  Experimental file-delta refresh completed (${totalTime}s)\n`);
      console.log(
        `  Partial graph coverage only: ${changedCount.toLocaleString()} changed file(s) | ${(
          s.nodes ?? 0
        ).toLocaleString()} nodes | ${(s.edges ?? 0).toLocaleString()} edges | ${
          s.communities ?? 0
        } clusters | ${s.processes ?? 0} flows`,
      );
      console.log(`  ${repoPath}`);
      console.log('');
      return;
    }

    if (result.alreadyUpToDate) {
      clearInterval(elapsedTimer);
      process.removeListener('SIGINT', sigintHandler);
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      bar.stop();
      console.log('  Already up to date\n');
      // Safe to return without process.exit(0) — the early-return path in
      // runFullAnalysis never opens LadybugDB, so no native handles prevent exit.
      return;
    }

    // Skill generation (CLI-only, uses pipeline result from analysis)
    if (options?.skills && result.pipelineResult) {
      updateBar(99, 'Generating skill files...');
      try {
        const { generateSkillFiles, parseSkillTargets } = await import('./skill-gen.js');
        const { generateAIContextFiles } = await import('./ai-context.js');
        const skillResult = await generateSkillFiles(
          repoPath,
          result.repoName,
          result.pipelineResult,
          { targets: parseSkillTargets(options?.skillsTarget) },
        );
        if (skillResult.skills.length > 0) {
          barLog(`  Generated ${skillResult.skills.length} skill files`);
          // Re-generate AI context files now that we have skill info
          const s = result.stats;
          const communityResult = result.pipelineResult?.communityResult;
          let aggregatedClusterCount = 0;
          if (communityResult?.communities) {
            const groups = new Map<string, number>();
            for (const c of communityResult.communities) {
              const label = c.heuristicLabel || c.label || 'Unknown';
              groups.set(label, (groups.get(label) || 0) + c.symbolCount);
            }
            aggregatedClusterCount = Array.from(groups.values()).filter(
              (count: number) => count >= 5,
            ).length;
          }
          const { storagePath: sp } = getStoragePaths(repoPath);
          await generateAIContextFiles(
            repoPath,
            sp,
            result.repoName,
            {
              files: s.files ?? 0,
              nodes: s.nodes ?? 0,
              edges: s.edges ?? 0,
              communities: s.communities,
              clusters: aggregatedClusterCount,
              processes: s.processes,
            },
            skillResult.skills,
            { skipAgentsMd: options?.skipAgentsMd, noStats: options?.noStats },
          );
        }
      } catch {
        /* best-effort */
      }
    }

    const totalTime = ((Date.now() - t0) / 1000).toFixed(1);

    clearInterval(elapsedTimer);
    process.removeListener('SIGINT', sigintHandler);

    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;

    bar.update(100, { phase: 'Done' });
    bar.stop();

    // ── Summary ────────────────────────────────────────────────────
    const s = result.stats;
    console.log(`\n  Repository indexed successfully (${totalTime}s)\n`);
    console.log(
      `  ${(s.nodes ?? 0).toLocaleString()} nodes | ${(s.edges ?? 0).toLocaleString()} edges | ${s.communities ?? 0} clusters | ${s.processes ?? 0} flows`,
    );
    console.log(`  ${repoPath}`);

    try {
      await fs.access(getGlobalRegistryPath());
    } catch {
      console.log('\n  Tip: Run `ontoindex setup` to configure MCP for your editor.');
    }

    console.log('');
  } catch (err: unknown) {
    clearInterval(elapsedTimer);
    process.removeListener('SIGINT', sigintHandler);
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    bar.stop();

    const msg = getErrorMessage(err);

    // Registry name-collision from --name (#829) — surface as an
    // actionable error rather than a generic stack-trace.
    if (err instanceof RegistryNameCollisionError) {
      console.error(`\n  Registry name collision:\n`);
      console.error(`    "${err.registryName}" is already used by "${err.existingPath}".\n`);
      console.error(`  Options:`);
      console.error(`    • Pick a different alias:  ontoindex analyze --name <unique-alias>`);
      console.error('');
      process.exitCode = 1;
      return;
    }

    console.error(`\n  Analysis failed: ${msg}\n`);

    // Provide helpful guidance for known failure modes
    if (
      msg.includes('Maximum call stack size exceeded') ||
      msg.includes('call stack') ||
      msg.includes('Map maximum size') ||
      msg.includes('Invalid array length') ||
      msg.includes('Invalid string length') ||
      msg.includes('allocation failed') ||
      msg.includes('heap out of memory') ||
      msg.includes('JavaScript heap')
    ) {
      console.error('  This error typically occurs on very large repositories.');
      console.error('  Suggestions:');
      console.error('    1. Add large vendored/generated directories to .ontoindexignore');
      console.error('    2. Increase Node.js heap: NODE_OPTIONS="--max-old-space-size=16384"');
      console.error('    3. Increase stack size: NODE_OPTIONS="--stack-size=4096"');
      console.error('');
    } else if (msg.includes('ERESOLVE') || msg.includes('Could not resolve dependency')) {
      // Note: the original arborist "Cannot destructure property 'package' of
      // 'node.target'" crash happens inside npm *before* ontoindex code runs,
      // so it can't be caught here.  This branch handles dependency-resolution
      // errors that surface at runtime (e.g. dynamic require failures).
      console.error('  This looks like an npm dependency resolution issue.');
      console.error('  Suggestions:');
      console.error('    1. Clear the npm cache:    npm cache clean --force');
      console.error('    2. Update npm:             npm install -g npm@latest');
      console.error('    3. Reinstall ontoindex:     npm install -g ontoindex@latest');
      console.error('    4. Or try npx directly:    npx ontoindex@latest analyze');
      console.error('');
    } else if (
      msg.includes('MODULE_NOT_FOUND') ||
      msg.includes('Cannot find module') ||
      msg.includes('ERR_MODULE_NOT_FOUND')
    ) {
      console.error('  A required module could not be loaded. The installation may be corrupt.');
      console.error('  Suggestions:');
      console.error('    1. Reinstall:   npm install -g ontoindex@latest');
      console.error('    2. Clear cache: npm cache clean --force && npx ontoindex@latest analyze');
      console.error('');
    }

    process.exitCode = 1;
    return;
  } finally {
    await analyzeLock?.release();
  }

  // LadybugDB's native module holds open handles that prevent Node from exiting.
  // ONNX Runtime also registers native atexit hooks that segfault on some
  // platforms (#38, #40). Force-exit to ensure clean termination.
  process.exit(0);
};
