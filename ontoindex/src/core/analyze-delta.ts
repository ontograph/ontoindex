import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { globStream } from 'glob';
import { execFileText } from './process/exec-file.js';
import { createIgnoreFilter, loadIgnoreRules, shouldIgnorePath } from '../config/ignore-service.js';
import { getCurrentCommit } from '../storage/git.js';
import { getStoragePaths, loadMeta, readActiveGenerationMeta } from '../storage/repo-manager.js';
import { getScanMaxFileSizeBytes } from './ingestion/scan-config.js';
import {
  computeSourceManifest,
  workspaceIgnorePolicyDigest,
  workspaceConfigurationDigest,
  manifestsMatch,
  sourceManifestDigest,
  type CapturedSourceEntry,
  type IndexSourceManifest,
} from './indexing/source-manifest.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const MAX_CHANGED_FILES_FOR_BOUNDED_REFRESH = 50;
const OVERLAY_SIZE_STAT_CONCURRENCY = 16;

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

export interface DirtyOverlayPlan {
  includePaths: string[];
  uncoveredPaths: string[];
  allDirtyPaths: string[];
  tombstones: string[];
  tooMany: boolean;
  skipped: string[];
}

function decodePorcelainPath(value: string): string {
  if (!value.startsWith('"')) return value;

  const bytes: number[] = [];
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '"') break;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      continue;
    }

    const escaped = value[++index];
    const namedEscapes: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '\\': 0x5c,
      '"': 0x22,
    };
    if (escaped && escaped in namedEscapes) {
      bytes.push(namedEscapes[escaped]!);
    } else if (escaped && /[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(value[index + 1] ?? '')) {
        octal += value[++index];
      }
      bytes.push(Number.parseInt(octal, 8));
    } else if (escaped) {
      bytes.push(...Buffer.from(escaped));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseDirtyOverlayStatus(output: string): Array<{ status: string; paths: string[] }> {
  const entries: Array<{ status: string; paths: string[] }> = [];
  for (const line of output.split('\n')) {
    if (!line || line.length < 4) continue;
    const status = line.slice(0, 2);
    const rawPath = line.slice(3);
    let renameSeparator = -1;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < rawPath.length - 3; index += 1) {
      const char = rawPath[index]!;
      if (escaped) {
        escaped = false;
      } else if (quoted && char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (!quoted && rawPath.startsWith(' -> ', index)) {
        renameSeparator = index;
        break;
      }
    }

    const paths =
      renameSeparator < 0
        ? [decodePorcelainPath(rawPath)]
        : [
            decodePorcelainPath(rawPath.slice(0, renameSeparator)),
            decodePorcelainPath(rawPath.slice(renameSeparator + 4)),
          ];
    entries.push({ status, paths });
  }
  return entries;
}

export async function planDirtyOverlay(repoPath: string): Promise<DirtyOverlayPlan> {
  const includePaths = new Set<string>();
  const tombstones = new Set<string>();
  const skipped = new Set<string>();
  const ignoreRules = await loadIgnoreRules(repoPath);
  const isIgnored = (filePath: string): boolean =>
    shouldIgnorePath(filePath) || (ignoreRules?.ignores(filePath) ?? false);

  const statusOutput = await execFileText(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
  );

  for (const { status, paths } of parseDirtyOverlayStatus(statusOutput)) {
    const [oldPath, newPath] = paths;
    if (!oldPath) continue;

    if (paths.length > 1) {
      if (!isSourceFilePath(oldPath) || isIgnored(oldPath)) skipped.add(oldPath);
      else tombstones.add(oldPath);
      if (newPath && isSourceFilePath(newPath) && !isIgnored(newPath)) {
        includePaths.add(newPath);
      } else if (newPath) {
        skipped.add(newPath);
      }
      continue;
    }

    if (!isSourceFilePath(oldPath) || isIgnored(oldPath)) {
      skipped.add(oldPath);
    } else if (status.includes('D')) {
      tombstones.add(oldPath);
    } else if (
      status.includes('M') ||
      status.includes('A') ||
      status.includes('?') ||
      status.includes('T') ||
      status.includes('U')
    ) {
      includePaths.add(oldPath);
    } else {
      skipped.add(oldPath);
    }
  }

  const maxFileSizeBytes = getScanMaxFileSizeBytes();
  if (maxFileSizeBytes !== null) {
    const candidates = [...includePaths];
    for (let offset = 0; offset < candidates.length; offset += OVERLAY_SIZE_STAT_CONCURRENCY) {
      const batch = candidates.slice(offset, offset + OVERLAY_SIZE_STAT_CONCURRENCY);
      await Promise.all(
        batch.map(async (filePath) => {
          try {
            const stat = await fs.stat(path.join(repoPath, filePath));
            if (stat.size > maxFileSizeBytes) {
              includePaths.delete(filePath);
              skipped.add(filePath);
            }
          } catch {
            // A missing or unreadable path may still be an overlay candidate; retain it fail-open.
          }
        }),
      );
    }
  }

  const allDirtyPaths = [...new Set([...includePaths, ...tombstones])].sort();
  const tooMany = allDirtyPaths.length > MAX_CHANGED_FILES_FOR_BOUNDED_REFRESH;
  let plannedIncludePaths = [...includePaths].sort();
  let uncoveredPaths: string[] = [];
  if (tooMany) {
    const newestFirst = await Promise.all(
      [...includePaths].map(async (filePath) => {
        try {
          return { filePath, mtimeMs: (await fs.stat(path.join(repoPath, filePath))).mtimeMs };
        } catch {
          return { filePath, mtimeMs: null };
        }
      }),
    );
    newestFirst.sort((a, b) => {
      if (a.mtimeMs === null && b.mtimeMs !== null) return 1;
      if (a.mtimeMs !== null && b.mtimeMs === null) return -1;
      return (
        (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) ||
        (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0)
      );
    });
    plannedIncludePaths = newestFirst
      .slice(0, MAX_CHANGED_FILES_FOR_BOUNDED_REFRESH)
      .map(({ filePath }) => filePath);
    const covered = new Set(plannedIncludePaths);
    uncoveredPaths = [...includePaths].filter((filePath) => !covered.has(filePath)).sort();
  }
  return {
    includePaths: plannedIncludePaths,
    uncoveredPaths,
    allDirtyPaths,
    tombstones: [...tombstones].sort(),
    tooMany,
    skipped: [...skipped].sort(),
  };
}

export type WorkspaceInputCaptureCode =
  | 'cancelled'
  | 'timeout'
  | 'changed-input'
  | 'limit'
  | 'unsupported';

export class WorkspaceInputCaptureError extends Error {
  constructor(
    readonly code: WorkspaceInputCaptureCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceInputCaptureError';
  }
}

export interface WorkspaceInputCaptureOptions {
  signal?: AbortSignal;
  /** Absolute performance.now() deadline, capped at 60 seconds from admission. */
  deadline?: number;
  parserIdentity?: string;
  /** Restrict captured source to these repo-relative files; configuration files are always captured. */
  includePaths?: readonly string[];
  maxFiles?: number;
  maxTotalBytes?: number;
  hooks?: {
    beforeRead?: (relativePath: string, attempt: number) => void | Promise<void>;
    afterCopy?: (context: { attempt: number; captureRoot: string }) => void | Promise<void>;
    beforeVerify?: (context: { attempt: number; captureRoot: string }) => void | Promise<void>;
  };
}

export interface WorkspaceInputCapture {
  canonicalRepoPath: string;
  captureRoot: string;
  manifest: IndexSourceManifest;
  manifestDigest: string;
  baseGenerationId: string | null;
  baseCommit: string | null;
  head: string | null;
  parserIdentity: string;
  configurationDigest: string;
  capturedPaths: string[];
  tombstones: string[];
  totalBytes: number;
  dispose(): Promise<void>;
}

export const CAPTURE_CONFIGURATION =
  /^(?:\.gitignore|\.ontoindexignore|(?:ts|js)config(?:\.[^.]+)*\.json|package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-workspace\.yaml|go\.(?:mod|sum|work)|composer\.(?:json|lock)|Cargo\.(?:toml|lock)|pyproject\.toml|setup\.(?:cfg|py)|Package\.swift|.*\.csproj)$/;

function captureInputPath(root: string, relativePath: string): string {
  if (
    !relativePath ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath) ||
    relativePath
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part === '.git')
  ) {
    throw new WorkspaceInputCaptureError(
      'unsupported',
      `Workspace input path is not repository-relative: ${relativePath}`,
    );
  }
  return path.join(root, relativePath);
}

