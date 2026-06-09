import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_NAME_PREFIX = 'debug-bisect-';
const DEFAULT_MAX_WORKERS = '2';
const SKIP_DIRS = new Set([
  '.cache',
  '.git',
  '.ontoindex',
  '.hg',
  '.svn',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const EXTENSION_SCAN_ENTRY_LIMIT = 20_000;

export interface DebugBisectOptions {
  timeout?: string | number;
  maxDepth?: string | number;
  namePrefix?: string;
  include?: string[];
  ext?: string[];
}

interface NormalizedOptions {
  timeoutMs: number;
  maxDepth: number;
  namePrefix: string;
  includes: string[];
  extensions: Set<string>;
}

interface AnalyzeResult {
  path: string;
  command: string;
  args: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
}

interface CandidateOptions {
  root: string;
  depthRemaining: number;
  includes: string[];
  extensions: Set<string>;
}

function parsePositiveInteger(
  value: string | number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function splitList(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeExtensions(values: string[] | undefined): Set<string> {
  return new Set(
    splitList(values).map((value) => {
      const normalized = value.toLowerCase();
      return normalized.startsWith('.') ? normalized : `.${normalized}`;
    }),
  );
}

function normalizeOptions(options: DebugBisectOptions): NormalizedOptions {
  return {
    timeoutMs: parsePositiveInteger(options.timeout, DEFAULT_TIMEOUT_MS, '--timeout'),
    maxDepth: parsePositiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH, '--max-depth'),
    namePrefix: options.namePrefix ?? DEFAULT_NAME_PREFIX,
    includes: splitList(options.include),
    extensions: normalizeExtensions(options.ext),
  };
}

function getCliEntryPath(): string {
  const invokedScript = process.argv[1];
  if (invokedScript && process.argv.includes('debug-bisect')) {
    return path.resolve(invokedScript);
  }
  return fileURLToPath(new URL('./index.js', import.meta.url));
}

function sanitizeRepoName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'root';
}

function relativeCandidateName(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  return relative || path.basename(candidate);
}

function matchesIncludeFilter(root: string, candidate: string, includes: string[]): boolean {
  if (includes.length === 0) return true;
  const relative = relativeCandidateName(root, candidate);
  return includes.some(
    (include) => relative.includes(include) || path.basename(candidate).includes(include),
  );
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function containsExtension(
  dir: string,
  extensions: Set<string>,
  maxDepth: number,
): Promise<boolean> {
  if (extensions.size === 0) return true;

  const pending: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  let entriesSeen = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;

    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > EXTENSION_SCAN_ENTRY_LIMIT) return true;

      if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        return true;
      }
      if (entry.isDirectory() && current.depth < maxDepth && !SKIP_DIRS.has(entry.name)) {
        pending.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return false;
}

export async function collectCandidateDirs(
  dir: string,
  options: CandidateOptions,
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Unable to read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;

    const candidate = path.join(dir, entry.name);
    if (!matchesIncludeFilter(options.root, candidate, options.includes)) continue;
    if (!(await containsExtension(candidate, options.extensions, options.depthRemaining))) continue;
    candidates.push(candidate);
  }

  return candidates.sort((a, b) => a.localeCompare(b));
}

export async function runAnalyze(
  targetPath: string,
  rootPath: string,
  options: NormalizedOptions,
): Promise<AnalyzeResult> {
  const cliEntry = getCliEntryPath();
  const repoName = `${options.namePrefix}${sanitizeRepoName(relativeCandidateName(rootPath, targetPath))}`;
  const args = [
    ...process.execArgv,
    cliEntry,
    'analyze',
    targetPath,
    '--skip-git',
    '--skip-agents-md',
    '--no-stats',
    '--name',
    repoName,
  ];
  const env = { ...process.env };
  env.ONTOINDEX_MAX_WORKERS ??= DEFAULT_MAX_WORKERS;

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: targetPath,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, options.timeoutMs);

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        path: targetPath,
        command: process.execPath,
        args,
        code,
        signal,
        timedOut,
        stderr: stderr.trim(),
      });
    });
  });
}

function formatResult(result: AnalyzeResult): string {
  if (result.timedOut) return `timed out after analyzer timeout`;
  if (result.signal) return `terminated by ${result.signal}`;
  return `exited ${result.code ?? 'without an exit code'}`;
}

export async function debugBisectCommand(
  inputPath = process.cwd(),
  rawOptions: DebugBisectOptions = {},
): Promise<void> {
  const options = normalizeOptions(rawOptions);
  const rootPath = path.resolve(inputPath);

  try {
    await fs.access(rootPath, fsConstants.R_OK);
  } catch {
    console.error(`Path is not readable: ${rootPath}`);
    process.exitCode = 1;
    return;
  }
  if (!(await isDirectory(rootPath))) {
    console.error(`Path is not a directory: ${rootPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Debug-bisect root: ${rootPath}`);
  console.log(`Timeout per child: ${options.timeoutMs}ms`);
  console.log(`Max depth: ${options.maxDepth}`);

  let currentPath = rootPath;
  let failingResult: AnalyzeResult | null = null;

  for (let depth = 0; depth < options.maxDepth; depth += 1) {
    const depthRemaining = options.maxDepth - depth - 1;
    const candidates = await collectCandidateDirs(currentPath, {
      root: rootPath,
      depthRemaining,
      includes: options.includes,
      extensions: options.extensions,
    });

    if (candidates.length === 0) break;

    console.log(`Scanning ${candidates.length} child dir(s) under ${currentPath}`);
    let foundFailure = false;
    for (const candidate of candidates) {
      console.log(`  analyze ${path.relative(rootPath, candidate) || candidate}`);
      const result = await runAnalyze(candidate, rootPath, options);
      if (result.code === 0 && !result.timedOut && !result.signal) continue;

      failingResult = result;
      foundFailure = true;
      currentPath = candidate;
      console.log(`Failing child: ${candidate} (${formatResult(result)})`);
      if (result.stderr) console.log(`Last stderr:\n${result.stderr}`);
      break;
    }

    if (!foundFailure) break;
  }

  if (failingResult) {
    console.log(`Smallest failing path found within bounds: ${failingResult.path}`);
    process.exitCode = 1;
    return;
  }

  console.log('No failing child directory found within the configured bounds.');
}
