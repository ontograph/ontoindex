import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDirtyOverlay } from '../core/analyze-delta.js';
import { createIgnoreFilter } from '../config/ignore-service.js';
import { readAnalyzeLock } from '../core/runtime/runtime-health.js';
import { getStoragePaths, readActiveGenerationMeta } from '../storage/repo-manager.js';
import { getGitRoot } from '../storage/git.js';

export interface DebouncedWatcherOptions {
  root: string;
  debounceMs?: number;
  maxWaitMs?: number;
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
  requestRefresh(): void;
  isBusy(): boolean;
} {
  const watch = opts.watchImpl ?? fs.watch;
  const debounceMs = opts.debounceMs ?? 750;
  const log = opts.log ?? (() => {});
  let watcher: fs.FSWatcher | undefined;
  let parentWatcher: fs.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let maxTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;
  let followUp = false;
  let rootStat: fs.BigIntStats | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (maxTimer) clearTimeout(maxTimer);
    maxTimer = undefined;
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

  const schedule = (bounded = false) => {
    const fire = () => {
      if (timer) clearTimeout(timer);
      if (maxTimer) clearTimeout(maxTimer);
      maxTimer = undefined;
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
    };
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
    timer.unref();
    if (bounded && !maxTimer) {
      maxTimer = setTimeout(fire, opts.maxWaitMs ?? 5000);
      maxTimer.unref();
    }
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
      if (stopped) return;
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
        followUp = false;
        if (!stopped && !timer) schedule();
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
    schedule(true);
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
    requestRefresh() {
      if (!stopped) void runRefresh();
    },
    isBusy: () => running || !!timer || followUp,
  };
}

type WatchChild = Pick<ChildProcess, 'once' | 'removeListener' | 'kill' | 'stdout' | 'stderr'>;

