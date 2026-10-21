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
import type { ParsedFile } from 'ontoindex-shared';
import { SupportedLanguages } from 'ontoindex-shared';

type WorkerData = NonNullable<Awaited<ReturnType<typeof processParsing>>>;
const lifetimeConfig: {
  workerData: WorkerData | null;
  sequentialFetch: boolean;
  recoveryFiles: ParsedFile[] | null;
  terminate: ReturnType<typeof vi.fn>;
} = {
  workerData: null,
  sequentialFetch: false,
  recoveryFiles: null,
  terminate: vi.fn(async () => {}),
};

vi.mock('../../src/core/ingestion/workers/worker-pool.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/workers/worker-pool.js')>();
  return {
    ...actual,
    createWorkerPool: (...args: Parameters<typeof actual.createWorkerPool>) =>
      lifetimeConfig.workerData
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
        args[11]?.(lifetimeConfig.recoveryFiles);
        args[12]?.(
          lifetimeConfig.recoveryFiles.map(({ filePath }) => ({ filePath, status: 'success' })),
        );
        lifetimeConfig.recoveryFiles.length = 0;
        return Promise.resolve(null);
      }
      return lifetimeConfig.workerData
        ? Promise.resolve(lifetimeConfig.workerData)
        : actual.processParsing(...args);
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
} = {
  readFileContentsFailAfter: Infinity,
  readFileContentsCalls: 0,
  processCalls: false,
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
      // Delegate to original
      return (actual.processCalls as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
    }),
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

  it('large-repo parse cap skips oversized parseable files when explicitly configured', async () => {
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
      expect(parsePlan?.totalParseableFiles).toBe(1);
      expect(parsePlan?.totalParseableBytes).toBeLessThan(1024);

      const degraded = telemetry.find((event) => event.event === 'parse-degraded-files');
      expect(degraded?.degradedReason).toBe('large-repo-parse-file-size-cap');
      expect(degraded?.chunkFiles).toBe(1);
      expect(degraded?.degradedFiles?.[0]?.filePath).toBe('large.js');
      expect(graph.nodes.some((node) => node.properties?.name === 'large')).toBe(false);
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

    try {
      const graph = createKnowledgeGraph();
      const files = ['guarded.ts'];
      await runChunkedParseAndResolve(
        graph,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        { skipWorkers: true },
      );

      expect(graph.nodeCount).toBe(0);
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
        { skipWorkers: true },
      );

      expect(graph.nodeCount).toBe(0);
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
      parsedFiles: [],
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
    files: { rel: string; shebangLanguage?: string | null }[],
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
      scannedWithShebang(repoPath, [{ rel: 'manage', shebangLanguage: 'python' }]),
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

  function parsedFile(): ParsedFile {
    return {
      filePath: 'a.ts',
      moduleScope: 'scope:a.ts#module',
      scopes: [
        {
          id: 'scope:a.ts#module',
          parent: null,
          kind: 'Module',
          filePath: 'a.ts',
          range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 },
          bindings: new Map(),
          typeBindings: new Map(),
          ownedDefs: [],
          imports: [],
        },
      ],
      parsedImports: [],
      localDefs: [],
      referenceSites: [],
    };
  }

  beforeEach(() => {
    failureConfig.readFileContentsFailAfter = Infinity;
    failureConfig.readFileContentsCalls = 0;
    failureConfig.processCalls = false;
    lifetimeConfig.workerData = null;
    lifetimeConfig.recoveryFiles = null;
    repoPath = makeTempRepo({ 'a.ts': 'export function sample() { return 1; }\n' });
  });

  afterEach(() => {
    lifetimeConfig.workerData = null;
    lifetimeConfig.recoveryFiles = null;
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it.each(['worker', 'sequential', 'recovery'] as const)(
    'captures %s inputs before their cleanup',
    async (mode) => {
      const expected = parsedFile();
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
          fileScopeBindings: [],
          fileTimings: [],
          parseErrorPaths: [],
          extractorTimings: [],
          parsedFiles: [expected],
          scopeExtractionOutcomes: [{ filePath: 'a.ts', status: 'success' }],
        };
      if (mode === 'recovery') lifetimeConfig.recoveryFiles = [expected];
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
            artifactAllowance: { remainingBytes: 1024 * 1024 },
            consume: async () => {},
          },
        },
      );
      const retained = result.scopeRetention;
      expect(retained).toBeDefined();
      try {
        const content = fs.readFileSync(path.join(repoPath, 'a.ts'), 'utf8');
        expect(retained!.inputEvidence.sources).toEqual([
          {
            filePath: 'a.ts',
            sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
            byteLength: Buffer.byteLength(content, 'utf8'),
          },
        ]);
        expect(retained!.inputEvidence.configuration).toMatchObject({ version: 1, complete: true });
        const replayed: ParsedFile[] = [];
        for await (const batch of retained!.iterate()) replayed.push(...batch);
        if (mode === 'sequential') {
          // Providers without a scope hook must expose the gap, even after a successful legacy parse.
          expect(replayed).toEqual([]);
          expect(retained!.status).toBe('incomplete');
          expect(retained!.inputEvidence.complete).toBe(false);
          expect(retained!.inventory).toEqual([{ filePath: 'a.ts', status: 'unsupported' }]);
          expect(retained!.reasons).toContain('unsupported');
        } else {
          expect(replayed.map(({ filePath }) => filePath)).toEqual(['a.ts']);
          expect(replayed[0]!.scopes[0]!.bindings).toBeInstanceOf(Map);
          expect(replayed).toEqual([expected]);
          expect(retained!.status).toBe('retained');
          expect(retained!.inputEvidence.complete).toBe(true);
        }
        if (mode === 'worker') expect(lifetimeConfig.workerData!.parsedFiles).toEqual([]);
        if (mode === 'recovery') expect(lifetimeConfig.recoveryFiles).toEqual([]);
      } finally {
        await retained!.dispose();
        result.bindingAccumulator.dispose();
      }
    },
  );

  it.each(['heritage', 'calls'] as const)(
    'rejects input completeness when the %s reread changes source text',
    async (pass) => {
      lifetimeConfig.recoveryFiles = [parsedFile()];
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
    result.bindingAccumulator.dispose();
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
          parsedFiles: [],
          scopeExtractionOutcomes: [],
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
        expect(loader).toHaveBeenCalledExactlyOnceWith(repoPath);
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
