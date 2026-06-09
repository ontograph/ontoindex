import { Worker } from 'node:worker_threads';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ParseWorkerDiagnostics, WorkerOutgoingMessage } from './parse-types.js';

export interface WorkerPool {
  /**
   * Dispatch items across workers. Items are split into chunks (one per worker),
   * each worker processes its chunk via sub-batches to limit peak memory,
   * and results are concatenated back in order.
   */
  dispatch<TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number, filePath?: string) => void,
    onSubBatchStart?: (event: WorkerSubBatchStartEvent) => void,
    onWorkerResult?: (event: WorkerResultEvent) => void,
    options?: WorkerDispatchOptions<TResult>,
  ): Promise<TResult[]>;

  /** Terminate all workers. Must be called when done. */
  terminate(): Promise<void>;

  /** Number of workers in the pool */
  readonly size: number;
  /** Isolation mode used by this pool. */
  readonly isolation: WorkerIsolationMode;
  /** Total wall-clock time spent creating the initial worker handles. */
  readonly startupDurationMs: number;
  /** Per-worker wall-clock startup/spawn duration for the current handles. */
  readonly workerStartupDurationsMs: readonly number[];
}

export interface WorkerSubBatchStartEvent {
  workerIndex: number;
  subBatchIndex: number;
  subBatchSize: number;
  workerChunkSize: number;
  workerIsolation: WorkerIsolationMode;
  workerStartupDurationMs?: number;
  payloadBytes?: number;
  firstFilePath?: string;
  lastFilePath?: string;
}

export interface WorkerResultEvent {
  workerIndex: number;
  workerChunkSize: number;
  workerIsolation: WorkerIsolationMode;
  workerStartupDurationMs?: number;
  resultBytes?: number;
  resultCounts?: Record<string, number>;
}

export interface WorkerDispatchOptions<TResult> {
  /**
   * Keep result-part payloads in the worker-pool accumulator. Disable this when
   * the caller consumes each part through onResultPart and can return an empty
   * per-worker result at flush time.
   */
  collectResultParts?: boolean;
  createEmptyResult?: () => TResult;
  onResultPart?: (result: TResult, event: WorkerResultEvent) => void;
}

export type WorkerIsolationMode = 'thread' | 'process';

export interface WorkerPoolOptions {
  isolation?: WorkerIsolationMode;
}

const boundedEnvInt = (name: string, fallback: number, min: number, max: number): number => {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(raw, max));
};

const optionalBoundedEnvInt = (name: string, min: number, max: number): number | undefined => {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.max(min, Math.min(raw, max));
};

export const DEFAULT_WORKER_CPU_FRACTION = 0.25;

const getLogicalCpuCount = (): number => {
  const count =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, count);
};

export const getDefaultMaxWorkerCount = (logicalCpuCount = getLogicalCpuCount()): number => {
  return Math.max(1, Math.floor(logicalCpuCount * DEFAULT_WORKER_CPU_FRACTION));
};

export const resolveMaxWorkerCount = (
  logicalCpuCount = getLogicalCpuCount(),
  envValue = process.env.ONTOINDEX_MAX_WORKERS,
): number => {
  const configured = Number.parseInt(envValue ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return getDefaultMaxWorkerCount(logicalCpuCount);
};

/**
 * Max files to send to a worker in a single postMessage.
 * Keeps structured-clone memory bounded per sub-batch.
 */
export const WORKER_SUB_BATCH_SIZE = boundedEnvInt('ONTOINDEX_WORKER_SUB_BATCH_SIZE', 100, 1, 1000);

/** Per sub-batch timeout. If a single sub-batch takes longer than this,
 *  likely a pathological file or native parser stall. Fail fast. */
export const WORKER_SUB_BATCH_TIMEOUT_MS = boundedEnvInt(
  'ONTOINDEX_WORKER_SUB_BATCH_TIMEOUT_MS',
  120_000,
  5_000,
  600_000,
);

export const WORKER_SUB_BATCH_MAX_BYTES = optionalBoundedEnvInt(
  'ONTOINDEX_WORKER_SUB_BATCH_MAX_BYTES',
  64 * 1024,
  256 * 1024 * 1024,
);

const itemPath = (item: unknown): string | undefined => {
  if (!item || typeof item !== 'object') return undefined;
  const pathValue = (item as { path?: unknown }).path;
  return typeof pathValue === 'string' ? pathValue : undefined;
};

const describeItemRange = (items: unknown[]): string => {
  const first = itemPath(items[0]);
  const last = itemPath(items[items.length - 1]);
  if (first && last && first !== last) return `files ${first} .. ${last}`;
  if (first) return `file ${first}`;
  return `${items.length} item${items.length === 1 ? '' : 's'}`;
};

const estimateSubBatchBytes = (items: unknown[]): number | undefined => {
  let total = 0;
  let sawPayload = false;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const input = item as { path?: unknown; content?: unknown };
    if (typeof input.path === 'string') {
      total += Buffer.byteLength(input.path);
      sawPayload = true;
    }
    if (typeof input.content === 'string') {
      total += Buffer.byteLength(input.content);
      sawPayload = true;
    }
  }
  return sawPayload ? total : undefined;
};