async function checkCapturePath(root: string, relativePath: string): Promise<void> {
  captureInputPath(root, relativePath);
  const components = relativePath.split('/');
  let current = root;
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory())) {
      throw new WorkspaceInputCaptureError(
        'unsupported',
        `Workspace capture rejects symlinks and non-directory ancestors: ${relativePath}`,
      );
    }
  }
  if ((await fs.realpath(path.dirname(current))) !== path.dirname(current)) {
    throw new WorkspaceInputCaptureError(
      'unsupported',
      `Workspace input escapes its canonical root: ${relativePath}`,
    );
  }
}

/** Category-specific resolver root validation for workspace capture. */
function checkResolverConfiguration(relativePath: string, content: Buffer): void {
  if (!/^(?:ts|js)config.*\.json$/.test(path.basename(relativePath))) return;
  let config;
  try {
    const source = content.toString('utf8');
    let json = '';
    let quoted = false;
    let pendingComma = false;
    let previousToken = '';
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        json += char;
        if (char === '\\') json += source[++index] ?? '';
        else if (char === '"') {
          quoted = false;
          previousToken = '"';
        }
        continue;
      }
      if (char === '/' && source[index + 1] === '/') {
        while (
          index + 1 < source.length &&
          source[index + 1] !== '\r' &&
          source[index + 1] !== '\n'
        )
          index++;
        json += ' ';
        continue;
      }
      if (char === '/' && source[index + 1] === '*') {
        const end = source.indexOf('*/', index + 2);
        if (end === -1) throw new Error('Unterminated JSONC comment');
        index = end + 1;
        json += ' ';
        continue;
      }
      if (!char.trim()) {
        json += char;
        continue;
      }
      // Defer a separator so only a comma after a value can become trailing.
      if (pendingComma) {
        if (char !== ']' && char !== '}') json += ',';
        pendingComma = false;
      }
      if (char === ',' && previousToken && !'{[:,'.includes(previousToken)) pendingComma = true;
      else json += char;
      previousToken = char;
      if (char === '"') quoted = true;
    }
    config = JSON.parse(json + (pendingComma ? ',' : ''));
  } catch {
    throw new WorkspaceInputCaptureError(
      'unsupported',
      `Cannot verify resolver roots in ${relativePath}; use a supported JSON configuration`,
    );
  }
  const invalid = (): never => {
    throw new WorkspaceInputCaptureError(
      'unsupported',
      `Cannot verify resolver roots in ${relativePath}; use a supported JSON configuration`,
    );
  };
  const record = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
  };
  const strings = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return invalid();
    return value;
  };
  const directory = path.posix.dirname(relativePath);
  const checkRoot = (root: unknown, base = directory): void => {
    if (typeof root !== 'string') return invalid();
    if (
      path.posix.isAbsolute(root) ||
      path.win32.isAbsolute(root) ||
      root.includes('\\') ||
      path.posix.normalize(path.posix.join(base, root)).split('/').includes('..')
    ) {
      throw new WorkspaceInputCaptureError(
        'unsupported',
        `Resolver root in ${relativePath} requires external inputs: ${root}`,
      );
    }
  };
  const configuration = record(config);
  const options =
    configuration.compilerOptions === undefined ? {} : record(configuration.compilerOptions);
  if (options.baseUrl !== undefined) checkRoot(options.baseUrl);
  for (const field of ['rootDirs', 'typeRoots']) {
    if (options[field] !== undefined) {
      for (const root of strings(options[field])) checkRoot(root);
    }
  }
  if (options.paths !== undefined) {
    const baseUrl = options.baseUrl === undefined ? '.' : (options.baseUrl as string);
    const base = path.posix.join(directory, baseUrl);
    for (const substitutions of Object.values(record(options.paths))) {
      for (const root of strings(substitutions)) checkRoot(root, base);
    }
  }
  if (configuration.extends !== undefined) {
    const roots =
      typeof configuration.extends === 'string'
        ? [configuration.extends]
        : strings(configuration.extends);
    for (const root of roots) checkRoot(root);
  }
  if (configuration.references !== undefined) {
    if (!Array.isArray(configuration.references)) return invalid();
    for (const reference of configuration.references) checkRoot(record(reference).path);
  }
}

