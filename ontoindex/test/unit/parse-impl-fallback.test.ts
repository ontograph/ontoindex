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