export const createWorkerSubBatches = <TInput>(
  items: TInput[],
  maxItems = WORKER_SUB_BATCH_SIZE,
  maxBytes = WORKER_SUB_BATCH_MAX_BYTES,
): TInput[][] => {
  const batches: TInput[][] = [];
  let current: TInput[] = [];

  for (const item of items) {
    const next = [...current, item];
    const nextBytes = maxBytes === undefined ? undefined : estimateSubBatchBytes(next);
    const exceedsItemLimit = next.length > maxItems;
    const exceedsByteLimit =
      maxBytes !== undefined && nextBytes !== undefined && nextBytes > maxBytes;

    if (current.length > 0 && (exceedsItemLimit || exceedsByteLimit)) {
      batches.push(current);
      current = [item];
    } else {
      current = next;
    }
  }

  if (current.length > 0) batches.push(current);
  return batches;
};

const summarizeResultCounts = (result: unknown): Record<string, number> | undefined => {
  if (!result || typeof result !== 'object') return undefined;
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (Array.isArray(value)) counts[key] = value.length;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
};

const estimateJsonBytes = (value: unknown): number | undefined => {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return undefined;
  }
};

const describeDiagnostics = (diagnostics?: ParseWorkerDiagnostics): string[] => {
  if (!diagnostics) return [];
  const details: string[] = [];
  if (diagnostics.phase) details.push(`phase: ${diagnostics.phase}`);
  if (diagnostics.workerIndex !== undefined) details.push(`worker: ${diagnostics.workerIndex}`);
  if (diagnostics.workerIsolation) details.push(`isolation: ${diagnostics.workerIsolation}`);
  if (diagnostics.subBatchIndex !== undefined) {
    const size = diagnostics.subBatchSize !== undefined ? ` size ${diagnostics.subBatchSize}` : '';
    details.push(`sub-batch: ${diagnostics.subBatchIndex}${size}`);
  } else if (diagnostics.subBatchSize !== undefined) {
    details.push(`sub-batch size: ${diagnostics.subBatchSize}`);
  }
  if (diagnostics.workerChunkSize !== undefined) {
    details.push(`worker chunk: ${diagnostics.workerChunkSize}`);
  }
  if (diagnostics.currentFilePath) details.push(`current file: ${diagnostics.currentFilePath}`);
  if (diagnostics.lastProcessedFilePath) {
    details.push(`last processed: ${diagnostics.lastProcessedFilePath}`);
  }
  if (
    diagnostics.firstFilePath &&
    diagnostics.lastFilePath &&
    diagnostics.firstFilePath !== diagnostics.lastFilePath
  ) {
    details.push(`files: ${diagnostics.firstFilePath} .. ${diagnostics.lastFilePath}`);
  } else if (diagnostics.firstFilePath) {
    details.push(`file: ${diagnostics.firstFilePath}`);
  }
  if (diagnostics.filesProcessed !== undefined) {
    details.push(`files processed: ${diagnostics.filesProcessed}`);
  }
  return details;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const appendArray = (target: unknown[], src: unknown[]): void => {
  for (let i = 0; i < src.length; i++) target.push(src[i]);
};

const mergeResultPayload = <TResult>(target: TResult | undefined, src: unknown): TResult => {
  if (target === undefined) return src as TResult;
  if (!isPlainRecord(target) || !isPlainRecord(src)) return src as TResult;
  const merged = target as Record<string, unknown>;

  for (const [key, value] of Object.entries(src)) {
    const current = merged[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      appendArray(current, value);
    } else if (typeof current === 'number' && typeof value === 'number') {
      merged[key] = current + value;
    } else if (isPlainRecord(current) && isPlainRecord(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        const currentNested = current[nestedKey];
        current[nestedKey] =
          typeof currentNested === 'number' && typeof nestedValue === 'number'
            ? currentNested + nestedValue
            : nestedValue;
      }
    } else {
      merged[key] = value;
    }
  }
  return merged as TResult;
};

type WorkerIncomingMessage =
  | { type: 'flush'; diagnostics?: ParseWorkerDiagnostics }
  | { type: 'sub-batch'; files: unknown[]; diagnostics?: ParseWorkerDiagnostics };

type WorkerHandleEventMap = {
  message: [message: WorkerOutgoingMessage];
  error: [err: Error];
  exit: [code: number | null, signal?: string | null];
};

type WorkerHandleEvent = keyof WorkerHandleEventMap;
type WorkerHandleListener<E extends WorkerHandleEvent> = (...args: WorkerHandleEventMap[E]) => void;

type ChildIpcMessage = Parameters<ChildProcess['send']>[0];
type ChildMessageListener = (message: ChildIpcMessage) => void;
type ChildExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ThreadMessageListener = (message: unknown) => void;
type ThreadErrorListener = (err: unknown) => void;
type ThreadExitListener = (code: number) => void;

interface WorkerHandle {
  on<E extends 'message'>(event: E, listener: WorkerHandleListener<E>): WorkerHandle;
  once<E extends 'error' | 'exit'>(event: E, listener: WorkerHandleListener<E>): WorkerHandle;
  removeListener<E extends WorkerHandleEvent>(
    event: E,
    listener: WorkerHandleListener<E>,
  ): WorkerHandle;
  postMessage(message: WorkerIncomingMessage): void;
  terminate(): Promise<unknown>;
}

const getMappedListener = <TListener extends object, TNativeListener>(
  listeners: WeakMap<TListener, TNativeListener>,
  listener: TListener,
  create: () => TNativeListener,
): TNativeListener => {
  const existing = listeners.get(listener);
  if (existing) return existing;
  const nativeListener = create();
  listeners.set(listener, nativeListener);
  return nativeListener;
};

const terminateChild = async (child: ChildProcess): Promise<void> => {
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  if (hasExited()) return;
  const exitPromise = once(child, 'exit');
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    if (!hasExited()) child.kill('SIGKILL');
  }, 2_000);
  try {
    await exitPromise;
  } finally {
    clearTimeout(killTimer);
  }
};

