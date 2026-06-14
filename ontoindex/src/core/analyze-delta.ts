import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileText } from './process/exec-file.js';
import { getCurrentCommit } from '../storage/git.js';
import { getStoragePaths, loadMeta } from '../storage/repo-manager.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const MAX_CHANGED_FILES_FOR_BOUNDED_REFRESH = 50;

const SOURCE_FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.cts',
  '.mts',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.cs',
  '.php',
  '.rb',
  '.dart',
  '.lua',
  '.sh',
  '.sql',
]);

const IMPORT_EXPORT_PATTERN = /(^|\n)\s*(?:import|export)\s+(?:type\s+)?/m;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(/m;

interface NameStatusEntry {
  status: string;
  paths: string[];
}

export interface ExperimentalFileDeltaPlan {
  baselineCommit: string | null;
  currentCommit: string | null;
  changedFiles: string[];
  boundedIncludePaths: string[];
  safeToBound: boolean;
  forceFullAnalyze: boolean;
  unsafeReasons: string[];
  report: string;
}

function isSourceFilePath(filePath: string): boolean {
  return SOURCE_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function formatChangedFiles(changedFiles: readonly string[], limit = 5): string {
  if (changedFiles.length === 0) return 'none';
  const visible = changedFiles.slice(0, limit);
  const suffix =
    changedFiles.length > visible.length ? `, +${changedFiles.length - visible.length} more` : '';
  return `${visible.join(', ')}${suffix}`;
}

function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const status = parts[0] ?? '';
    const paths = parts.slice(1).filter(Boolean);
    if (status.length === 0 || paths.length === 0) continue;
    entries.push({ status, paths });
  }

  return entries;
}

function parsePorcelainChangedFiles(output: string): string[] {
  const files: string[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const rawPath = trimmed.slice(3);
    const pathText = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) || rawPath : rawPath;
    files.push(pathText);
  }

  return [...new Set(files)].sort();
}

async function readFileMaybe(repoPath: string, relativePath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(repoPath, relativePath), 'utf8');
  } catch {
    return null;
  }
}

