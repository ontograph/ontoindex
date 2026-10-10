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
  const basename = path.posix.basename(normalized);
  if (basename.endsWith('~') || basename === '4913') return true;
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
  let parentWatcher: fs.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;
  let followUp = false;
  let rootStat: fs.BigIntStats | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    followUp = false;
    watcher?.close();
    watcher = undefined;
    parentWatcher?.close();
    parentWatcher = undefined;
  };

  const fail = (error: unknown) => {
    if (stopped) return;
    stop();
    log(`Watcher stopped: ${error instanceof Error ? error.message : String(error)}`);
  };

  const checkRoot = (): boolean => {
    if (!rootStat) return true;
    try {
      const current = fs.statSync(opts.root, { bigint: true });
      if (
        current.dev !== rootStat.dev ||
        current.ino !== rootStat.ino ||
        current.birthtimeNs !== rootStat.birthtimeNs
      ) {
        // The root was replaced but a directory exists again. The old native watch may be
        // attached to the deleted directory, so adopt the new one and re-arm. Only a root
        // that is gone (statSync throws) stops the watcher.
        rootStat = current;
        if (!opts.watchImpl) {
          watcher?.close();
          openWatcher();
        }
      }
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const openWatcher = () => {
    watcher = watch(opts.root, { recursive: true }, onChange);
    watcher.on?.('error', fail);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!checkRoot()) return;
      if (!opts.watchImpl) {
        // Node's recursive Linux watcher can retain the old inode after an editor save.
        // Re-arm before refreshing so later saves are observed without polling.
        try {
          watcher?.close();
          openWatcher();
        } catch (error) {
          fail(error);
          return;
        }
      }
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
    if (relPath === '' && !checkRoot()) return;
    if (isIgnoredByDefault(relPath) || opts.shouldIgnore?.(relPath)) return;
    schedule();
  };

  return {
    start() {
      if (watcher || stopped) return;
      try {
        if (!opts.watchImpl) {
          const root = path.resolve(opts.root);
          rootStat = fs.statSync(root, { bigint: true });
          // Recursive fs.watch can miss immediate root replacement; its parent observes it.
          parentWatcher = fs.watch(path.dirname(root), (eventType, filename) => {
            if (!stopped && (filename == null || filename.toString() === path.basename(root))) {
              if (eventType === 'rename' && filename != null) {
                // A rename of the root's name is ambiguous. On macOS FSEvents replays the
                // root's own creation right after arming; on Linux an immediate delete and
                // recreate reuses the inode and birthtime. Either way the answer is the same:
                // if the root is gone, stop; otherwise watch the directory that exists now.
                try {
                  rootStat = fs.statSync(root, { bigint: true });
                } catch (error) {
                  fail(error);
                  return;
                }
                try {
                  watcher?.close();
                  openWatcher();
                } catch (error) {
                  fail(error);
                }
                return;
              }
              checkRoot();
            }
          });
          parentWatcher.on('error', fail);
        }
        openWatcher();
      } catch (error) {
        stop();
        throw error;
      }
    },
    stop,
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
const WATCH_DEBOUNCE_MS = 750;

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
    debounceMs: WATCH_DEBOUNCE_MS,
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
    const dirtyCount = new Set([...plan.includePaths, ...plan.tombstones]).size;
    const startupState = plan.tooMany
      ? 'tree is dirty; overlay skipped because the source-file limit was exceeded'
      : dirtyCount === 0
        ? 'tree is clean'
        : `${dirtyCount} dirty source file(s), building overlay`;
    deps.log(`Watching ${repoPath} (debounce ${WATCH_DEBOUNCE_MS} ms); ${startupState}`);
    if (!plan.tooMany && (plan.includePaths.length > 0 || plan.tombstones.length > 0)) {
      if (await deps.isLockHeld(repoPath)) {
        deps.log('Skipping refresh because analyze.lock is held.');
      } else {
        void refresh();
      }
    }
  } catch (error) {
    deps.log(`Watching ${repoPath} (debounce ${WATCH_DEBOUNCE_MS} ms); dirty state unknown`);
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