const createWorkerHandle = (workerUrl: URL, isolation: WorkerIsolationMode): WorkerHandle => {
  if (isolation === 'process') {
    const child = fork(fileURLToPath(workerUrl), [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: [],
    });
    const messageListeners = new WeakMap<WorkerHandleListener<'message'>, ChildMessageListener>();
    const errorListeners = new WeakMap<WorkerHandleListener<'error'>, (err: Error) => void>();
    const exitListeners = new WeakMap<WorkerHandleListener<'exit'>, ChildExitListener>();
    const handle: WorkerHandle = {
      on: (event, listener) => {
        const nativeListener = getMappedListener(messageListeners, listener, () => {
          return (message: ChildIpcMessage) => listener(message as WorkerOutgoingMessage);
        });
        child.on(event, nativeListener);
        return handle;
      },
      once: (event, listener) => {
        if (event === 'error') {
          const errorListener = listener as WorkerHandleListener<'error'>;
          const nativeListener = getMappedListener(errorListeners, errorListener, () => {
            return (err: Error) => errorListener(err);
          });
          child.once(event, nativeListener);
        } else {
          const exitListener = listener as WorkerHandleListener<'exit'>;
          const nativeListener = getMappedListener(exitListeners, exitListener, () => {
            return (code: number | null, signal: NodeJS.Signals | null) =>
              exitListener(code, signal);
          });
          child.once(event, nativeListener);
        }
        return handle;
      },
      removeListener: (event, listener) => {
        if (event === 'message') {
          const nativeListener = messageListeners.get(listener as WorkerHandleListener<'message'>);
          if (nativeListener) {
            child.removeListener(event, nativeListener);
            messageListeners.delete(listener as WorkerHandleListener<'message'>);
          }
        } else if (event === 'error') {
          const nativeListener = errorListeners.get(listener as WorkerHandleListener<'error'>);
          if (nativeListener) {
            child.removeListener(event, nativeListener);
            errorListeners.delete(listener as WorkerHandleListener<'error'>);
          }
        } else {
          const nativeListener = exitListeners.get(listener as WorkerHandleListener<'exit'>);
          if (nativeListener) {
            child.removeListener(event, nativeListener);
            exitListeners.delete(listener as WorkerHandleListener<'exit'>);
          }
        }
        return handle;
      },
      postMessage: (message) => {
        if (!child.connected) throw new Error('Parser child process IPC channel closed');
        child.send(message);
      },
      terminate: () => terminateChild(child),
    };
    return handle;
  }

  const worker = new Worker(workerUrl);
  const messageListeners = new WeakMap<WorkerHandleListener<'message'>, ThreadMessageListener>();
  const errorListeners = new WeakMap<WorkerHandleListener<'error'>, ThreadErrorListener>();
  const exitListeners = new WeakMap<WorkerHandleListener<'exit'>, ThreadExitListener>();
  const handle: WorkerHandle = {
    on: (event, listener) => {
      const nativeListener = getMappedListener(messageListeners, listener, () => {
        return (message: unknown) => listener(message as WorkerOutgoingMessage);
      });
      worker.on(event, nativeListener);
      return handle;
    },
    once: (event, listener) => {
      if (event === 'error') {
        const errorListener = listener as WorkerHandleListener<'error'>;
        const nativeListener = getMappedListener(errorListeners, errorListener, () => {
          return (err: unknown) => errorListener(err as Error);
        });
        worker.once(event, nativeListener);
      } else {
        const exitListener = listener as WorkerHandleListener<'exit'>;
        const nativeListener = getMappedListener(exitListeners, exitListener, () => {
          return (code: number) => exitListener(code);
        });
        worker.once(event, nativeListener);
      }
      return handle;
    },
    removeListener: (event, listener) => {
      if (event === 'message') {
        const nativeListener = messageListeners.get(listener as WorkerHandleListener<'message'>);
        if (nativeListener) {
          worker.removeListener(event, nativeListener);
          messageListeners.delete(listener as WorkerHandleListener<'message'>);
        }
      } else if (event === 'error') {
        const nativeListener = errorListeners.get(listener as WorkerHandleListener<'error'>);
        if (nativeListener) {
          worker.removeListener(event, nativeListener);
          errorListeners.delete(listener as WorkerHandleListener<'error'>);
        }
      } else {
        const nativeListener = exitListeners.get(listener as WorkerHandleListener<'exit'>);
        if (nativeListener) {
          worker.removeListener(event, nativeListener);
          exitListeners.delete(listener as WorkerHandleListener<'exit'>);
        }
      }
      return handle;
    },
    postMessage: (message) => worker.postMessage(message),
    terminate: () => worker.terminate(),
  };
  return handle;
};

