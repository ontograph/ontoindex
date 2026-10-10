import fs from 'node:fs';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDirtyOverlay } from '../core/analyze-delta.js';
import { createIgnoreFilter } from '../config/ignore-service.js';
import { readAnalyzeLock } from '../core/runtime/runtime-health.js';
import { getStoragePaths } from '../storage/repo-manager.js';
import { getGitRoot } from '../storage/git.js';

export interface DebouncedWatcherOptions {
  root: string;
  debounceMs?: number;
  isLockHeld: () => Promise<boolean> | boolean;
  refresh: () => Promise<void>;
  shouldIgnore?: (relPath: string) => boolean;
  log?: (msg: string) => void;
  watchImpl?: typeof fs.watch;
}

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.ontoindex']);
const IGNORED_EXTENSIONS = new Set([
  '.7z',
  '.a',
  '.avi',
  '.bin',
  '.bmp',
  '.class',
  '.dll',
  '.dylib',
  '.eot',
  '.exe',
  '.flac',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.lock',
  '.log',
  '.mp3',
  '.mp4',
  '.o',
  '.pdf',
  '.png',
  '.so',
  '.sqlite',
  '.swp',
  '.tar',
  '.tmp',
  '.ttf',
  '.wasm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

function isIgnoredByDefault(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => IGNORED_DIRECTORIES.has(part))) return true;
  return IGNORED_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase());
}

export function createDebouncedWatcher(opts: DebouncedWatcherOptions): {
  start(): void;
  stop(): void;
} {
  const watch = opts.watchImpl ?? fs.watch;
  const debounceMs = opts.debounceMs ?? 750;
  const log = opts.log ?? (() => {});
  let watcher: fs.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;
  let followUp = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runRefresh();
    }, debounceMs);
  };

  const runRefresh = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      followUp = true;
      return;
    }

    running = true;
    let lockHeld = false;
    try {
      lockHeld = await opts.isLockHeld();
      if (lockHeld) {
        log('Skipping refresh because analyze.lock is held.');
        return;
      }
      await opts.refresh();
    } catch (error) {
      log(`Watcher refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      if (lockHeld) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        followUp = false;
      }
      if (!stopped && followUp) {
        followUp = false;
        if (timer) return;
        void runRefresh();
      }
    }
  };

  const onChange = (_eventType: string, filename: string | Buffer | null) => {
    if (stopped) return;
    const relPath = filename == null ? '' : filename.toString();
    if (isIgnoredByDefault(relPath) || opts.shouldIgnore?.(relPath)) return;
    schedule();
  };

  return {
    start() {
      if (watcher || stopped) return;
      watcher = watch(opts.root, { recursive: true }, onChange);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      followUp = false;
      watcher?.close();
      watcher = undefined;
    },
  };
}

type WatchChild = Pick<ChildProcess, 'once' | 'kill' | 'stdout' | 'stderr'>;

export interface WatchCommandDependencies {
  spawn: typeof nodeSpawn;
  createWatcher: typeof createDebouncedWatcher;
  isLockHeld: (repoPath: string) => Promise<boolean> | boolean;
  planDirtyOverlay: typeof planDirtyOverlay;
  createIgnoreFilter: typeof createIgnoreFilter;
  log: (message: string) => void;
  error: (message: string) => void;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  onSignal: (signal: NodeJS.Signals, listener: () => void) => void;
  offSignal: (signal: NodeJS.Signals, listener: () => void) => void;
}

const EMBEDDING_ENV_PATTERN = /(?:^|_)(?:EMBEDDING|EMBEDDINGS)(?:_|$)/i;

function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !EMBEDDING_ENV_PATTERN.test(name)),
  );
}

export async function createWatchCommand(
  repoPath: string,
  overrides: Partial<WatchCommandDependencies> = {},
): Promise<{ stop(): void }> {
  const deps: WatchCommandDependencies = {
    spawn: nodeSpawn,
    createWatcher: createDebouncedWatcher,
    isLockHeld: async (root) => {
      const warnings: string[] = [];
      return (
        (await readAnalyzeLock(getStoragePaths(root).storagePath, warnings)).state === 'active'
      );
    },
    planDirtyOverlay,
    createIgnoreFilter,
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    cliPath: process.argv[1] ?? fileURLToPath(new URL('./index.js', import.meta.url)),
    env: process.env,
    onSignal: (signal, listener) => process.on(signal, listener),
    offSignal: (signal, listener) => process.off(signal, listener),
    ...overrides,
  };

  let child: WatchChild | undefined;
  let stopped = false;

  const refresh = async (): Promise<void> => {
    if (stopped || child) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        child = undefined;
        resolve();
      };

      try {
        const processChild = deps.spawn(
          process.execPath,
          [deps.cliPath, 'analyze', '--dirty-overlay', repoPath],
          {
            cwd: repoPath,
            env: childEnvironment(deps.env),
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        child = processChild;
        processChild.stdout?.on('data', (chunk: Buffer | string) => process.stdout.write(chunk));
        processChild.stderr?.on('data', (chunk: Buffer | string) => process.stderr.write(chunk));
        processChild.once('error', (error) => {
          deps.error(`Watch overlay child failed: ${error.message}`);
          finish();
        });
        processChild.once('close', (code, signal) => {
          deps.log(
            `Watch overlay analyze exited with code ${code ?? `signal ${signal ?? 'unknown'}`}.`,
          );
          if (code !== 0) {
            deps.error(
              `Watch overlay analyze failed with code ${code ?? `signal ${signal ?? 'unknown'}`}.`,
            );
          }
          finish();
        });
      } catch (error) {
        deps.error(
          `Watch overlay child failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        finish();
      }
    });
  };

  const ignoreFilter = await deps.createIgnoreFilter(repoPath);
  const watcher = deps.createWatcher({
    root: repoPath,
    isLockHeld: () => deps.isLockHeld(repoPath),
    refresh,
    shouldIgnore: (relPath) =>
      ignoreFilter.ignored({ relative: () => relPath.replaceAll('\\', '/') } as never),
    log: deps.log,
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    watcher.stop();
    child?.kill('SIGTERM');
    deps.offSignal('SIGINT', stop);
    deps.offSignal('SIGTERM', stop);
  };
  deps.onSignal('SIGINT', stop);
  deps.onSignal('SIGTERM', stop);
  watcher.start();

  try {
    const plan = await deps.planDirtyOverlay(repoPath);
    if (!plan.tooMany && (plan.includePaths.length > 0 || plan.tombstones.length > 0)) {
      if (await deps.isLockHeld(repoPath)) {
        deps.log('Skipping refresh because analyze.lock is held.');
      } else {
        void refresh();
      }
    }
  } catch (error) {
    deps.error(
      `Initial watch overlay planning failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { stop };
}

export async function watchCommand(inputPath = process.cwd()): Promise<void> {
  const repoPath = getGitRoot(path.resolve(inputPath)) ?? path.resolve(inputPath);
  await createWatchCommand(repoPath);
}