async function workspaceConfigurationPaths(
  root: string,
  includePaths: readonly string[] | undefined,
  check: () => void,
  maxFiles: number,
  maxTotalBytes: number,
): Promise<string[]> {
  if (includePaths) {
    const directories = new Set<string>(['.']);
    for (const relativePath of includePaths) {
      captureInputPath(root, relativePath);
      let directory = path.posix.dirname(relativePath);
      while (directory !== '.') {
        directories.add(directory);
        directory = path.posix.dirname(directory);
      }
    }
    // loadCSharpProjectConfig scans .csproj files breadth-first from the root (depth 5, 100
    // directories), so those directories are resolver inputs even when off the include chain.
    const queue: { directory: string; depth: number }[] = [{ directory: '.', depth: 0 }];
    for (let scanned = 0; queue.length > 0 && scanned < 100; scanned++) {
      check();
      const { directory, depth } = queue.shift()!;
      directories.add(directory);
      if (depth >= 5) continue;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          ['node_modules', '.git', 'bin', 'obj', '.ontoindex'].includes(entry.name)
        )
          continue;
        queue.push({
          directory: directory === '.' ? entry.name : `${directory}/${entry.name}`,
          depth: depth + 1,
        });
      }
    }
    const paths: string[] = [];
    let bytes = 0;
    for (const directory of [...directories].sort()) {
      check();
      if (directory !== '.') await checkCapturePath(root, directory);
      for (const name of await fs.readdir(path.join(root, directory))) {
        check();
        if (!CAPTURE_CONFIGURATION.test(name)) continue;
        const relativePath = directory === '.' ? name : `${directory}/${name}`;
        await checkCapturePath(root, relativePath);
        const stat = await fs.lstat(captureInputPath(root, relativePath));
        if (!stat.isFile())
          throw new WorkspaceInputCaptureError(
            'unsupported',
            `Workspace capture requires regular input: ${relativePath}`,
          );
        bytes += stat.size;
        if (
          paths.length >= maxFiles ||
          bytes > maxTotalBytes ||
          (getScanMaxFileSizeBytes() !== null && stat.size > getScanMaxFileSizeBytes()!)
        ) {
          throw new WorkspaceInputCaptureError(
            'limit',
            `Workspace input limit exceeded at ${relativePath}`,
          );
        }
        paths.push(relativePath);
      }
    }
    return paths.sort();
  }
  const ignore = await createIgnoreFilter(root);
  const paths: string[] = [];
  let files = 0;
  let bytes = 0;
  // The canonical walker owns eligibility; this pass only rejects unsafe inputs
  // and adds configuration files that its built-in filename policy excludes.
  const filter = {
    childrenIgnored: ignore.childrenIgnored,
    ignored: (entry: Parameters<typeof ignore.ignored>[0]) =>
      CAPTURE_CONFIGURATION.test(entry.name) ? false : ignore.ignored(entry),
  };
  for await (const entry of globStream('**/*', {
    cwd: root,
    dot: true,
    nodir: false,
    ignore: filter,
  })) {
    check();
    const relativePath = String(entry);
    await checkCapturePath(root, relativePath);
    const stat = await fs.lstat(captureInputPath(root, relativePath));
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new WorkspaceInputCaptureError(
        'unsupported',
        `Workspace capture requires regular input: ${relativePath}`,
      );
    }
    if (stat.isFile()) {
      bytes += stat.size;
      if (
        ++files > maxFiles ||
        bytes > maxTotalBytes ||
        (getScanMaxFileSizeBytes() !== null && stat.size > getScanMaxFileSizeBytes()!)
      ) {
        throw new WorkspaceInputCaptureError(
          'limit',
          `Workspace input limit exceeded at ${relativePath}`,
        );
      }
    }
    if (stat.isFile() && CAPTURE_CONFIGURATION.test(path.basename(relativePath)))
      paths.push(relativePath);
  }
  return paths.sort();
}

