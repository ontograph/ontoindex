/**
 * U6 — Sequential-fallback cleanup safety.
 *
 * Verifies that `runChunkedParseAndResolve` runs its cleanup steps
 * (`astCache.clear()`, `bindingAccumulator.finalize()`,
 * `enrichExportedTypeMap`) even when the sequential-fallback loop throws
 * mid-iteration. These tests exercise the try/finally added in U6.
 *
 * We drive the sequential fallback by passing `{ skipWorkers: true }` so the
 * worker pool is never created and `sequentialChunkPaths` is populated with
 * every chunk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { processParsing } from '../../src/core/ingestion/parsing-processor.js';

import { SupportedLanguages } from 'ontoindex-shared';

import type { SymbolTableWriter } from '../../src/core/ingestion/model/index.js';
import { restoreSemanticModelRegistrations } from '../../src/core/ingestion/model/semantic-model.js';
import {
  createResolutionContext,
  snapshotImportResolutionState,
} from '../../src/core/ingestion/model/resolution-context.js';
import { BindingAccumulator } from '../../src/core/ingestion/binding-accumulator.js';

import * as heritageProcessor from '../../src/core/ingestion/heritage-processor.js';
import * as parserIdentity from '../../src/core/tree-sitter/parser-identity.js';

type WorkerData = NonNullable<Awaited<ReturnType<typeof processParsing>>>;
const lifetimeConfig: {
  workerData: WorkerData | null;
  setupWorker?: (graph: Parameters<typeof processParsing>[0], symbols: SymbolTableWriter) => void;
  sequentialFetch: boolean;
  recoveryFiles: string[] | null;
  mutateWorkerCalls: boolean;
  terminate: ReturnType<typeof vi.fn>;
} = {
  workerData: null,
  sequentialFetch: false,
  recoveryFiles: null,
  mutateWorkerCalls: false,
  terminate: vi.fn(async () => {}),
};

vi.mock('../../src/core/ingestion/workers/worker-pool.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/workers/worker-pool.js')>();
  return {
    ...actual,
    createWorkerPool: (...args: Parameters<typeof actual.createWorkerPool>) =>
      lifetimeConfig.workerData || lifetimeConfig.recoveryFiles
        ? { size: 1, isolation: 'thread', terminate: lifetimeConfig.terminate }
        : actual.createWorkerPool(...args),
  };
});

vi.mock('../../src/core/ingestion/parsing-processor.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/parsing-processor.js')>();
  return {
    ...actual,
    processParsing: (...args: Parameters<typeof actual.processParsing>) => {
      if (lifetimeConfig.recoveryFiles) {
        lifetimeConfig.setupWorker?.(args[0], args[3] as SymbolTableWriter);
        lifetimeConfig.recoveryFiles.length = 0;
        return Promise.resolve(null);
      }
      if (lifetimeConfig.workerData) {
        lifetimeConfig.setupWorker?.(args[0], args[3] as SymbolTableWriter);
        return Promise.resolve(lifetimeConfig.workerData);
      }
      return actual.processParsing(...args);
    },
  };
});

// Spies captured from the module mocks below — populated per-test.
const spies = {
  astCacheClearCalls: 0,
  resetSpies() {
    this.astCacheClearCalls = 0;
  },
};

// Controls which dependency throws for a given test.
// `readFileContentsFailAfter`: call count threshold — fail once the N-th call
// is reached. The first `readFileContents` call happens in the outer
// worker/parse loop (before sequential fallback); we want to fail only on the
// second call (inside the fallback) so the U6 try/finally is exercised.
const failureConfig: {
  readFileContentsFailAfter: number;
  readFileContentsCalls: number;
  processCalls: boolean;
  callsIncomplete: boolean;
} = {
  readFileContentsFailAfter: Infinity,
  readFileContentsCalls: 0,
  processCalls: false,
  callsIncomplete: false,
};

vi.mock('../../src/core/ingestion/filesystem-walker.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/filesystem-walker.js')>();
  return {
    ...actual,
    readFileContents: vi.fn(async (repoPath: string, chunkPaths: string[]) => {
      failureConfig.readFileContentsCalls += 1;
      if (failureConfig.readFileContentsCalls >= failureConfig.readFileContentsFailAfter) {
        throw new Error('injected readFileContents failure');
      }
      return actual.readFileContents(repoPath, chunkPaths);
    }),
  };
});

vi.mock('../../src/core/ingestion/call-processor.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/call-processor.js')>();
  return {
    ...actual,
    processCalls: vi.fn(async (...args: unknown[]) => {
      if (failureConfig.processCalls) {
        throw new Error('injected processCalls failure');
      }
      if (failureConfig.callsIncomplete) {
        (args[15] as (() => void) | undefined)?.();
        return [];
      }
      // Delegate to original
      return (actual.processCalls as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
    }),
    processCallsFromExtracted: vi.fn(
      async (...args: Parameters<typeof actual.processCallsFromExtracted>) => {
        if (lifetimeConfig.mutateWorkerCalls) {
          for (const call of args[1]) {
            call.receiverTypeName = 'EnrichedReceiver';
            if (call.receiverMixedChain?.[0]) call.receiverMixedChain[0].name = 'enriched';
            if (call.argTypes) call.argTypes[0] = 'enriched';
          }
        }
        return actual.processCallsFromExtracted(...args);
      },
    ),
    extractFetchCallsFromFiles: (...args: Parameters<typeof actual.extractFetchCallsFromFiles>) =>
      lifetimeConfig.sequentialFetch
        ? Promise.resolve([{ filePath: 'a.ts', fetchURL: '/fixture', lineNumber: 1 }])
        : actual.extractFetchCallsFromFiles(...args),
  };
});

// Wrap createASTCache so we can count clear() calls across all cache instances.
vi.mock('../../src/core/ingestion/ast-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/ingestion/ast-cache.js')>();
  return {
    ...actual,
    createASTCache: (max?: number) => {
      const cache = actual.createASTCache(max);
      const origClear = cache.clear.bind(cache);
      cache.clear = () => {
        spies.astCacheClearCalls += 1;
        origClear();
      };
      return cache;
    },
  };
});

// Import after the mocks so bindings reference the wrapped versions.
const { runChunkedParseAndResolve } =
  await import('../../src/core/ingestion/pipeline-phases/parse-impl.js');
const { createKnowledgeGraph } = await import('../../src/core/graph/graph.js');

function makeTempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-impl-fallback-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function scanned(repo: string, files: string[]) {
  return files.map((rel) => ({
    path: rel,
    size: fs.statSync(path.join(repo, rel)).size,
  }));
}

describe('parse-impl sequential fallback cleanup (U6)', () => {
  let repoPath = '';

  beforeEach(() => {
    spies.resetSpies();
    failureConfig.readFileContentsFailAfter = Infinity;
    failureConfig.readFileContentsCalls = 0;
    failureConfig.processCalls = false;
    repoPath = makeTempRepo({
      'a.ts': `export function foo() { return 1; }\n`,
      'b.ts': `import { foo } from './a';\nexport function bar() { return foo(); }\n`,
    });
  });

  afterEach(() => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('happy path: sequential fallback completes and bindingAccumulator is finalized', async () => {
    const graph = createKnowledgeGraph();
    const files = ['a.ts', 'b.ts'];
    const result = await runChunkedParseAndResolve(
      graph,
      scanned(repoPath, files),
      files,
      files.length,
      repoPath,
      Date.now(),
      () => {},
      { skipWorkers: true },
    );
    // Happy path — should return a BindingAccumulator and clear astCache at
    // least once (per-chunk + finally).
    expect(result.bindingAccumulator).toBeDefined();
    expect(spies.astCacheClearCalls).toBeGreaterThanOrEqual(1);
    // finalize() on a BindingAccumulator makes it read-only; appending after
    // finalize throws. We use that to prove finalize actually ran.
    expect(() =>
      result.bindingAccumulator.appendFile('after.ts', [
        { scope: '', varName: 'x', typeName: 'number' },
      ]),
    ).toThrow();
  });

  it('does not cap oversized parseable files by default', async () => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
    repoPath = makeTempRepo({
      'small.ts': `export function small() { return 1; }\n`,
      'large.js': `export function large() { return "${'x'.repeat(2048)}"; }\n`,
    });

    const originalMin = process.env.ONTOINDEX_LARGE_REPO_PARSE_CAP_MIN_KB;
    const originalMax = process.env.ONTOINDEX_LARGE_REPO_PARSE_MAX_FILE_KB;
    process.env.ONTOINDEX_LARGE_REPO_PARSE_CAP_MIN_KB = '1';
    delete process.env.ONTOINDEX_LARGE_REPO_PARSE_MAX_FILE_KB;

    const telemetry: any[] = [];
    try {
      const graph = createKnowledgeGraph();
      const files = ['small.ts', 'large.js'];
      await runChunkedParseAndResolve(
        graph,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: true,
          onTelemetry: (event) => telemetry.push(event),
        },
      );

      const parsePlan = telemetry.find((event) => event.event === 'parse-plan');
      expect(parsePlan?.totalParseableFiles).toBe(2);
      expect(parsePlan?.totalParseableBytes).toBeGreaterThan(2048);
      expect(telemetry.some((event) => event.event === 'parse-degraded-files')).toBe(false);
      expect(graph.nodes.some((node) => node.properties?.name === 'large')).toBe(true);
    } finally {
      if (originalMin === undefined) {
        delete process.env.ONTOINDEX_LARGE_REPO_PARSE_CAP_MIN_KB;
      } else {
        process.env.ONTOINDEX_LARGE_REPO_PARSE_CAP_MIN_KB = originalMin;
      }
      if (originalMax === undefined) {
        delete process.env.ONTOINDEX_LARGE_REPO_PARSE_MAX_FILE_KB;
      } else {
        process.env.ONTOINDEX_LARGE_REPO_PARSE_MAX_FILE_KB = originalMax;
      }
    }
  });

  it('ignores the retired large-repo per-file parse cap override', async () => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
    repoPath = makeTempRepo({
      'small.ts': `export function small() { return 1; }\n`,
      'large.js': `export function large() { return "${'x'.repeat(2048)}"; }\n`,
    });

    const originalMin = process.env.ONTOINDEX_LARGE_REPO_PARSE_CAP_MIN_KB;
    const originalMax = process.env.ONTOINDEX_LARGE_REPO_PARSE_MAX_FILE_KB;
    process.env.ONTOINDEX_LARGE_REPO_PARSE_CAP_MIN_KB = '1';
    process.env.ONTOINDEX_LARGE_REPO_PARSE_MAX_FILE_KB = '1';

    const telemetry: any[] = [];
    try {
      const graph = createKnowledgeGraph();
      const files = ['small.ts', 'large.js'];
      await runChunkedParseAndResolve(
        graph,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: true,
          onTelemetry: (event) => telemetry.push(event),
        },
      );

      const parsePlan = telemetry.find((event) => event.event === 'parse-plan');
      expect(parsePlan?.totalParseableFiles).toBe(2);
      expect(parsePlan?.totalParseableBytes).toBeGreaterThan(2048);
      expect(telemetry.some((event) => event.event === 'parse-degraded-files')).toBe(false);
      expect(graph.nodes.some((node) => node.properties?.name === 'large')).toBe(true);
    } finally {
      if (originalMin === undefined) {
        delete process.env.ONTOINDEX_LARGE_REPO_PARSE_CAP_MIN_KB;
      } else {
        process.env.ONTOINDEX_LARGE_REPO_PARSE_CAP_MIN_KB = originalMin;
      }
      if (originalMax === undefined) {
        delete process.env.ONTOINDEX_LARGE_REPO_PARSE_MAX_FILE_KB;
      } else {
        process.env.ONTOINDEX_LARGE_REPO_PARSE_MAX_FILE_KB = originalMax;
      }
    }
  });

  it('per-file AST node guard skips compact pathological trees', async () => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
    repoPath = makeTempRepo({
      'guarded.ts': Array.from({ length: 25 }, (_, i) => `export const v${i} = ${i};`).join('\n'),
    });

    const originalMaxAstNodes = process.env.ONTOINDEX_PARSE_MAX_AST_NODES;
    process.env.ONTOINDEX_PARSE_MAX_AST_NODES = '5';
    const telemetry: any[] = [];

    try {
      const graph = createKnowledgeGraph();
      const files = ['guarded.ts'];
      const result = await runChunkedParseAndResolve(
        graph,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: true,
          onTelemetry: (event) => telemetry.push(event),
          scopeRetention: {
            deadline: Date.now() + 30_000,
            artifactAllowance: { remainingBytes: 1024 * 1024 },
            consume: async () => {},
          },
        },
      );

      expect(graph.nodeCount).toBe(0);
      expect(telemetry.filter((event) => event.event === 'parse-degraded-files')).toEqual([
        expect.objectContaining({
          degradedAction: 'lightweight-fallback',
          degradedFiles: [expect.objectContaining({ filePath: 'guarded.ts' })],
        }),
      ]);
      expect(telemetry.some((event) => event.event === 'parse-error-files')).toBe(false);
      expect(result.scopeRetention!.status).toBe('incomplete');
      expect(
        Object.values(result.scopeRetention!.producerCompletion).every((complete) => !complete),
      ).toBe(true);
      result.resolutionContext.clear();
      result.bindingAccumulator.dispose();
      await result.scopeRetention?.dispose();
      expect(spies.astCacheClearCalls).toBeGreaterThanOrEqual(1);
    } finally {
      if (originalMaxAstNodes === undefined) {
        delete process.env.ONTOINDEX_PARSE_MAX_AST_NODES;
      } else {
        process.env.ONTOINDEX_PARSE_MAX_AST_NODES = originalMaxAstNodes;
      }
    }
  });

  it('per-file AST depth guard skips deeply nested trees', async () => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
    repoPath = makeTempRepo({
      'deep.ts': `export function deep() { return (((((((1))))))); }\n`,
    });

    const originalMaxAstDepth = process.env.ONTOINDEX_PARSE_MAX_AST_DEPTH;
    process.env.ONTOINDEX_PARSE_MAX_AST_DEPTH = '3';
    const telemetry: any[] = [];

    try {
      const graph = createKnowledgeGraph();
      const files = ['deep.ts'];
      await runChunkedParseAndResolve(
        graph,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        { skipWorkers: true, onTelemetry: (event) => telemetry.push(event) },
      );

      expect(graph.nodeCount).toBe(0);
      expect(telemetry.filter((event) => event.event === 'parse-degraded-files')).toEqual([
        expect.objectContaining({
          degradedAction: 'lightweight-fallback',
          degradedFiles: [expect.objectContaining({ filePath: 'deep.ts' })],
        }),
      ]);
      expect(telemetry.some((event) => event.event === 'parse-error-files')).toBe(false);
      expect(spies.astCacheClearCalls).toBeGreaterThanOrEqual(1);
    } finally {
      if (originalMaxAstDepth === undefined) {
        delete process.env.ONTOINDEX_PARSE_MAX_AST_DEPTH;
      } else {
        process.env.ONTOINDEX_PARSE_MAX_AST_DEPTH = originalMaxAstDepth;
      }
    }
  });

  it('error path: readFileContents throws mid-fallback — astCache is cleared and finalize runs', async () => {
    const graph = createKnowledgeGraph();
    const files = ['a.ts', 'b.ts'];
    // Fail the second readFileContents call — first call is in the outer
    // worker/parse loop, second is inside the sequential fallback.
    failureConfig.readFileContentsFailAfter = 2;

    const clearsBefore = spies.astCacheClearCalls;
    await expect(
      runChunkedParseAndResolve(
        graph,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        { skipWorkers: true },
      ),
    ).rejects.toThrow(/injected readFileContents failure/);

    // Finally-block must have cleared astCache at least once on the error path.
    expect(spies.astCacheClearCalls).toBeGreaterThan(clearsBefore);
  });

  it('error path: processCalls throws in fallback loop — cleanup still runs', async () => {
    const graph = createKnowledgeGraph();
    const files = ['a.ts', 'b.ts'];
    failureConfig.processCalls = true;

    const clearsBefore = spies.astCacheClearCalls;
    await expect(
      runChunkedParseAndResolve(
        graph,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        { skipWorkers: true },
      ),
    ).rejects.toThrow(/injected processCalls failure/);

    // astCache.clear() must have run in the finally block.
    expect(spies.astCacheClearCalls).toBeGreaterThan(clearsBefore);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('parse-impl stage I/O lifetime', () => {
  let repoPath: string;
  let stageDirs: string[];

  beforeEach(() => {
    spies.resetSpies();
    failureConfig.readFileContentsFailAfter = Infinity;
    failureConfig.readFileContentsCalls = 0;
    failureConfig.processCalls = false;
    lifetimeConfig.sequentialFetch = false;
    lifetimeConfig.terminate.mockClear();
    lifetimeConfig.workerData = {
      imports: [],
      calls: [],
      assignments: [],
      heritage: [],
      routes: [],
      fetchCalls: [{ filePath: 'a.ts', fetchURL: '/fixture', lineNumber: 1 }],
      decoratorRoutes: [],
      toolDefs: [{ filePath: 'a.ts', toolName: 'fixture', description: '', lineNumber: 1 }],
      ormQueries: [],
      constructorBindings: [],
      fileScopeBindings: [],
      fileTimings: [],
      parseErrorPaths: [],
      extractorTimings: [],
    };
    repoPath = makeTempRepo({ 'a.ts': 'export const fixture = 1;\n' });
    stageDirs = [];
    const mkdtemp = fs.promises.mkdtemp.bind(fs.promises);
    vi.spyOn(fs.promises, 'mkdtemp').mockImplementation(async (...args) => {
      const dir = await mkdtemp(...args);
      if (typeof dir === 'string' && path.basename(dir).startsWith('ontoindex-parse-')) {
        stageDirs.push(dir);
      }
      return dir;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    lifetimeConfig.workerData = null;
    lifetimeConfig.recoveryFiles = null;
    lifetimeConfig.sequentialFetch = false;
    for (const dir of [...stageDirs, repoPath]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function run() {
    return runChunkedParseAndResolve(
      createKnowledgeGraph(),
      scanned(repoPath, ['a.ts']),
      ['a.ts'],
      1,
      repoPath,
      Date.now(),
      () => {},
      lifetimeConfig.workerData
        ? { workerThresholdsForTest: { minFiles: 1, minBytes: 0 } }
        : { skipWorkers: true },
    );
  }

  for (const operation of ['append', 'drain'] as const) {
    it(`waits for a delayed sibling ${operation} before disposing after rejection`, async () => {
      const gate = deferred();
      const started = deferred();
      const failure = new Error(`${operation} failed`);
      const rm = vi.spyOn(fs.promises, 'rm');
      const isFetch = (file: unknown) => String(file).includes('parse-fetch-calls-');
      const isTool = (file: unknown) => String(file).includes('parse-tool-defs-');
      if (operation === 'append') {
        const appendFile = fs.promises.appendFile.bind(fs.promises);
        vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (...args) => {
          if (isFetch(args[0])) throw failure;
          if (isTool(args[0])) {
            started.resolve();
            await gate.promise;
          }
          return appendFile(...args);
        });
      } else {
        const readFile = fs.promises.readFile.bind(fs.promises);
        vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
          if (isFetch(args[0])) throw failure;
          if (isTool(args[0])) {
            started.resolve();
            await gate.promise;
          }
          return readFile(...args);
        });
      }
      const outcome = run().then(
        () => ({ failed: false, reason: undefined }),
        (reason: unknown) => ({ failed: true, reason }),
      );
      try {
        await started.promise;
        // Flush rejection continuations while the sibling remains pending.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(rm).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        await outcome;
      }
      expect(await outcome).toEqual({ failed: true, reason: failure });
      expect(rm).toHaveBeenCalledTimes(2);
      expect(lifetimeConfig.terminate).toHaveBeenCalledOnce();
    });
  }

  it('awaits every removal and surfaces cleanup-only rejection', async () => {
    const gate = deferred();
    const started = deferred();
    const failure = new Error('removal failed');
    const rm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (...args) => {
      if (String(args[0]).includes('parse-fetch-calls-')) throw failure;
      if (String(args[0]).includes('parse-tool-defs-')) {
        started.resolve();
        await gate.promise;
      }
      return rm(...args);
    });
    let settled = false;
    const outcome = run().then(
      () => {
        settled = true;
        return { failed: false, reason: undefined };
      },
      (reason: unknown) => {
        settled = true;
        return { failed: true, reason };
      },
    );
    try {
      await started.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      gate.resolve();
      await outcome;
    }
    expect(await outcome).toEqual({ failed: true, reason: failure });
  });

  it.each([new Error('primary append failure'), undefined])(
    'preserves primary rejection %s over stage cleanup rejection and terminates workers',
    async (primary) => {
      vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(primary);
      const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('cleanup failed'));
      const outcome = await run().then(
        () => ({ failed: false, reason: undefined }),
        (reason: unknown) => ({ failed: true, reason }),
      );
      expect(outcome).toEqual({ failed: true, reason: primary });
      expect(rm).toHaveBeenCalledTimes(2);
      expect(lifetimeConfig.terminate).toHaveBeenCalledOnce();
      expect(lifetimeConfig.terminate.mock.invocationCallOrder[0]).toBeLessThan(
        rm.mock.invocationCallOrder[0],
      );
    },
  );

  it('clears the sequential cache before stage disposal even when both append and removal reject', async () => {
    lifetimeConfig.workerData = null;
    lifetimeConfig.sequentialFetch = true;
    const primary = new Error('sequential append failed');
    let clearsAtAppend = 0;
    vi.spyOn(fs.promises, 'appendFile').mockImplementation(async () => {
      clearsAtAppend = spies.astCacheClearCalls;
      throw primary;
    });
    const rm = vi.spyOn(fs.promises, 'rm').mockImplementation(async () => {
      expect(spies.astCacheClearCalls).toBeGreaterThan(clearsAtAppend);
      throw new Error('cleanup failed');
    });
    const outcome = await run().then(
      () => ({ failed: false, reason: undefined }),
      (reason: unknown) => ({ failed: true, reason }),
    );
    expect(outcome).toEqual({ failed: true, reason: primary });
    expect(rm).toHaveBeenCalledOnce();
    expect(spies.astCacheClearCalls).toBeGreaterThan(clearsAtAppend);
  });
});

describe('parse-impl extensionless shebang agreement', () => {
  let repoPath = '';

  beforeEach(() => {
    failureConfig.readFileContentsFailAfter = Infinity;
    failureConfig.readFileContentsCalls = 0;
    failureConfig.processCalls = false;
  });

  afterEach(() => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  // Parent scan attaches `shebangLanguage`; runChunkedParseAndResolve must keep
  // the file and the sequential parser must agree via getLanguageFromShebang.
  const scannedWithShebang = (
    repo: string,
    files: {
      rel: string;
      shebangLanguage?: import('ontoindex-shared').SupportedLanguages | null;
    }[],
  ) =>
    files.map(({ rel, shebangLanguage }) => ({
      path: rel,
      size: fs.statSync(path.join(repo, rel)).size,
      ...(shebangLanguage !== undefined ? { shebangLanguage } : {}),
    }));

  it('parses an extensionless Python script the parent tagged from its shebang', async () => {
    repoPath = makeTempRepo({
      manage: '#!/usr/bin/env python3\ndef shebang_parent_py():\n    return 1\n',
    });
    const graph = createKnowledgeGraph();
    const result = await runChunkedParseAndResolve(
      graph,
      scannedWithShebang(repoPath, [{ rel: 'manage', shebangLanguage: SupportedLanguages.Python }]),
      ['manage'],
      1,
      repoPath,
      Date.now(),
      () => {},
      { skipWorkers: true },
    );
    expect(result.bindingAccumulator).toBeDefined();
    expect(graph.nodes.map((n) => n.properties.name)).toContain('shebang_parent_py');
  });

  it('produces no nodes for an extensionless shell script (shell is unsupported)', async () => {
    repoPath = makeTempRepo({ deploy: '#!/bin/bash\ndeploy() { echo hi; }\n' });
    const graph = createKnowledgeGraph();
    // Even if a scan entry existed, the parent never tags shell, and the
    // sequential parser has no shell language — nothing is parsed.
    await runChunkedParseAndResolve(
      graph,
      scannedWithShebang(repoPath, [{ rel: 'deploy' }]),
      ['deploy'],
      1,
      repoPath,
      Date.now(),
      () => {},
      { skipWorkers: true },
    );
    expect(graph.nodeCount).toBe(0);
  });
});

describe('parse-impl scope retention capture', () => {
  let repoPath = '';

  beforeEach(() => {
    failureConfig.callsIncomplete = false;
    failureConfig.readFileContentsFailAfter = Infinity;
    failureConfig.readFileContentsCalls = 0;
    failureConfig.processCalls = false;
    spies.resetSpies();
    lifetimeConfig.workerData = null;
    lifetimeConfig.recoveryFiles = null;
    lifetimeConfig.mutateWorkerCalls = false;
    repoPath = makeTempRepo({ 'a.ts': 'export function sample() { return 1; }\n' });
  });

  afterEach(() => {
    failureConfig.callsIncomplete = false;
    lifetimeConfig.workerData = null;
    lifetimeConfig.recoveryFiles = null;
    lifetimeConfig.mutateWorkerCalls = false;
    lifetimeConfig.setupWorker = undefined;
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it.each([
    'json',
    'recognized',
    'shebang',
    'skipped',
    'parse-error',
    'degraded',
    'lightweight',
  ] as const)('preserves %s discovery in retained extraction inventory', async (mode) => {
    const extra =
      mode === 'json'
        ? 'package.json'
        : mode === 'recognized'
          ? 'extra.py'
          : mode === 'shebang'
            ? 'script'
            : 'large.ts';
    fs.writeFileSync(
      path.join(repoPath, extra),
      mode === 'json' ? '{"name":"fixture"}' : 'print(1)',
    );
    lifetimeConfig.workerData = {
      imports: [],
      calls: [],
      assignments: [],
      heritage: [],
      routes: [],
      fetchCalls: [],
      decoratorRoutes: [],
      toolDefs: [],
      ormQueries: [],
      constructorBindings: [],
      fileScopeBindings: [],
      fileTimings: [],
      parseErrorPaths: [],
      extractorTimings: [],
    };
    if (mode === 'parse-error') lifetimeConfig.workerData.parseErrorPaths.push(extra);
    if (mode === 'degraded')
      lifetimeConfig.workerData.degraded = true as unknown as NonNullable<WorkerData['degraded']>;
    if (mode === 'lightweight')
      lifetimeConfig.workerData.fileTimings.push({
        filePath: extra,
        language: SupportedLanguages.Python,
        durationMs: 1,
        status: 'skipped',
      });
    const telemetry: any[] = [];
    const files = scanned(repoPath, mode === 'skipped' ? ['a.ts'] : ['a.ts', extra]);
    if (mode === 'shebang')
      Object.assign(files[1]!, { shebangLanguage: SupportedLanguages.Python });
    const result = await runChunkedParseAndResolve(
      createKnowledgeGraph(),
      files,
      mode === 'skipped' ? ['a.ts'] : ['a.ts', extra],
      2,
      repoPath,
      Date.now(),
      () => {},
      {
        workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
        onTelemetry: (event) => telemetry.push(event),
        scopeRetention: {
          deadline: Date.now() + 30_000,
          artifactAllowance: { remainingBytes: 1024 * 1024 },
          consume: async () => {},
        },
      },
      mode === 'skipped' ? [{ path: extra, size: 100_000_000 }] : [],
    );
    try {
      if (mode === 'skipped')
        expect(result.scopeRetention!.discovery!.skipped).toContainEqual({
          path: extra,
          size: 100_000_000,
        });
      else expect(result.scopeRetention!.discovery!.allPaths).toContain(extra);
      expect(result.scopeRetention!.inventory.map((file) => file.filePath).includes(extra)).toBe(
        mode !== 'json',
      );
      const incomplete =
        mode === 'skipped' ||
        mode === 'parse-error' ||
        mode === 'degraded' ||
        mode === 'lightweight';
      expect(result.scopeRetention!.status).toBe(incomplete ? 'incomplete' : 'retained');
      expect(result.scopeRetention!.producerCompletion.heritage).toBe(!incomplete);
      if (mode === 'lightweight') {
        expect(telemetry.filter((event) => event.event === 'parse-degraded-files')).toEqual([
          expect.objectContaining({
            degradedAction: 'lightweight-fallback',
            degradedFiles: [expect.objectContaining({ filePath: extra })],
          }),
        ]);
        expect(telemetry.some((event) => event.event === 'parse-error-files')).toBe(false);
        expect(
          Object.values(result.scopeRetention!.producerCompletion).every((complete) => !complete),
        ).toBe(true);
      }
      expect(result.scopeRetention!.seedReady).toBe(false);
    } finally {
      result.resolutionContext.clear();
      result.bindingAccumulator.dispose();
      await result.scopeRetention?.dispose();
    }
  });

  it.each(['success', 'finalize failure', 'cancel'] as const)(
    'reports observed empty producer completion after %s',
    async (outcome) => {
      lifetimeConfig.workerData = {
        imports: [],
        calls: [],
        assignments: [],
        heritage: [],
        routes: [],
        fetchCalls: [],
        decoratorRoutes: [],
        toolDefs: [],
        ormQueries: [],
        constructorBindings: [],
        fileScopeBindings: [],
        fileTimings: [],
        parseErrorPaths: [],
        extractorTimings: [],
      };
      const controller = new AbortController();
      const original = BindingAccumulator.prototype.finalize;
      const finalize = vi.spyOn(BindingAccumulator.prototype, 'finalize');
      if (outcome === 'finalize failure')
        finalize.mockImplementation(() => {
          throw new Error('injected finalization failure');
        });
      if (outcome === 'cancel') {
        finalize.mockImplementation(function (this: BindingAccumulator) {
          controller.abort();
          return original.call(this);
        });
      }
      let result: Awaited<ReturnType<typeof runChunkedParseAndResolve>> | undefined;
      try {
        result = await runChunkedParseAndResolve(
          createKnowledgeGraph(),
          scanned(repoPath, ['a.ts']),
          ['a.ts'],
          1,
          repoPath,
          Date.now(),
          () => {},
          {
            workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
            scopeRetention: {
              deadline: Date.now() + 30_000,
              signal: controller.signal,
              artifactAllowance: { remainingBytes: 1024 * 1024 },
              consume: async () => {},
            },
          },
        );
        const retained = result.scopeRetention!;
        if (outcome === 'success') {
          expect(retained.producerCompletion).toEqual({
            calls: true,
            heritage: true,
            assignments: true,
            'constructor-bindings': true,
            'exported-types': true,
            'file-bindings': true,
            'model-registrations': true,
            'import-states': true,
            'graph-nodes': true,
            'graph-relationships': true,
            'orm-queries': true,
            'fetch-calls': true,
            routes: true,
            'decorator-routes': true,
            'tool-definitions': true,
          });
          expect(retained.callRecordCount).toBe(0);
          expect(retained.assignmentRecordCount).toBe(0);
          expect(retained.fileBindingRecordCount).toBe(0);
        } else {
          expect(Object.values(retained.producerCompletion).every((value) => !value)).toBe(true);
          expect(retained.reasons).toContain(
            outcome === 'cancel' ? 'cancelled' : 'file-bindings-producer-incomplete',
          );
        }
        expect(retained.seedReady).toBe(false);
      } finally {
        finalize.mockRestore();
        await result?.scopeRetention?.dispose();
        result?.bindingAccumulator.dispose();
      }
    },
  );

  it('retains original worker receiver evidence before call enrichment and cleanup', async () => {
    const call: WorkerData['calls'][number] = {
      filePath: 'a.ts',
      calledName: 'save',
      sourceId: 'Function:a.ts:caller',
      callForm: 'member',
      argCount: 2,
      receiverName: 'service',
      receiverMixedChain: [{ kind: 'call', name: 'getUser' }],
      argTypes: [undefined, 'string'],
    };
    const expected = structuredClone(call);
    lifetimeConfig.workerData = {
      imports: [],
      calls: [call],
      assignments: [],
      heritage: [],
      routes: [],
      fetchCalls: [],
      decoratorRoutes: [],
      toolDefs: [],
      ormQueries: [],
      constructorBindings: [],
      fileScopeBindings: [],
      fileTimings: [],
      parseErrorPaths: [],
      extractorTimings: [],
    };
    lifetimeConfig.mutateWorkerCalls = true;
    const allowance = { remainingBytes: 1024 * 1024 };
    const result = await runChunkedParseAndResolve(
      createKnowledgeGraph(),
      scanned(repoPath, ['a.ts']),
      ['a.ts'],
      1,
      repoPath,
      Date.now(),
      () => {},
      {
        workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
        scopeRetention: {
          deadline: Date.now() + 30_000,
          artifactAllowance: allowance,
          consume: async () => {},
        },
      },
    );
    try {
      expect(call.receiverTypeName).toBe('EnrichedReceiver');
      expect(call.receiverMixedChain![0]!.name).toBe('enriched');
      expect(lifetimeConfig.workerData.calls).toEqual([]);
      expect(result.scopeRetention).toBeDefined();
      const calls: WorkerData['calls'] = [];
      for await (const batch of result.scopeRetention!.iterateCalls()) calls.push(...batch);
      expect(calls).toEqual([expected]);
      expect(Object.hasOwn(calls[0]!, 'receiverTypeName')).toBe(false);
      expect(result.scopeRetention!.callRecordCount).toBe(1);
      expect(result.scopeRetention!.callEvidenceScope).toBe('observed-parser-inputs');
      expect(result.scopeRetention!.seedReady).toBe(false);
    } finally {
      await result.scopeRetention?.dispose();
      result.bindingAccumulator.dispose();
    }
    expect(allowance.remainingBytes).toBe(1024 * 1024);
  });

  it.each(['graph reconstruction', 'final binding enrichment'] as const)(
    'retains nonempty worker exports after %s',
    async (source) => {
      const exportName = source === 'graph reconstruction' ? 'makeService' : 'service';
      const nodeType = source === 'graph reconstruction' ? 'Function' : 'Const';
      const nodeId = `${nodeType}:a.ts:${exportName}`;
      lifetimeConfig.workerData = {
        imports: [],
        calls: [],
        assignments: [],
        heritage: [],
        routes: [],
        fetchCalls: [],
        decoratorRoutes: [],
        toolDefs: [],
        ormQueries: [],
        constructorBindings: [],
        fileScopeBindings:
          source === 'final binding enrichment'
            ? [{ filePath: 'a.ts', bindings: [['service', 'Service']] }]
            : [],
        fileTimings: [],
        parseErrorPaths: [],
        extractorTimings: [],
      };
      lifetimeConfig.setupWorker = (graph, symbols) => {
        graph.addNode({
          id: nodeId,
          label: nodeType,
          properties: { name: exportName, filePath: 'a.ts', isExported: true },
        });
        symbols.add(
          'a.ts',
          exportName,
          nodeId,
          nodeType,
          source === 'graph reconstruction' ? { returnType: 'Service' } : undefined,
        );
      };
      const allowance = { remainingBytes: 1024 * 1024 };
      const result = await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        scanned(repoPath, ['a.ts']),
        ['a.ts'],
        1,
        repoPath,
        Date.now(),
        () => {},
        {
          workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
          scopeRetention: {
            deadline: Date.now() + 30_000,
            artifactAllowance: allowance,
            consume: async () => {},
          },
        },
      );
      try {
        expect(result.usedWorkerPool).toBe(true);
        expect(lifetimeConfig.workerData.fileScopeBindings).toEqual([]);
        const replayed = [];
        for await (const batch of result.scopeRetention!.iterateExportedTypes())
          replayed.push(...batch);
        expect(replayed).toEqual([{ filePath: 'a.ts', exportName, typeName: 'Service' }]);
        expect(replayed).toEqual(
          [...result.exportedTypeMap].flatMap(([filePath, exports]) =>
            [...exports].map(([exportName, typeName]) => ({ filePath, exportName, typeName })),
          ),
        );
        result.exportedTypeMap.get('a.ts')!.set(exportName, 'Changed');
        result.exportedTypeMap.clear();
        const replayedAgain = [];
        for await (const batch of result.scopeRetention!.iterateExportedTypes())
          replayedAgain.push(...batch);
        expect(replayedAgain).toEqual(replayed);
        expect(result.scopeRetention!.seedReady).toBe(false);
      } finally {
        await result.scopeRetention?.dispose();
        result.bindingAccumulator.dispose();
      }
      expect(allowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it.each(['worker', 'sequential', 'recovery'] as const)(
    'retains %s finalized file bindings including unexported values',
    async (mode) => {
      fs.writeFileSync(path.join(repoPath, 'a.ts'), 'const hidden: Service = missing;\n');
      const fileScopeBindings: WorkerData['fileScopeBindings'] = [
        { filePath: 'a.ts', bindings: [['hidden', 'Service']] },
      ];
      if (mode === 'worker')
        lifetimeConfig.workerData = {
          imports: [],
          calls: [],
          assignments: [],
          heritage: [],
          routes: [],
          fetchCalls: [],
          decoratorRoutes: [],
          toolDefs: [],
          ormQueries: [],
          constructorBindings: [],
          fileScopeBindings,
          fileTimings: [],
          parseErrorPaths: [],
          extractorTimings: [],
        };
      if (mode === 'recovery') lifetimeConfig.recoveryFiles = ['a.ts'];
      if (mode !== 'sequential')
        lifetimeConfig.setupWorker = (_graph, symbols) => {
          symbols.add('a.ts', 'WorkerMarker', 'worker-marker', 'Class');
        };
      const allowance = { remainingBytes: 1024 * 1024 };
      const result = await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        scanned(repoPath, ['a.ts']),
        ['a.ts'],
        1,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: mode !== 'worker',
          ...(mode === 'worker' ? { workerThresholdsForTest: { minFiles: 1, minBytes: 0 } } : {}),
          scopeRetention: {
            deadline: Date.now() + 30_000,
            artifactAllowance: allowance,
            consume: async () => {},
          },
        },
      );
      try {
        const replayed = [];
        for await (const batch of result.scopeRetention!.iterateFileBindings())
          replayed.push(...batch);
        expect(replayed).toEqual([{ filePath: 'a.ts', varName: 'hidden', typeName: 'Service' }]);
        expect(result.exportedTypeMap.size).toBe(0);
        if (mode === 'worker') expect(fileScopeBindings).toEqual([]);
        result.bindingAccumulator.dispose();
        const again = [];
        for await (const batch of result.scopeRetention!.iterateFileBindings())
          again.push(...batch);
        expect(again).toEqual(replayed);
        expect(result.scopeRetention!.seedReady).toBe(false);
        const events = [];
        for await (const batch of result.scopeRetention!.iterateModelRegistrations())
          events.push(...batch);
        expect(events.length).toBeGreaterThan(0);
        expect(result.scopeRetention!.modelRegistrationRecordCount).toBe(events.length);
        const restored = restoreSemanticModelRegistrations({ version: 1, events });
        const importStates = [];
        for await (const batch of result.scopeRetention!.iterateImportStates())
          importStates.push(...batch);
        expect(importStates).toEqual([snapshotImportResolutionState(result.resolutionContext)]);
        const replayContext = createResolutionContext({
          model: restored,
          importState: importStates[0]!,
        });
        const names = events.flatMap((event) => (event.kind === 'symbol.add' ? [event.name] : []));
        for (const name of names) {
          expect(restored.symbols.lookupExactAll('a.ts', name)).toEqual(
            result.resolutionContext.model.symbols.lookupExactAll('a.ts', name),
          );
          expect(replayContext.resolve(name, 'a.ts')).toEqual(
            result.resolutionContext.resolve(name, 'a.ts'),
          );
        }
        expect(result.resolutionContext.model.snapshotRegistrations()).toBeUndefined();
      } finally {
        await result.scopeRetention?.dispose();
        result.bindingAccumulator.dispose();
      }
      expect(allowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it.each(['sequential', 'recovery'] as const)(
    'retains the final %s exported-type input separately from lexical exports',
    async (mode) => {
      fs.writeFileSync(
        path.join(repoPath, 'a.ts'),
        'export function makeService(): Service { return undefined as any; }\n',
      );
      if (mode === 'recovery') lifetimeConfig.recoveryFiles = ['a.ts'];
      const result = await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        scanned(repoPath, ['a.ts']),
        ['a.ts'],
        1,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: true,
          scopeRetention: {
            deadline: Date.now() + 30_000,
            artifactAllowance: { remainingBytes: 1024 * 1024 },
            consume: async () => {},
          },
        },
      );
      try {
        const replayed = [];
        for await (const batch of result.scopeRetention!.iterateExportedTypes())
          replayed.push(...batch);
        // The mocked recovery supplies lexical artifacts without rebuilding legacy
        // graph symbols; its downstream type-export input is intentionally empty.
        expect(replayed).toEqual(
          mode === 'sequential'
            ? [{ filePath: 'a.ts', exportName: 'makeService', typeName: 'Service' }]
            : [],
        );
        expect(replayed).toEqual(
          [...result.exportedTypeMap].flatMap(([filePath, exports]) =>
            [...exports].map(([exportName, typeName]) => ({ filePath, exportName, typeName })),
          ),
        );
        result.exportedTypeMap.clear();
        const replayedAgain = [];
        for await (const batch of result.scopeRetention!.iterateExportedTypes())
          replayedAgain.push(...batch);
        expect(replayedAgain).toEqual(replayed);
        expect(result.scopeRetention!.seedReady).toBe(false);
      } finally {
        await result.scopeRetention?.dispose();
        result.bindingAccumulator.dispose();
      }
    },
  );

  it.each(['worker', 'sequential', 'recovery'] as const)(
    'retains %s constructor inputs before producer cleanup',
    async (mode) => {
      fs.writeFileSync(
        path.join(repoPath, 'a.ts'),
        'function caller() { const service = makeService(); service.save(); }\n',
      );
      const constructorBindings: WorkerData['constructorBindings'] = [
        {
          filePath: 'a.ts',
          bindings: [{ scope: 'caller@0', varName: 'service', calleeName: 'makeService' }],
        },
      ];
      const expected = structuredClone(constructorBindings);
      if (mode === 'worker') {
        lifetimeConfig.workerData = {
          imports: [],
          calls: [],
          assignments: [],
          heritage: [],
          routes: [],
          fetchCalls: [],
          decoratorRoutes: [],
          toolDefs: [],
          ormQueries: [],
          constructorBindings,
          fileScopeBindings: [],
          fileTimings: [],
          parseErrorPaths: [],
          extractorTimings: [],
        };
      }
      if (mode === 'recovery') lifetimeConfig.recoveryFiles = ['a.ts'];
      const allowance = { remainingBytes: 1024 * 1024 };
      const result = await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        scanned(repoPath, ['a.ts']),
        ['a.ts'],
        1,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: mode !== 'worker',
          ...(mode === 'worker' ? { workerThresholdsForTest: { minFiles: 1, minBytes: 0 } } : {}),
          scopeRetention: {
            deadline: Date.now() + 30_000,
            artifactAllowance: allowance,
            consume: async () => {},
          },
        },
      );
      try {
        if (mode === 'worker') expect(constructorBindings).toEqual([]);
        const replayed: WorkerData['constructorBindings'] = [];
        for await (const batch of result.scopeRetention!.iterateConstructorBindings())
          replayed.push(...batch);
        expect(replayed).toEqual(expected);
        expect(result.scopeRetention!.constructorBindingRecordCount).toBe(1);
        expect(result.scopeRetention!.seedReady).toBe(false);
      } finally {
        await result.scopeRetention?.dispose();
        result.bindingAccumulator.dispose();
      }
      expect(allowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it.each(['worker', 'sequential'] as const)(
    'retains %s assignments before producer cleanup',
    async (mode) => {
      fs.writeFileSync(
        path.join(repoPath, 'a.ts'),
        [
          'function caller(service: Service) {',
          '  service.value = "typed";',
          '  unknown.value = "unresolved";',
          '}',
        ].join('\n'),
      );
      const assignments: WorkerData['assignments'] = [
        {
          filePath: 'a.ts',
          sourceId: 'Function:a.ts:caller',
          receiverText: 'service',
          propertyName: 'value',
          receiverTypeName: 'Service',
        },
        {
          filePath: 'a.ts',
          sourceId: 'Function:a.ts:caller',
          receiverText: 'unknown',
          propertyName: 'value',
        },
      ];
      const expected = structuredClone(assignments);
      if (mode === 'worker') {
        lifetimeConfig.workerData = {
          imports: [],
          calls: [],
          assignments,
          heritage: [],
          routes: [],
          fetchCalls: [],
          decoratorRoutes: [],
          toolDefs: [],
          ormQueries: [],
          constructorBindings: [],
          fileScopeBindings: [],
          fileTimings: [],
          parseErrorPaths: [],
          extractorTimings: [],
        };
      }
      const allowance = { remainingBytes: 1024 * 1024 };
      const result = await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        scanned(repoPath, ['a.ts']),
        ['a.ts'],
        1,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: mode === 'sequential',
          ...(mode === 'worker' ? { workerThresholdsForTest: { minFiles: 1, minBytes: 0 } } : {}),
          scopeRetention: {
            deadline: Date.now() + 30_000,
            artifactAllowance: allowance,
            consume: async () => {},
          },
        },
      );
      try {
        if (mode === 'worker') {
          expect(assignments).toEqual([]);
          expect(lifetimeConfig.workerData!.assignments).toEqual([]);
        } else {
          expect(spies.astCacheClearCalls).toBeGreaterThan(0);
        }
        const retained = result.scopeRetention!;
        const replayed: WorkerData['assignments'] = [];
        for await (const batch of retained.iterateAssignments()) replayed.push(...batch);
        expect(replayed).toEqual(expected);
        expect(Object.hasOwn(replayed[1]!, 'receiverTypeName')).toBe(false);
        expect(retained.assignmentRecordCount).toBe(2);
        expect(retained.assignmentEvidenceScope).toBe('observed-parser-inputs');
        expect(retained.seedReady).toBe(false);
      } finally {
        await result.scopeRetention?.dispose();
        result.bindingAccumulator.dispose();
      }
      expect(allowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it.each(['worker', 'sequential', 'recovery'] as const)(
    'retains %s heritage once before producer cleanup',
    async (mode) => {
      fs.writeFileSync(path.join(repoPath, 'a.ts'), 'class Base {}\nclass Child extends Base {}\n');
      const heritage: WorkerData['heritage'] = [
        { filePath: 'a.ts', className: 'Child', parentName: 'Base', kind: 'extends' },
      ];
      const expected = structuredClone(heritage);
      if (mode === 'recovery') lifetimeConfig.recoveryFiles = ['a.ts'];
      if (mode === 'worker') {
        lifetimeConfig.workerData = {
          imports: [],
          calls: [],
          assignments: [],
          heritage,
          routes: [],
          fetchCalls: [],
          decoratorRoutes: [],
          toolDefs: [],
          ormQueries: [],
          constructorBindings: [],
          fileScopeBindings: [],
          fileTimings: [],
          parseErrorPaths: [],
          extractorTimings: [],
        };
      }
      const allowance = { remainingBytes: 1024 * 1024 };
      const result = await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        scanned(repoPath, ['a.ts']),
        ['a.ts'],
        1,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: mode === 'sequential',
          ...(mode !== 'sequential'
            ? { workerThresholdsForTest: { minFiles: 1, minBytes: 0 } }
            : {}),
          scopeRetention: {
            deadline: Date.now() + 30_000,
            artifactAllowance: allowance,
            consume: async () => {},
          },
        },
      );
      try {
        if (mode === 'worker') {
          expect(heritage).toEqual([]);
          expect(lifetimeConfig.workerData!.heritage).toEqual([]);
        } else {
          expect(spies.astCacheClearCalls).toBeGreaterThan(0);
        }
        const retained = result.scopeRetention!;
        const replayed: WorkerData['heritage'] = [];
        for await (const batch of retained.iterateHeritage()) replayed.push(...batch);
        expect(replayed).toEqual(expected);
        expect(retained.heritageRecordCount).toBe(1);
        expect(retained.heritageEvidenceScope).toBe('observed-parser-inputs');
        expect(retained.producerCompletion.heritage).toBe(true);
        expect(retained.seedReady).toBe(false);
      } finally {
        await result.scopeRetention?.dispose();
        result.bindingAccumulator.dispose();
      }
      expect(allowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('keeps calls incomplete when the sequential processor reports skipped evidence', async () => {
    failureConfig.callsIncomplete = true;
    let result: Awaited<ReturnType<typeof runChunkedParseAndResolve>> | undefined;
    try {
      result = await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        scanned(repoPath, ['a.ts']),
        ['a.ts'],
        1,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: true,
          scopeRetention: {
            deadline: Date.now() + 30_000,
            artifactAllowance: { remainingBytes: 1024 * 1024 },
            consume: async () => {},
          },
        },
      );
      const retained = result.scopeRetention!;
      expect(retained.producerCompletion.calls).toBe(false);
      expect(retained.reasons).toContain('calls-producer-incomplete');
      expect(retained.callRecordCount).toBe(0);
      expect(retained.seedReady).toBe(false);
    } finally {
      await result?.scopeRetention?.dispose();
      result?.bindingAccumulator.dispose();
    }
  });

  it('keeps heritage incomplete when the sequential prepass swallows an extraction failure', async () => {
    const extract = vi
      .spyOn(heritageProcessor, 'extractExtractedHeritageFromFiles')
      .mockImplementation(async (_files, _cache, onIncomplete) => {
        onIncomplete?.();
        return [];
      });
    let result: Awaited<ReturnType<typeof runChunkedParseAndResolve>> | undefined;
    try {
      result = await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        scanned(repoPath, ['a.ts']),
        ['a.ts'],
        1,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: true,
          scopeRetention: {
            deadline: Date.now() + 30_000,
            artifactAllowance: { remainingBytes: 1024 * 1024 },
            consume: async () => {},
          },
        },
      );
      const retained = result.scopeRetention!;
      expect(extract).toHaveBeenCalledOnce();
      expect(retained.producerCompletion.heritage).toBe(false);
      expect(retained.reasons).toContain('heritage-producer-incomplete');
      expect(retained.heritageRecordCount).toBe(0);
      expect(retained.seedReady).toBe(false);
    } finally {
      extract.mockRestore();
      await result?.scopeRetention?.dispose();
      result?.bindingAccumulator.dispose();
    }
  });

  it.each(
    (['ts', 'tsx', 'js', 'jsx'] as const).flatMap((extension) =>
      (['sequential', 'recovery'] as const).map((mode) => ({ extension, mode })),
    ),
  )(
    'retains unresolved $mode .$extension provider calls once before parser cleanup',
    async ({ extension, mode }) => {
      const filePath = `a.${extension}`;
      fs.writeFileSync(
        path.join(repoPath, filePath),
        [
          'function target() {}',
          'function caller() {',
          '  target();',
          '  missing(unknownArg, "original", 42);',
          '  console.log("builtin");',
          '}',
        ].join('\n') + '\n',
      );
      // Recovery mocks the processParsing handoff into the real sequential call
      // pass; call extraction itself uses the real provider for each grammar.
      if (mode === 'recovery') lifetimeConfig.recoveryFiles = [filePath];
      const allowance = { remainingBytes: 1024 * 1024 };
      const graph = createKnowledgeGraph();
      const result = await runChunkedParseAndResolve(
        graph,
        scanned(repoPath, [filePath]),
        [filePath],
        1,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: true,
          scopeRetention: {
            deadline: Date.now() + 30_000,
            artifactAllowance: allowance,
            consume: async () => {},
          },
        },
      );
      try {
        expect(spies.astCacheClearCalls).toBeGreaterThan(0);
        if (mode === 'recovery') expect(lifetimeConfig.recoveryFiles).toEqual([]);
        const retained = result.scopeRetention!;
        const calls: WorkerData['calls'] = [];
        for await (const batch of retained.iterateCalls()) calls.push(...batch);
        expect(calls).toEqual([
          {
            filePath,
            calledName: 'target',
            sourceId: `Function:${filePath}:caller`,
            atRange: { startLine: 3, endLine: 3, startCol: 2, endCol: 10 },
            callForm: 'free',
            argCount: 0,
          },
          {
            filePath,
            calledName: 'missing',
            sourceId: `Function:${filePath}:caller`,
            atRange: { startLine: 4, endLine: 4, startCol: 2, endCol: 37 },
            callForm: 'free',
            argCount: 3,
            argTypes: [undefined, 'string', 'number'],
          },
        ]);
        expect(retained.callRecordCount).toBe(2);
        expect(retained.callEvidenceScope).toBe('observed-parser-inputs');
        expect(retained.seedReady).toBe(false);
        expect(
          graph.relationships.filter(
            (edge) => edge.type === 'CALLS' && edge.targetId.includes('missing'),
          ),
        ).toEqual([]);
      } finally {
        await result.scopeRetention?.dispose();
        result.bindingAccumulator.dispose();
      }
      expect(allowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it.each(['heritage', 'calls'] as const)(
    'rejects input completeness when the %s reread changes source text',
    async (pass) => {
      lifetimeConfig.recoveryFiles = ['a.ts'];
      const walker = await import('../../src/core/ingestion/filesystem-walker.js');
      const read = vi.mocked(walker.readFileContents);
      const originalImplementation = read.getMockImplementation()!;
      const original = fs.readFileSync(path.join(repoPath, 'a.ts'), 'utf8');
      const changed = 'export function sample() { return 2; }\n';
      const observations =
        pass === 'heritage' ? [original, changed, original] : [original, original, changed];
      for (const content of observations) read.mockResolvedValueOnce(new Map([['a.ts', content]]));
      try {
        const result = await runChunkedParseAndResolve(
          createKnowledgeGraph(),
          scanned(repoPath, ['a.ts']),
          ['a.ts'],
          1,
          repoPath,
          Date.now(),
          () => {},
          {
            skipWorkers: true,
            scopeRetention: {
              deadline: Date.now() + 30_000,
              artifactAllowance: { remainingBytes: 1024 * 1024 },
              consume: async () => {},
            },
          },
        );
        try {
          expect(result.scopeRetention!.status).toBe('retained');
          expect(result.scopeRetention!.inputEvidence.complete).toBe(false);
          expect(result.scopeRetention!.inputEvidence.reasons.length).toBeGreaterThan(0);
          expect(result.scopeRetention!.inputEvidence.sources).toEqual([
            {
              filePath: 'a.ts',
              sha256: createHash('sha256').update(original, 'utf8').digest('hex'),
              byteLength: Buffer.byteLength(original, 'utf8'),
            },
          ]);
        } finally {
          await result.scopeRetention!.dispose();
          result.bindingAccumulator.dispose();
        }
      } finally {
        read.mockReset();
        read.mockImplementation(originalImplementation);
      }
    },
  );

  it('does not create a retention handle by default', async () => {
    const identity = vi.spyOn(parserIdentity, 'workspaceParserIdentity');
    try {
      const result = await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        scanned(repoPath, ['a.ts']),
        ['a.ts'],
        1,
        repoPath,
        Date.now(),
        () => {},
        { skipWorkers: true },
      );
      expect(result.scopeRetention).toBeUndefined();
      expect(identity).not.toHaveBeenCalled();
      result.bindingAccumulator.dispose();
    } finally {
      identity.mockRestore();
    }
  });

  it.each([
    {
      outcome: 'initially unavailable',
      complete: false,
      reason: 'parser-code-identity-unavailable',
    },
    { outcome: 'finally unavailable', complete: false, reason: 'parser-code-identity-unavailable' },
    { outcome: 'changed', complete: false, reason: 'parser-code-identity-conflict' },
    { outcome: 'stable', complete: true, reason: null },
  ])(
    'preserves the sequential graph when parser code identity is $outcome',
    async ({ outcome, complete, reason }) => {
      fs.writeFileSync(
        path.join(repoPath, 'a.ts'),
        'function target() {} function caller(){target();missing();}',
      );
      const files = ['a.ts'];
      const baseline = createKnowledgeGraph();
      const baselineResult = await runChunkedParseAndResolve(
        baseline,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        { skipWorkers: true },
      );
      const firstIdentity = 'a'.repeat(64);
      const identity = vi.spyOn(parserIdentity, 'workspaceParserIdentity');
      const readFailure = new Error('injected parser identity read failure');
      if (outcome === 'initially unavailable') {
        identity.mockRejectedValue(readFailure);
      } else {
        identity.mockResolvedValueOnce(firstIdentity);
        if (outcome === 'finally unavailable') identity.mockRejectedValueOnce(readFailure);
        else identity.mockResolvedValueOnce(outcome === 'changed' ? 'b'.repeat(64) : firstIdentity);
      }
      const allowance = { remainingBytes: 1024 * 1024 };
      try {
        const graph = createKnowledgeGraph();
        const result = await runChunkedParseAndResolve(
          graph,
          scanned(repoPath, files),
          files,
          files.length,
          repoPath,
          Date.now(),
          () => {},
          {
            skipWorkers: true,
            scopeRetention: {
              deadline: Date.now() + 30_000,
              artifactAllowance: allowance,
              consume: async () => {},
            },
          },
        );
        try {
          expect(identity).toHaveBeenCalledTimes(2);
          const caller = graph.nodes.find((node) => node.properties.name === 'caller')!;
          const target = graph.nodes.find((node) => node.properties.name === 'target')!;
          expect(caller).toBeDefined();
          expect(target).toBeDefined();
          expect(graph.relationships).toContainEqual(
            expect.objectContaining({
              sourceId: caller.id,
              targetId: target.id,
              type: 'CALLS',
            }),
          );
          const projection = (value: ReturnType<typeof createKnowledgeGraph>) =>
            JSON.parse(
              JSON.stringify({
                nodes: [...value.nodes].sort((left, right) => left.id.localeCompare(right.id)),
                relationships: [...value.relationships].sort((left, right) =>
                  left.id.localeCompare(right.id),
                ),
              }),
            );
          expect(projection(graph)).toEqual(projection(baseline));
          expect(result.scopeRetention!.inputEvidence.parserCodeIdentity).toBe(
            outcome === 'initially unavailable' ? null : firstIdentity,
          );
          expect(result.scopeRetention!.inputEvidence.complete).toBe(complete);
          expect(result.scopeRetention!.inputEvidence.reasons).toEqual(reason ? [reason] : []);
          expect(result.scopeRetention!.seedReady).toBe(false);
        } finally {
          await result.scopeRetention?.dispose();
          result.bindingAccumulator.dispose();
        }
        expect(allowance.remainingBytes).toBe(1024 * 1024);
      } finally {
        identity.mockRestore();
        baselineResult.bindingAccumulator.dispose();
      }
    },
  );

  it('preserves the sequential graph when retention has no artifact allowance', async () => {
    fs.writeFileSync(
      path.join(repoPath, 'a.ts'),
      'function target() {} function caller(){target();missing();}',
    );
    const files = ['a.ts'];
    const baseline = createKnowledgeGraph();
    const baselineResult = await runChunkedParseAndResolve(
      baseline,
      scanned(repoPath, files),
      files,
      files.length,
      repoPath,
      Date.now(),
      () => {},
      { skipWorkers: true },
    );
    const allowance = { remainingBytes: 0 };
    const graph = createKnowledgeGraph();
    try {
      const result = await runChunkedParseAndResolve(
        graph,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: true,
          scopeRetention: {
            deadline: Date.now() + 30_000,
            artifactAllowance: allowance,
            consume: async () => {},
          },
        },
      );
      try {
        const projection = (value: ReturnType<typeof createKnowledgeGraph>) =>
          JSON.parse(
            JSON.stringify({
              nodes: [...value.nodes].sort((left, right) => left.id.localeCompare(right.id)),
              calls: value.relationships
                .filter((edge) => edge.type === 'CALLS')
                .sort((left, right) => left.id.localeCompare(right.id)),
            }),
          );
        const caller = baseline.nodes.find((node) => node.properties.name === 'caller')!;
        const target = baseline.nodes.find((node) => node.properties.name === 'target')!;
        expect(caller).toBeDefined();
        expect(target).toBeDefined();
        expect(baseline.relationships).toContainEqual(
          expect.objectContaining({
            sourceId: caller.id,
            targetId: target.id,
            type: 'CALLS',
          }),
        );
        expect(projection(graph)).toEqual(projection(baseline));

        const retained = result.scopeRetention!;
        expect(retained).toBeDefined();
        expect(retained.status).toBe('incomplete');
        expect(retained.seedReady).toBe(false);
        expect(retained.reasons.length).toBeGreaterThan(0);
        expect([
          retained.recordCount,
          retained.callRecordCount,
          retained.heritageRecordCount,
          retained.assignmentRecordCount,
          retained.constructorBindingRecordCount,
          retained.exportedTypeRecordCount,
          retained.fileBindingRecordCount,
          retained.modelRegistrationRecordCount,
          retained.importStateRecordCount,
          retained.graphNodeRecordCount,
          retained.graphRelationshipRecordCount,
        ]).toEqual(Array(11).fill(0));
        expect(retained.graphNodesCaptured).toBe(false);
        expect(allowance.remainingBytes).toBe(0);
      } finally {
        await result.scopeRetention?.dispose();
        result.bindingAccumulator.dispose();
      }
      expect(allowance.remainingBytes).toBe(0);
    } finally {
      baselineResult.bindingAccumulator.dispose();
    }
  });
});

describe('parse-impl import configuration snapshot', () => {
  let repoPath = '';

  afterEach(() => {
    vi.restoreAllMocks();
    lifetimeConfig.workerData = null;
    if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it.each(['sequential', 'worker recovery'] as const)(
    'reuses one config snapshot across %s chunks after tsconfig changes',
    async (mode) => {
      failureConfig.readFileContentsFailAfter = Infinity;
      failureConfig.readFileContentsCalls = 0;
      failureConfig.processCalls = false;
      repoPath = makeTempRepo({
        'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['original/*'] } } }),
        'first.ts': "import { value } from '@/one';\n",
        'second.ts': "import { value } from '@/two';\n",
        'third.ts': "import { value } from '@/three';\n",
      });
      const languageConfig = await import('../../src/core/ingestion/language-config.js');
      const imports = await import('../../src/core/ingestion/import-processor.js');
      const parsing = await import('../../src/core/ingestion/parsing-processor.js');
      const loader = vi.spyOn(languageConfig, 'loadImportConfigs');
      const sequential = vi.spyOn(imports, 'processImports');
      const extracted = vi.spyOn(imports, 'processImportsFromExtracted');
      if (mode === 'worker recovery') {
        const workerData: WorkerData = {
          imports: [
            {
              filePath: 'first.ts',
              rawImportPath: '@/one',
              language: SupportedLanguages.TypeScript,
            },
          ],
          calls: [],
          assignments: [],
          heritage: [],
          routes: [],
          fetchCalls: [],
          decoratorRoutes: [],
          toolDefs: [],
          ormQueries: [],
          constructorBindings: [],
          fileScopeBindings: [],
          fileTimings: [],
          parseErrorPaths: [],
          extractorTimings: [],
        };
        lifetimeConfig.workerData = workerData;
        vi.spyOn(parsing, 'processParsing')
          .mockResolvedValueOnce(workerData)
          .mockResolvedValue(null);
      }
      const files = ['first.ts', 'second.ts', 'third.ts'];
      const paths = [
        ...files,
        ...['original', 'changed'].flatMap((dir) =>
          ['one', 'two', 'three'].map((name) => `${dir}/${name}.ts`),
        ),
      ];
      const result = await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        files.map((file) => ({ path: file, size: 30 * 1024 * 1024 })),
        paths,
        paths.length,
        repoPath,
        Date.now(),
        () => {},
        {
          skipWorkers: mode === 'sequential',
          workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
          onTelemetry: (event) => {
            if (event.event === 'parse-chunk-end' && event.chunkIndex === 1) {
              fs.writeFileSync(
                path.join(repoPath, 'tsconfig.json'),
                JSON.stringify({
                  compilerOptions: { paths: { '@/*': ['changed/*'] } },
                }),
              );
            }
          },
        },
      );
      try {
        expect(loader).toHaveBeenCalledExactlyOnceWith(repoPath, paths);
        const configs = await loader.mock.results[0]!.value;
        const originalTsconfig = JSON.stringify({
          compilerOptions: { paths: { '@/*': ['original/*'] } },
        });
        const observations = configs.observations;
        expect(observations).toMatchObject({ complete: true });
        expect(observations!.records).toContainEqual({
          kind: 'file',
          path: 'tsconfig.json',
          status: 'present',
          sha256: createHash('sha256').update(originalTsconfig).digest('hex'),
          byteLength: Buffer.byteLength(originalTsconfig),
        });
        expect(fs.readFileSync(path.join(repoPath, 'tsconfig.json'), 'utf8')).not.toBe(
          originalTsconfig,
        );
        expect(sequential).toHaveBeenCalledTimes(mode === 'sequential' ? 3 : 2);
        expect(extracted).toHaveBeenCalledTimes(mode === 'sequential' ? 0 : 1);
        for (const args of [...sequential.mock.calls, ...extracted.mock.calls]) {
          expect(args[7]).toBe(configs);
          expect(args[7]!.observations).toBe(observations);
        }
        const ctx = sequential.mock.calls[0]![3];
        expect(files.map((file) => [...ctx.importMap.get(file)!])).toEqual([
          ['original/one.ts'],
          ['original/two.ts'],
          ['original/three.ts'],
        ]);
      } finally {
        result.bindingAccumulator.dispose();
      }
    },
  );
});