export interface WatchCommandDependencies {
  refreshCallback?: (reason: 'startup' | 'event' | 'reconcile' | 'base-head') => Promise<void>;
  retryDelaysMs?: number[];
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
  reconcileMs: number;
  leasePath: string;
  now: () => number;
  pid: number;
  isPidAlive: (pid: number) => boolean;
  readHead: (repoPath: string) => Promise<string | null>;
  readBase: (
    storagePath: string,
  ) => Promise<{ commit: string | null; generationId: string | null }>;
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
): Promise<{ stop(): Promise<void>; owned: boolean }> {
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
    reconcileMs: 30000,
    leasePath: path.join(getStoragePaths(repoPath).storagePath, 'watch.lease'),
    now: Date.now,
    pid: process.pid,
    readHead: (root) =>
      new Promise((resolve) => {
        execFile('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 2000 }, (error, stdout) =>
          resolve(error ? null : stdout.trim() || null),
        );
      }),
    readBase: async (storagePath) => {
      const { meta, activeGeneration } = await readActiveGenerationMeta(storagePath);
      return {
        commit: meta?.lastCommit ?? null,
        generationId: activeGeneration?.generationId ?? null,
      };
    },
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    ...overrides,
  };

  let child: WatchChild | undefined;
  let stopped = false;
  let launching = false;
  let baseRunning = false;
  let overlayPending = false;
  let attemptedHead: string | undefined;
  let signature: string | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let inFlightCallback: Promise<void> | undefined;
  let retryIndex = 0;
  let retryIdentity: string | undefined;
  let refreshReason: 'startup' | 'event' | 'reconcile' = 'event';
  const token = randomUUID();
  const retryDelays = deps.retryDelaysMs?.length
    ? deps.retryDelaysMs
    : [1000, 2000, 4000, 8000, 16000, 30000];
  const resetRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    retryIndex = 0;
  };
  const scheduleRetry = (head?: string) => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        void runChild(head);
      },
      retryDelays[Math.min(retryIndex++, retryDelays.length - 1)],
    );
    retryTimer.unref();
  };
  const planSignature = async (
    plan: Awaited<ReturnType<typeof planDirtyOverlay>>,
    generationId: string | null,
  ) => {
    const includePaths = [...plan.includePaths].sort();
    const fingerprints = await Promise.all(
      includePaths.map(async (includePath) => {
        try {
          const stat = await fs.promises.stat(path.join(repoPath, includePath));
          return [includePath, stat.mtimeMs, stat.size];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [includePath, 'gone'];
          throw error;
        }
      }),
    );
    return JSON.stringify([
      generationId,
      [...plan.allDirtyPaths].sort(),
      includePaths,
      fingerprints,
    ]);
  };
  const readState = async () => {
    const head = await deps.readHead(repoPath).catch(() => null);
    const base = await deps.readBase(getStoragePaths(repoPath).storagePath);
    return { head, base };
  };
  const readLease = (): { pid: number; heartbeat: number; token?: string } | undefined => {
    try {
      return JSON.parse(fs.readFileSync(deps.leasePath, 'utf8'));
    } catch {
      return undefined;
    }
  };
  const existing = readLease();
  if (
    existing &&
    Number.isInteger(existing.pid) &&
    existing.pid > 0 &&
    deps.now() - existing.heartbeat < 3 * deps.reconcileMs &&
    deps.isPidAlive(existing.pid)
  ) {
    deps.log(`another watcher (pid ${existing.pid}) owns this repository; not building overlays`);
    const done = Promise.resolve();
    return { owned: false, stop: () => done };
  }
  fs.mkdirSync(path.dirname(deps.leasePath), { recursive: true });
  // Exclusive creation prevents two concurrent starts from both claiming a clean lease.
  if (existing) fs.unlinkSync(deps.leasePath);
  try {
    fs.writeFileSync(
      deps.leasePath,
      JSON.stringify({ pid: deps.pid, token, heartbeat: deps.now() }),
      {
        flag: 'wx',
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = readLease();
    deps.log(
      `another watcher (pid ${owner?.pid ?? 'unknown'}) owns this repository; not building overlays`,
    );
    const done = Promise.resolve();
    return { owned: false, stop: () => done };
  }
  const heartbeat = () =>
    fs.writeFileSync(
      deps.leasePath,
      JSON.stringify({ pid: deps.pid, token, heartbeat: deps.now() }),
    );

  const runChild = async (baseHead?: string): Promise<void> => {
    if (stopped || child || launching) {
      if (baseRunning) overlayPending = true;
      return;
    }
    launching = true;
    let requestedSignature: string | undefined;
    try {
      if (!baseHead) {
        const plan = await deps.planDirtyOverlay(repoPath);
        const { base } = await readState();
        requestedSignature = await planSignature(plan, base.generationId);
      }
      if (stopped) return;
      baseRunning = !!baseHead;
      if (deps.refreshCallback) {
        try {
          const reason = baseHead ? 'base-head' : refreshReason;
          refreshReason = 'event';
          // Tracked so stop() can prove the callback settled before releasing ownership.
          inFlightCallback = deps.refreshCallback(reason);
          await inFlightCallback;
          if (baseHead) attemptedHead = baseHead;
          else signature = requestedSignature;
          resetRetry();
        } catch (error) {
          deps.error(`Watch refresh failed: ${String(error)}`);
          scheduleRetry(baseHead);
        } finally {
          inFlightCallback = undefined;
          baseRunning = false;
        }
        return;
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          child = undefined;
          baseRunning = false;
          resolve();
        };

        try {
          const processChild = deps.spawn(
            process.execPath,
            [deps.cliPath, 'analyze', ...(baseHead ? [] : ['--dirty-overlay']), repoPath],
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
            deps.error(`Watch ${baseHead ? 'base' : 'overlay'} child failed: ${error.message}`);
            if (baseHead) scheduleRetry(baseHead);
            finish();
          });
          processChild.once('close', (code, signal) => {
            if (settled) return;
            if (baseHead) {
              if (code !== 0)
                deps.error(
                  `Watch base analyze failed with code ${code ?? `signal ${signal ?? 'unknown'}`}.`,
                );
              if (code === 0) {
                attemptedHead = baseHead;
                resetRetry();
              } else scheduleRetry(baseHead);
              overlayPending ||= code === 0;
              finish();
              return;
            }
            if (code === 0) signature = requestedSignature;
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
            `Watch ${baseHead ? 'base' : 'overlay'} child failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (baseHead) scheduleRetry(baseHead);
          finish();
        }
      });
    } finally {
      launching = false;
      if (overlayPending && !stopped) {
        overlayPending = false;
        watcher.requestRefresh();
      }
    }
  };
  const refresh = () => runChild();
  const refreshBase = async (head: string | null, commit: string | null): Promise<boolean> => {
    if (!head || !commit || head === commit) return false;
    if (
      child ||
      launching ||
      retryTimer ||
      attemptedHead === head ||
      (await deps.isLockHeld(repoPath))
    )
      return true;
    void runChild(head);
    return true;
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

  let stopPromise: Promise<void> | undefined;
  const signalStop = () => {
    void stop().catch((error) => deps.error(String(error)));
  };
  const ownsLease = () => {
    const lease = readLease();
    return lease?.pid === deps.pid && lease.token === token;
  };
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    clearInterval(reconcileTimer);
    resetRetry();
    watcher.stop();
    deps.offSignal('SIGINT', signalStop);
    deps.offSignal('SIGTERM', signalStop);
    const ownedChild = child;
    const ownedCallback = inFlightCallback;
    stopPromise = (async () => {
      if (ownedCallback) {
        let deadline: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            ownedCallback.then(
              () => {},
              () => {},
            ),
            new Promise<never>((_, reject) => {
              deadline = setTimeout(
                () =>
                  reject(
                    new Error('Watch cleanup failure: refresh callback unsettled after 5000ms'),
                  ),
                5000,
              );
              deadline.unref();
            }),
          ]);
        } finally {
          clearTimeout(deadline);
        }
      }
      if (ownedChild)
        await new Promise<void>((resolve, reject) => {
          const timers: NodeJS.Timeout[] = [];
          const finish = () => {
            for (const timer of timers) clearTimeout(timer);
            ownedChild.removeListener('close', finish);
            ownedChild.removeListener('exit', finish);
            resolve();
          };
          ownedChild.once('close', finish);
          ownedChild.once('exit', finish);
          const killTimer = setTimeout(() => ownedChild.kill('SIGKILL'), 2000);
          const deadline = setTimeout(() => {
            clearTimeout(killTimer);
            ownedChild.removeListener('close', finish);
            ownedChild.removeListener('exit', finish);
            reject(new Error('Watch cleanup failure: child exit unproven after 5000ms'));
          }, 5000);
          timers.push(killTimer, deadline);
          killTimer.unref();
          deadline.unref();
          ownedChild.kill('SIGTERM');
        });
      if (ownsLease()) fs.unlinkSync(deps.leasePath);
    })();
    return stopPromise;
  };
  let reconciling = false;
  let planningFailed = false;
  const reconcileTimer = setInterval(() => {
    if (stopped || reconciling) return;
    if (!ownsLease()) {
      signalStop();
      return;
    }
    heartbeat();
    reconciling = true;
    void deps
      .planDirtyOverlay(repoPath)
      .then(async (plan) => {
        const { head, base } = await readState();
        const identity = JSON.stringify([head, await planSignature(plan, base.generationId)]);
        if (retryIdentity !== identity) {
          resetRetry();
          retryIdentity = identity;
        }
        refreshReason = 'reconcile';
        if (stopped || (await refreshBase(head, base.commit))) return;
        if (
          !stopped &&
          !watcher.isBusy() &&
          (await planSignature(plan, base.generationId)) !== signature
        )
          watcher.requestRefresh();
      })
      .catch((error: unknown) => {
        if (!planningFailed) deps.error(`Watch reconciliation planning failed: ${String(error)}`);
        planningFailed = true;
      })
      .finally(() => {
        reconciling = false;
      });
  }, deps.reconcileMs);
  reconcileTimer.unref();
  deps.onSignal('SIGINT', signalStop);
  deps.onSignal('SIGTERM', signalStop);
  watcher.start();

  try {
    const plan = await deps.planDirtyOverlay(repoPath);
    const { head, base } = await readState();
    signature = await planSignature(plan, base.generationId);
    retryIdentity = JSON.stringify([head, signature]);
    refreshReason = 'startup';
    const dirtyCount = plan.allDirtyPaths.length;
    const startupState =
      dirtyCount === 0
        ? 'tree is clean'
        : `${dirtyCount} dirty source path(s), covering ${plan.includePaths.length} file(s) and leaving ${plan.uncoveredPaths.length + plan.tombstones.length} uncovered`;
    deps.log(`Watching ${repoPath} (debounce ${WATCH_DEBOUNCE_MS} ms); ${startupState}`);
    if (
      !(await refreshBase(head, base.commit)) &&
      (plan.includePaths.length > 0 || plan.tombstones.length > 0)
    ) {
      watcher.requestRefresh();
    }
  } catch (error) {
    deps.log(`Watching ${repoPath} (debounce ${WATCH_DEBOUNCE_MS} ms); dirty state unknown`);
    deps.error(
      `Initial watch overlay planning failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { stop, owned: true };
}

export async function watchCommand(inputPath = process.cwd()): Promise<void> {
  const repoPath = getGitRoot(path.resolve(inputPath)) ?? path.resolve(inputPath);
  await createWatchCommand(repoPath);
}