async function workspaceParserIdentity(): Promise<string> {
  const files = [
    new URL('../../package.json', import.meta.url),
    new URL(
      `./tree-sitter/parser-loader${path.extname(fileURLToPath(import.meta.url))}`,
      import.meta.url,
    ),
  ];
  return createHash('sha256')
    .update(
      JSON.stringify(
        await Promise.all(files.map(async (file) => (await fs.readFile(file)).toString('utf8'))),
      ),
    )
    .digest('hex');
}

export async function workspaceConfigurationIdentity(
  repoPath: string,
  options: { includePaths?: readonly string[]; signal?: AbortSignal } = {},
): Promise<{ configurationDigest: string; parserIdentity: string }> {
  const check = () => {
    if (options.signal?.aborted)
      throw new WorkspaceInputCaptureError('cancelled', 'Workspace input capture was cancelled');
  };
  check();
  const root = await fs.realpath(repoPath);
  const configs = await workspaceConfigurationPaths(
    root,
    options.includePaths,
    check,
    100_000,
    512 * 1024 * 1024,
  );
  const entries: CapturedSourceEntry[] = [];
  let bytes = 0;
  for (const relativePath of configs) {
    check();
    await checkCapturePath(root, relativePath);
    const handle = await fs.open(
      captureInputPath(root, relativePath),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !(stat.mode & 0o444))
        throw new WorkspaceInputCaptureError(
          'unsupported',
          `Workspace input is not a readable regular file: ${relativePath}`,
        );
      const fileCap = Math.min(
        getScanMaxFileSizeBytes() ?? 512 * 1024 * 1024,
        512 * 1024 * 1024 - bytes,
      );
      if (stat.size > fileCap)
        throw new WorkspaceInputCaptureError(
          'limit',
          `Workspace input limit exceeded at ${relativePath}`,
        );
      const content = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < content.length) {
        check();
        const result = await handle.read(content, length, content.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length !== stat.size)
        throw new WorkspaceInputCaptureError(
          'changed-input',
          `Workspace input changed during read: ${relativePath}`,
        );
      bytes += length;
      await checkCapturePath(root, relativePath);
      const value = content.subarray(0, length);
      checkResolverConfiguration(relativePath, value);
      entries.push({
        path: relativePath,
        byteLength: length,
        digest: createHash('sha256').update(value).digest('hex'),
        executable: Boolean(stat.mode & 0o111),
      });
    } finally {
      await handle.close();
    }
  }
  const configurationDigest = workspaceConfigurationDigest(
    entries,
    await workspaceIgnorePolicyDigest(root),
  );
  const parserIdentity = await workspaceParserIdentity();
  check();
  return { configurationDigest, parserIdentity };
}