async function inspectCommittedDiff(
  repoPath: string,
  baselineCommit: string,
  currentCommit: string,
): Promise<{
  changedFiles: string[];
  boundedIncludePaths: string[];
  unsafeReasons: string[];
}> {
  const unsafeReasons: string[] = [];
  const changedFiles = new Set<string>();
  const boundedIncludePaths = new Set<string>();

  let diffOutput = '';
  try {
    diffOutput = await execFileText(
      'git',
      [
        'diff',
        '--name-status',
        '--find-renames',
        '--find-copies',
        `${baselineCommit}..${currentCommit}`,
      ],
      { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
    );
  } catch (error) {
    unsafeReasons.push(
      `unable to read git diff: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { changedFiles: [], boundedIncludePaths: [], unsafeReasons };
  }

  for (const entry of parseNameStatus(diffOutput)) {
    const status = entry.status;
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
    const primaryPath = entry.paths.at(-1) ?? entry.paths[0];
    const secondaryPath = entry.paths[0];

    if (secondaryPath) {
      changedFiles.add(secondaryPath);
    }
    if (primaryPath) {
      changedFiles.add(primaryPath);
    }

    if (status.startsWith('D')) {
      unsafeReasons.push(`deleted file: ${secondaryPath ?? primaryPath ?? '(unknown)'}`);
      continue;
    }
    if (isRenameOrCopy) {
      unsafeReasons.push(
        `renamed/copied file: ${secondaryPath ?? '(unknown)'} -> ${primaryPath ?? '(unknown)'}`,
      );
      continue;
    }
    if (!['A', 'M', 'T'].includes(status[0] ?? '')) {
      unsafeReasons.push(`unsupported diff status ${status} for ${primaryPath ?? '(unknown)'}`);
      continue;
    }

    if (!primaryPath || !isSourceFilePath(primaryPath)) {
      continue;
    }

    const content = await readFileMaybe(repoPath, primaryPath);
    if (content === null) {
      unsafeReasons.push(`changed source file could not be read: ${primaryPath}`);
      continue;
    }

    if (IMPORT_EXPORT_PATTERN.test(content) || DYNAMIC_IMPORT_PATTERN.test(content)) {
      unsafeReasons.push(`imports/exports detected in ${primaryPath}`);
      continue;
    }

    boundedIncludePaths.add(primaryPath);
  }

  return {
    changedFiles: [...changedFiles].sort(),
    boundedIncludePaths: [...boundedIncludePaths].sort(),
    unsafeReasons,
  };
}

export async function planExperimentalFileDeltaRefresh(
  repoPath: string,
): Promise<ExperimentalFileDeltaPlan> {
  const { storagePath } = getStoragePaths(repoPath);
  const meta = await loadMeta(storagePath);
  const baselineCommit = meta?.lastCommit?.trim() || null;
  const currentCommit = getCurrentCommit(repoPath) || null;
  const unsafeReasons: string[] = [];
  let changedFiles: string[] = [];
  let boundedIncludePaths: string[] = [];
  let forceFullAnalyze = false;

  if (!baselineCommit) {
    unsafeReasons.push('no previous analyze baseline is available');
  }
  if (!currentCommit) {
    unsafeReasons.push('repository does not have a readable HEAD commit');
  }

  let dirtyFiles: string[] = [];
  try {
    const statusOutput = await execFileText(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
    );
    dirtyFiles = parsePorcelainChangedFiles(statusOutput);
    if (dirtyFiles.length > 0) {
      unsafeReasons.push('working tree has uncommitted or untracked changes');
      forceFullAnalyze = true;
      changedFiles = dirtyFiles;
    }
  } catch (error) {
    unsafeReasons.push(
      `unable to inspect git status: ${error instanceof Error ? error.message : String(error)}`,
    );
    forceFullAnalyze = true;
  }

  if (
    dirtyFiles.length === 0 &&
    baselineCommit &&
    currentCommit &&
    baselineCommit !== currentCommit
  ) {
    const diffResult = await inspectCommittedDiff(repoPath, baselineCommit, currentCommit);
    changedFiles = diffResult.changedFiles;
    boundedIncludePaths = diffResult.boundedIncludePaths;
    unsafeReasons.push(...diffResult.unsafeReasons);
  }

  if (changedFiles.length > MAX_CHANGED_FILES_FOR_BOUNDED_REFRESH) {
    unsafeReasons.push(
      `too many changed files for bounded refresh (${changedFiles.length} > ${MAX_CHANGED_FILES_FOR_BOUNDED_REFRESH})`,
    );
  }

  const uniqueUnsafeReasons = [...new Set(unsafeReasons)];
  const safeToBound =
    uniqueUnsafeReasons.length === 0 && changedFiles.length > 0 && boundedIncludePaths.length > 0;

  const report = safeToBound
    ? `Experimental file-delta refresh can use bounded symbols-only analysis over ${boundedIncludePaths.length} changed file(s): ${formatChangedFiles(boundedIncludePaths)}. Graph coverage is partial.`
    : uniqueUnsafeReasons.length > 0
      ? `Experimental file-delta refresh is unsafe; falling back to full analyze. Reasons: ${uniqueUnsafeReasons.join('; ')}. Changed files: ${formatChangedFiles(changedFiles)}.`
      : `Experimental file-delta refresh found no eligible changed source files; falling back to full analyze. Changed files: ${formatChangedFiles(changedFiles)}.`;

  return {
    baselineCommit,
    currentCommit,
    changedFiles,
    boundedIncludePaths: safeToBound ? boundedIncludePaths : [],
    safeToBound,
    forceFullAnalyze,
    unsafeReasons: uniqueUnsafeReasons,
    report,
  };
}