/**
 * Create a pool of worker threads.
 */
export const createWorkerPool = (
  workerUrl: URL,
  poolSize?: number,
  options: WorkerPoolOptions = {},
): WorkerPool => {
  // Validate worker script exists before spawning to prevent uncaught
  // MODULE_NOT_FOUND crashes in worker threads (e.g. when running from src/ via vitest)
  const workerPath = fileURLToPath(workerUrl);
  if (!fs.existsSync(workerPath)) {
    throw new Error(`Worker script not found: ${workerPath}`);
  }

  const logicalCpuCount = getLogicalCpuCount();
  const cap = resolveMaxWorkerCount(logicalCpuCount);
  const size = poolSize ?? Math.min(cap, Math.max(1, logicalCpuCount - 1));
  const isolation = options.isolation ?? 'thread';
  const workers: WorkerHandle[] = [];
  const workerStartupDurationsMs: number[] = [];

  const spawnWorker = (index: number): WorkerHandle => {
    const started = Date.now();
    const worker = createWorkerHandle(workerUrl, isolation);
    workerStartupDurationsMs[index] = Date.now() - started;
    return worker;
  };

  const poolStartupStarted = Date.now();
  for (let i = 0; i < size; i++) workers.push(spawnWorker(i));
  const startupDurationMs = Date.now() - poolStartupStarted;

  const dispatch = async <TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number, filePath?: string) => void,
    onSubBatchStart?: (event: WorkerSubBatchStartEvent) => void,
    onWorkerResult?: (event: WorkerResultEvent) => void,
    options: WorkerDispatchOptions<TResult> = {},
  ): Promise<TResult[]> => {
    if (items.length === 0) return Promise.resolve([]);

    const chunkSize = Math.ceil(items.length / size);
    const chunks: TInput[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    const workerProgress = new Array(chunks.length).fill(0);

    const promises = chunks.map((chunk, i) => {
      const worker = workers[i];
      return new Promise<TResult>((resolve, reject) => {
        let settled = false;
        let subBatchTimer: ReturnType<typeof setTimeout> | null = null;
        let lastProgressFilePath: string | undefined;
        let currentFilePath: string | undefined;
        let activePhase = 'idle';
        let activeSubBatchSummary = '';
        let activeSubBatchDiagnostics: ParseWorkerDiagnostics | undefined;
        let accumulatedResult: TResult | undefined;

        const describeFailureContext = (diagnostics?: ParseWorkerDiagnostics) => {
          const details = describeDiagnostics({
            ...activeSubBatchDiagnostics,
            phase: diagnostics?.phase ?? activePhase,
            currentFilePath: diagnostics?.currentFilePath ?? currentFilePath,
            lastProcessedFilePath: diagnostics?.lastProcessedFilePath ?? lastProgressFilePath,
            filesProcessed: diagnostics?.filesProcessed,
            ...diagnostics,
          });
          if (activeSubBatchSummary) details.push(`active: ${activeSubBatchSummary}`);
          if (lastProgressFilePath) details.push(`last completed: ${lastProgressFilePath}`);
          return details.length > 0 ? ` (${details.join('; ')})` : '';
        };

        const cleanup = () => {
          if (subBatchTimer) clearTimeout(subBatchTimer);
          worker.removeListener('message', handler);
          worker.removeListener('error', errorHandler);
          worker.removeListener('exit', exitHandler);
        };

        const resetSubBatchTimer = () => {
          if (subBatchTimer) clearTimeout(subBatchTimer);
          subBatchTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              cleanup();
              // Bug #2: terminate the zombie worker; Bug #6: respawn replacement
              void worker.terminate();
              workers[i] = spawnWorker(i);
              reject(
                new Error(
                  `Worker ${i} timed out after ${WORKER_SUB_BATCH_TIMEOUT_MS / 1000}s${describeFailureContext({ phase: activePhase })}.`,
                ),
              );
            }
          }, WORKER_SUB_BATCH_TIMEOUT_MS);
        };

        const subBatches = createWorkerSubBatches(chunk);
        let subBatchIdx = 0;

        const sendNextSubBatch = () => {
          const subBatch = subBatches[subBatchIdx];
          if (!subBatch) {
            activePhase = 'flush';
            activeSubBatchDiagnostics = {
              workerIndex: i,
              workerIsolation: isolation,
              workerChunkSize: chunk.length,
              lastProcessedFilePath: lastProgressFilePath,
              filesProcessed: workerProgress[i],
              phase: activePhase,
            };
            activeSubBatchSummary = `flush result for ${chunk.length} items`;
            resetSubBatchTimer();
            worker.postMessage({ type: 'flush', diagnostics: activeSubBatchDiagnostics });
            return;
          }
          activeSubBatchSummary = describeItemRange(subBatch);
          subBatchIdx++;
          activePhase = 'sub-batch';
          currentFilePath = undefined;
          activeSubBatchDiagnostics = {
            workerIndex: i,
            workerIsolation: isolation,
            subBatchIndex: subBatchIdx,
            subBatchSize: subBatch.length,
            workerChunkSize: chunk.length,
            firstFilePath: itemPath(subBatch[0]),
            lastFilePath: itemPath(subBatch[subBatch.length - 1]),
            lastProcessedFilePath: lastProgressFilePath,
            filesProcessed: workerProgress[i],
            phase: activePhase,
          };
          resetSubBatchTimer();
          onSubBatchStart?.({
            workerIndex: i,
            subBatchIndex: subBatchIdx,
            subBatchSize: subBatch.length,
            workerChunkSize: chunk.length,
            workerIsolation: isolation,
            workerStartupDurationMs: workerStartupDurationsMs[i],
            payloadBytes: estimateSubBatchBytes(subBatch),
            firstFilePath: itemPath(subBatch[0]),
            lastFilePath: itemPath(subBatch[subBatch.length - 1]),
          });
          worker.postMessage({
            type: 'sub-batch',
            files: subBatch,
            diagnostics: activeSubBatchDiagnostics,
          });
        };

        const handler = (msg: WorkerOutgoingMessage) => {
          if (settled) return;
          if (msg.type === 'progress') {
            workerProgress[i] = msg.filesProcessed;
            lastProgressFilePath = msg.filePath ?? lastProgressFilePath;
            if (onProgress) {
              const total = workerProgress.reduce((a, b) => a + b, 0);
              onProgress(total, msg.filePath);
            }
            // Bug #1: reset watchdog on each progress event, not only on sub-batch send
            resetSubBatchTimer();
          } else if (msg.type === 'warning') {
            console.warn(
              `${msg.message}${msg.diagnostics ? describeFailureContext(msg.diagnostics) : ''}`,
            );
          } else if (msg.type === 'diagnostic') {
            activePhase = msg.diagnostics.phase ?? activePhase;
            currentFilePath = msg.diagnostics.currentFilePath ?? currentFilePath;
            lastProgressFilePath = msg.diagnostics.lastProcessedFilePath ?? lastProgressFilePath;
            activeSubBatchDiagnostics = {
              ...activeSubBatchDiagnostics,
              ...msg.diagnostics,
            };
            resetSubBatchTimer();
          } else if (msg.type === 'result-part') {
            const event = {
              workerIndex: i,
              workerChunkSize: chunk.length,
              workerIsolation: isolation,
              workerStartupDurationMs: workerStartupDurationsMs[i],
              resultBytes: estimateJsonBytes(msg.data),
              resultCounts: summarizeResultCounts(msg.data),
            };
            if (options.collectResultParts !== false) {
              accumulatedResult = mergeResultPayload<TResult>(accumulatedResult, msg.data);
            }
            onWorkerResult?.(event);
            options.onResultPart?.(msg.data as TResult, event);
            resetSubBatchTimer();
          } else if (msg.type === 'sub-batch-done') {
            activePhase = 'sub-batch-done';
            currentFilePath = undefined;
            sendNextSubBatch();
          } else if (msg.type === 'error') {
            settled = true;
            cleanup();
            reject(
              new Error(
                `Worker ${i} error: ${msg.error}${describeFailureContext(msg.diagnostics)}`,
              ),
            );
          } else if (msg.type === 'result') {
            settled = true;
            cleanup();
            const data =
              msg.data === undefined
                ? (accumulatedResult ?? options.createEmptyResult?.())
                : options.collectResultParts === false
                  ? (msg.data as TResult)
                  : mergeResultPayload<TResult>(accumulatedResult, msg.data);
            if (msg.data !== undefined || accumulatedResult === undefined) {
              onWorkerResult?.({
                workerIndex: i,
                workerChunkSize: chunk.length,
                workerIsolation: isolation,
                workerStartupDurationMs: workerStartupDurationsMs[i],
                resultBytes: estimateJsonBytes(data),
                resultCounts: summarizeResultCounts(data),
              });
            }
            resolve(data as TResult);
          }
        };

        const errorHandler = (err: Error) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(`Worker ${i} thread error: ${err.message}${describeFailureContext()}`, {
                cause: err,
              }),
            );
          }
        };

        const exitHandler = (code: number | null, signal?: string | null) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(
                `Worker ${i} exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}${describeFailureContext()}. Likely OOM or native addon failure.`,
              ),
            );
          }
        };

        worker.on('message', handler);
        worker.once('error', errorHandler);
        worker.once('exit', exitHandler);
        sendNextSubBatch();
      });
    });

    try {
      return await Promise.all(promises);
    } catch (err) {
      const oldWorkers = workers.splice(0);
      workerStartupDurationsMs.length = 0;
      await Promise.allSettled(oldWorkers.map((worker) => worker.terminate()));
      for (let i = 0; i < size; i++) {
        workers.push(spawnWorker(i));
      }
      throw err;
    }
  };

  const terminate = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.terminate()));
    workers.length = 0;
  };

  return { dispatch, terminate, size, isolation, startupDurationMs, workerStartupDurationsMs };
};