/** Materialize and verify working-file bytes; never use stat timestamps as identity. */
export async function captureWorkspaceInputs(
  repoPath: string,
  options: WorkspaceInputCaptureOptions = {},
): Promise<WorkspaceInputCapture> {
  const deadline = Math.min(options.deadline ?? Infinity, performance.now() + 60_000);
  const check = () => {
    if (options.signal?.aborted)
      throw new WorkspaceInputCaptureError('cancelled', 'Workspace input capture was cancelled');
    if (!Number.isFinite(deadline) || performance.now() >= deadline) {
      throw new WorkspaceInputCaptureError(
        'timeout',
        'Workspace input capture exceeded its request deadline; retry the request',
      );
    }
  };
  check();
  const canonicalRepoPath = await fs.realpath(repoPath);
  const maxFiles = Math.min(options.maxFiles ?? 100_000, 100_000);
  const maxTotalBytes = Math.min(options.maxTotalBytes ?? 512 * 1024 * 1024, 512 * 1024 * 1024);
  if (
    !Number.isInteger(maxFiles) ||
    maxFiles < 0 ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes < 0
  ) {
    throw new WorkspaceInputCaptureError(
      'limit',
      'Workspace input limits must be non-negative integers',
    );
  }
  const parserIdentity = options.parserIdentity ?? (await workspaceParserIdentity());
  const { storagePath } = getStoragePaths(canonicalRepoPath);
  const captureParent = path.join(storagePath, 'workspace-inputs');
  // Check each existing ancestor before creating anything under the source root.
  for (const relativePath of ['.ontoindex', '.ontoindex/workspace-inputs']) {
    try {
      await checkCapturePath(canonicalRepoPath, relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs
      .mkdir(path.join(canonicalRepoPath, relativePath), { mode: 0o700 })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
  }

  const assertIgnoreFilesRegular = async () => {
    for (const filename of ['.gitignore', '.ontoindexignore']) {
      try {
        await checkCapturePath(canonicalRepoPath, filename);
        const stat = await fs.lstat(captureInputPath(canonicalRepoPath, filename));
        if (!stat.isFile()) {
          throw new WorkspaceInputCaptureError(
            'unsupported',
            `Workspace ignore file is not a regular file: ${filename}`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  };
  await assertIgnoreFilesRegular();

  const identity = async () => {
    check();
    // A pointer that moves during the read is a real race: fail closed. Other untrusted
    // pairs keep the owner's tolerant behavior, with authority recorded in the identity.
    const active = await readActiveGenerationMeta(storagePath);
    if (active.reason === 'active-generation-changed-during-read') {
      throw new WorkspaceInputCaptureError(
        'changed-input',
        'Active index generation changed during the identity read',
      );
    }
    const meta = active.meta ?? (await loadMeta(storagePath));
    return {
      head: getCurrentCommit(canonicalRepoPath) || null,
      baseCommit: meta?.lastCommit || null,
      baseGenerationId: active.activeGeneration?.generationId ?? meta?.generationId ?? null,
      baseAuthority: `${active.authority}:${active.reason ?? ''}`,
    };
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    check();
    const captureRoot = await fs.mkdtemp(path.join(captureParent, 'capture-'));
    const owned = await fs.lstat(captureRoot);
    let disposing: Promise<void> | undefined;
    const dispose = () =>
      (disposing ??= (async () => {
        const current = await fs.lstat(captureRoot).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (!current) return;
        if (
          current.isSymbolicLink() ||
          !current.isDirectory() ||
          current.dev !== owned.dev ||
          current.ino !== owned.ino ||
          (await fs.realpath(captureRoot)) !== captureRoot
        ) {
          throw new WorkspaceInputCaptureError(
            'unsupported',
            `Cannot safely dispose changed workspace capture: ${captureRoot}`,
          );
        }
        await fs.rm(captureRoot, { recursive: true, force: true });
      })());
    try {
      await fs.chmod(captureRoot, 0o700);
      const before = await identity();
      let totalBytes = 0;
      const readManifest = async (
        root: string,
        copy: boolean,
        executableEntries?: Map<string, CapturedSourceEntry>,
      ) => {
        const configs = await workspaceConfigurationPaths(
          root,
          options.includePaths,
          check,
          maxFiles,
          maxTotalBytes,
        );
        let files = 0;
        let bytes = 0;
        return computeSourceManifest(root, {
          ...(options.includePaths ? { includePaths: options.includePaths } : {}),
          capture: {
            parserIdentity,
            configurationPaths: configs,
            check,
            read: async (relativePath) => {
              check();
              await options.hooks?.beforeRead?.(relativePath, attempt);
              await checkCapturePath(root, relativePath);
              const handle = await fs.open(
                captureInputPath(root, relativePath),
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              );
              try {
                const stat = await handle.stat();
                if (!stat.isFile() || !(stat.mode & 0o444)) {
                  throw new WorkspaceInputCaptureError(
                    'unsupported',
                    `Workspace input is not a readable regular file: ${relativePath}`,
                  );
                }
                const fileCap = Math.min(
                  getScanMaxFileSizeBytes() ?? maxTotalBytes,
                  maxTotalBytes - bytes,
                );
                if (++files > maxFiles || stat.size > fileCap) {
                  throw new WorkspaceInputCaptureError(
                    'limit',
                    `Workspace input limit exceeded at ${relativePath}`,
                  );
                }
                const content = Buffer.alloc(stat.size + 1);
                let length = 0;
                while (length < content.length) {
                  check();
                  const result = await handle.read(content, length, content.length - length, null);
                  if (result.bytesRead === 0) break;
                  length += result.bytesRead;
                }
                if (length !== stat.size)
                  throw new WorkspaceInputCaptureError(
                    'changed-input',
                    `Workspace input changed during read: ${relativePath}`,
                  );
                bytes += length;
                await checkCapturePath(root, relativePath);
                const value = content.subarray(0, length);
                if (configs.includes(relativePath)) checkResolverConfiguration(relativePath, value);
                return {
                  content: value,
                  executable:
                    executableEntries?.get(relativePath)?.executable ?? Boolean(stat.mode & 0o111),
                };
              } finally {
                await handle.close();
              }
            },
            onEntry: copy
              ? async (entry, content) => {
                  const target = captureInputPath(captureRoot, entry.path);
                  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
                  await fs.writeFile(target, content, { mode: 0o600, flag: 'wx' });
                  totalBytes += content.length;
                }
              : undefined,
          },
        });
      };
      await assertIgnoreFilesRegular();
      const manifest = await readManifest(canonicalRepoPath, true);
      await options.hooks?.afterCopy?.({ attempt, captureRoot });
      await options.hooks?.beforeVerify?.({ attempt, captureRoot });
      await assertIgnoreFilesRegular();
      const live = await readManifest(canonicalRepoPath, false);
      const copied = await readManifest(
        captureRoot,
        false,
        new Map(manifest.workspaceCapture!.entries.map((entry) => [entry.path, entry])),
      );
      const after = await identity();
      check();
      if (
        !manifestsMatch(manifest, live) ||
        !manifestsMatch(manifest, copied) ||
        sourceManifestDigest(manifest) !== sourceManifestDigest(live) ||
        sourceManifestDigest(manifest) !== sourceManifestDigest(copied) ||
        JSON.stringify(before) !== JSON.stringify(after)
      ) {
        throw new WorkspaceInputCaptureError(
          'changed-input',
          'Workspace inputs or base identity changed during capture; retry the request',
        );
      }
      manifest.head = before.head;
      const capturedPaths = manifest.workspaceCapture!.entries.map((entry) => entry.path);
      const tracked = before.head
        ? await execFileText('git', ['ls-tree', '-r', '--name-only', '-z', before.head], {
            cwd: canonicalRepoPath,
            timeoutMs: Math.min(GIT_TIMEOUT_MS, Math.max(1, deadline - performance.now())),
            maxBuffer: 16 * GIT_MAX_BUFFER,
          })
        : '';
      check();
      const captured = new Set(capturedPaths);
      const ignore = await loadIgnoreRules(captureRoot);
      const tombstones = tracked
        .split('\0')
        .filter(
          (file) =>
            file &&
            !captured.has(file) &&
            isSourceFilePath(file) &&
            !shouldIgnorePath(file) &&
            !ignore?.ignores(file),
        )
        .sort();
      return {
        canonicalRepoPath,
        captureRoot,
        manifest,
        manifestDigest: sourceManifestDigest(manifest),
        head: before.head,
        baseCommit: before.baseCommit,
        baseGenerationId: before.baseGenerationId,
        parserIdentity,
        configurationDigest: manifest.workspaceCapture!.configurationDigest,
        capturedPaths,
        tombstones,
        totalBytes,
        dispose,
      };
    } catch (error) {
      await dispose();
      check();
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 2 && (code === 'ENOENT' || code === 'changed-input')) continue;
      if (error instanceof WorkspaceInputCaptureError) throw error;
      throw new WorkspaceInputCaptureError(
        'unsupported',
        `Workspace capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new WorkspaceInputCaptureError(
    'changed-input',
    'Workspace inputs changed during both capture attempts; retry after writes settle',
  );
}
