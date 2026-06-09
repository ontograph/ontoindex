/**
 * Integration Tests: Worker Pool & Parse Worker
 *
 * Verifies that the worker pool can spawn real worker threads using the
 * compiled dist/ parse-worker.js and process files correctly.
 * This is critical for cross-platform CI where vitest runs from src/
 * but workers need compiled .js files.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createWorkerPool, WorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import { createEmptyResult } from '../../src/core/ingestion/workers/parse-types.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const DIST_WORKER = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'core',
  'ingestion',
  'workers',
  'parse-worker.js',
);
const hasDistWorker = fs.existsSync(DIST_WORKER);

describe('worker pool integration', () => {
  let pool: WorkerPool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.terminate();
      pool = undefined;
    }
  });

  it.skipIf(!hasDistWorker)('creates a worker pool from dist/ worker', () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);
    expect(pool.size).toBe(1);
  });

  it.skipIf(!hasDistWorker)('dispatches an empty batch without error', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);
    const results = await pool.dispatch([]);
    expect(results).toEqual([]);
  });

  it.skipIf(!hasDistWorker)('parses a single TypeScript file through worker', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);

    const fixtureFile = path.resolve(
      __dirname,
      '..',
      'fixtures',
      'mini-repo',
      'src',
      'validator.ts',
    );
    const content = fs.readFileSync(fixtureFile, 'utf-8');

    const results = await pool.dispatch<any, any>([{ path: 'src/validator.ts', content }]);

    // Worker returns an array of results (one per worker chunk)
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.fileCount).toBe(1);
    expect(result.nodes.length).toBeGreaterThan(0);

    // Should find the validateInput function
    const names = result.nodes.map((n: any) => n.properties.name);
    expect(names).toContain('validateInput');
  });

  it.skipIf(!hasDistWorker)('can stream result parts without retaining them', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);

    const fixtureFile = path.resolve(
      __dirname,
      '..',
      'fixtures',
      'mini-repo',
      'src',
      'validator.ts',
    );
    const content = fs.readFileSync(fixtureFile, 'utf-8');
    const streamedCounts: number[] = [];

    const results = await pool.dispatch<any, ReturnType<typeof createEmptyResult>>(
      [{ path: 'src/validator.ts', content }],
      undefined,
      undefined,
      undefined,
      {
        collectResultParts: false,
        createEmptyResult,
        onResultPart: (part) => {
          streamedCounts.push(part.nodes.length);
          part.nodes.length = 0;
          part.relationships.length = 0;
          part.symbols.length = 0;
        },
      },
    );

    expect(streamedCounts.some((count) => count > 0)).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].nodes).toHaveLength(0);
    expect(results[0].relationships).toHaveLength(0);
    expect(results[0].symbols).toHaveLength(0);
  });

  it.skipIf(!hasDistWorker)(
    'parses a single TypeScript file through process isolation',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { isolation: 'process' });

      const fixtureFile = path.resolve(
        __dirname,
        '..',
        'fixtures',
        'mini-repo',
        'src',
        'validator.ts',
      );
      const content = fs.readFileSync(fixtureFile, 'utf-8');

      const results = await pool.dispatch<any, any>([{ path: 'src/validator.ts', content }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.fileCount).toBe(1);
      const names = result.nodes.map((n: any) => n.properties.name);
      expect(names).toContain('validateInput');
    },
  );

  it.skipIf(!hasDistWorker)(
    'uses route-model pack file patterns to trigger route extraction before provider defaults',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1);

      const content = `
        <?php
        use Illuminate\\Support\\Facades\\Route;
        Route::get('/shadow-users', [UserController::class, 'index']);
      `;

      const results = await pool.dispatch<any, any>([
        {
          path: 'custom/http/shadow-routes.php',
          content,
          routeFilePatterns: ['custom/http/**/*.php'],
        },
      ]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.routes).toHaveLength(1);
      expect(result.routes[0]).toMatchObject({
        filePath: 'custom/http/shadow-routes.php',
        routePath: '/shadow-users',
        httpMethod: 'get',
      });
    },
  );

  it.skipIf(!hasDistWorker)(
    'uses component-model pack file patterns to trigger JSX component extraction before extension defaults',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1);

      const content = `
        import React from 'react';

        export function LegacyView() {
          return <UserCard title="Users" />;
        }
      `;

      const results = await pool.dispatch<any, any>([
        {
          path: 'custom/components/legacy-view.js',
          content,
          componentFilePatterns: ['custom/components/**/*.js'],
        },
      ]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filePath: 'custom/components/legacy-view.js',
            calledName: 'UserCard',
            sourceId: 'File:custom/components/legacy-view.js',
            callForm: 'free',
          }),
        ]),
      );
    },
  );

  it.skipIf(!hasDistWorker)(
    'uses orm-model pack client identifiers to extract ORM queries before hard-coded client names',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1);

      const content = `
        export async function listUsers() {
          return db.user.findMany({ where: { active: true } });
        }

        export async function listBookings() {
          return adminDb.from('bookings').select('*');
        }
      `;

      const results = await pool.dispatch<any, any>([
        {
          path: 'custom/data/orm-aliases.ts',
          content,
          prismaClientIdentifiers: ['db'],
          supabaseClientIdentifiers: ['adminDb'],
        },
      ]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.ormQueries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filePath: 'custom/data/orm-aliases.ts',
            orm: 'prisma',
            model: 'user',
            method: 'findMany',
          }),
          expect.objectContaining({
            filePath: 'custom/data/orm-aliases.ts',
            orm: 'supabase',
            model: 'bookings',
            method: 'select',
          }),
        ]),
      );
    },
  );

  it.skipIf(!hasDistWorker)(
    'emits method call source IDs that match suffixed method node IDs',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1);

      const content = `
        const phase = {
          async execute(ctx: unknown, deps: unknown) {
            return helper();
          },
        };

        function helper() {
          return true;
        }
      `;

      const results = await pool.dispatch<any, any>([{ path: 'src/phase.ts', content }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      const executeNode = result.nodes.find((n: any) => n.properties.name === 'execute');
      const helperCall = result.calls.find((c: any) => c.calledName === 'helper');

      expect(executeNode?.id).toBe('Method:src/phase.ts:execute#2');
      expect(helperCall?.sourceId).toBe(executeNode?.id);
    },
  );

  it.skipIf(!hasDistWorker)(
    'captures async generator function definitions used as call sources',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1);

      const content = `
        export async function* streamAgentResponse(messages: string[]) {
          yield formatChunk(messages);
        }

        function formatChunk(messages: string[]) {
          return messages.join(',');
        }
      `;

      const results = await pool.dispatch<any, any>([{ path: 'src/agent.ts', content }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      const streamNode = result.nodes.find((n: any) => n.properties.name === 'streamAgentResponse');
      const helperCall = result.calls.find((c: any) => c.calledName === 'formatChunk');

      expect(streamNode?.id).toBe('Function:src/agent.ts:streamAgentResponse');
      expect(helperCall?.sourceId).toBe(streamNode?.id);
    },
  );

  it.skipIf(!hasDistWorker)('parses multiple files across workers', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 2);

    const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'mini-repo', 'src');
    const files = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({
        path: `src/${f}`,
        content: fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
      }));

    expect(files.length).toBeGreaterThanOrEqual(4);

    const results = await pool.dispatch<any, any>(files);

    // Each worker chunk returns a result
    expect(results.length).toBeGreaterThan(0);

    // Total files parsed should match input
    const totalParsed = results.reduce((sum: number, r: any) => sum + r.fileCount, 0);
    expect(totalParsed).toBe(files.length);

    // Should find symbols from multiple files
    const allNames = results.flatMap((r: any) => r.nodes.map((n: any) => n.properties.name));
    expect(allNames).toContain('handleRequest');
    expect(allNames).toContain('validateInput');
    expect(allNames).toContain('saveToDb');
    expect(allNames).toContain('formatResponse');
  });

  it.skipIf(!hasDistWorker)('reports progress during parsing', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);

    const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'mini-repo', 'src');
    const files = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({
        path: `src/${f}`,
        content: fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
      }));

    const progressCalls: number[] = [];
    await pool.dispatch<any, any>(files, (filesProcessed) => {
      progressCalls.push(filesProcessed);
    });

    // Progress callbacks are best-effort — with a small batch the worker may
    // process all files before the progress message is delivered. Just verify
    // that if progress was reported, the values are sensible.
    if (progressCalls.length > 0) {
      expect(progressCalls[progressCalls.length - 1]).toBe(files.length);
    }
  });

  it.skipIf(!hasDistWorker)('terminates cleanly', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 2);
    await pool.terminate();
    pool = undefined; // already terminated
  });

  it('fails gracefully with invalid worker path', () => {
    const badUrl = pathToFileURL('/nonexistent/worker.js') as URL;
    // createWorkerPool validates the worker script exists before spawning
    expect(() => {
      pool = createWorkerPool(badUrl, 1);
    }).toThrow(/Worker script not found/);
  });

  // ─── Unhappy paths ──────────────────────────────────────────────────

  it('throws when a worker thread encounters an error', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-error-'));
    const workerPath = path.join(tempDir, 'error-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          parentPort.postMessage({
            type: 'diagnostic',
            diagnostics: {
              ...msg.diagnostics,
              phase: 'process-file',
              currentFilePath: 'error.ts',
            },
          });
          parentPort.postMessage({ type: 'error', error: 'Simulated worker crash' });
        }
      });
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1);

    try {
      await expect(
        pool.dispatch<any, any>([{ path: 'error.ts', content: 'const x = 1;' }]),
      ).rejects.toThrow(
        /Simulated worker crash.*sub-batch: 1 size 1.*current file: error\.ts.*active: file error\.ts/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports child-process exits with active parse context', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-process-exit-'));
    const workerPath = path.join(tempDir, 'exit-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      process.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          process.send({
            type: 'diagnostic',
            diagnostics: {
              ...msg.diagnostics,
              phase: 'process-file',
              currentFilePath: 'native-panic.ts',
            },
          });
          process.exit(134);
        }
      });
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1, { isolation: 'process' });

    try {
      await expect(
        pool.dispatch<any, any>([{ path: 'native-panic.ts', content: 'const x = 1;' }]),
      ).rejects.toThrow(
        /Worker 0 exited with code 134.*sub-batch: 1 size 1.*current file: native-panic\.ts.*active: file native-panic\.ts.*native addon failure/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('escalates child-process termination when SIGTERM is ignored', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-process-kill-'));
    const workerPath = path.join(tempDir, 'ignore-term-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      process.on('SIGTERM', () => {});
      process.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          process.send({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          process.send({ type: 'result', data: { items: [] } });
        }
      });
      setInterval(() => {}, 1000);
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1, { isolation: 'process' });

    try {
      await pool.dispatch<any, any>([{ path: 'ignored-term.ts', content: 'const x = 1;' }]);
      const started = Date.now();
      await pool.terminate();
      pool = undefined;
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 7_000);

  it('emits process isolation startup metadata on worker events', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-process-meta-'));
    const workerPath = path.join(tempDir, 'metadata-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      process.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          process.send({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          process.send({ type: 'result', data: { items: [] } });
        }
      });
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1, { isolation: 'process' });
    const subBatchEvents: any[] = [];
    const resultEvents: any[] = [];

    try {
      await pool.dispatch<any, any>(
        [{ path: 'metadata.ts', content: 'const x = 1;' }],
        undefined,
        (event) => subBatchEvents.push(event),
        (event) => resultEvents.push(event),
      );

      expect(pool.isolation).toBe('process');
      expect(pool.startupDurationMs).toBeGreaterThanOrEqual(0);
      expect(pool.workerStartupDurationsMs).toHaveLength(1);
      expect(subBatchEvents[0]).toMatchObject({
        workerIsolation: 'process',
        workerIndex: 0,
      });
      expect(subBatchEvents[0].workerStartupDurationMs).toBeGreaterThanOrEqual(0);
      expect(resultEvents[0]).toMatchObject({
        workerIsolation: 'process',
        workerIndex: 0,
      });
      expect(resultEvents[0].workerStartupDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasDistWorker)('dispatch after terminate rejects', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);
    const terminatedPool = pool;
    await terminatedPool.terminate();
    pool = undefined; // already terminated — prevent afterEach double-terminate

    await expect(
      terminatedPool.dispatch([{ path: 'x.ts', content: 'const x = 1;' }]),
    ).rejects.toThrow();
  });

  it.skipIf(!hasDistWorker)('double terminate does not throw', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);
    await pool.terminate();
    await expect(pool.terminate()).resolves.toBeUndefined();
    pool = undefined;
  });

  it.skipIf(!hasDistWorker)(
    'dispatches entries with empty content string without crashing',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1);

      const results = await pool.dispatch<any, any>([{ path: 'empty.ts', content: '' }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(typeof result.fileCount).toBe('number');
      expect(result.fileCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.nodes)).toBe(true);
    },
  );

  it('treats warning messages as non-terminal and still resolves the worker result', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-warning-'));
    const workerPath = path.join(tempDir, 'warning-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          parentPort.postMessage({ type: 'warning', message: 'warning before result' });
          parentPort.postMessage({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { nodes: [], relationships: [], symbols: [], imports: [], calls: [], heritage: [], routes: [], fileCount: 1 } });
        }
      });
    `,
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1);

    try {
      const results = await pool.dispatch<any, any>([
        { path: 'warning.ts', content: 'const x = 1;' },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].fileCount).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith('warning before result');
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasDistWorker)('createWorkerPool with size 0 creates pool with zero workers', () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    const zeroPool = createWorkerPool(workerUrl, 0);
    expect(zeroPool.size).toBe(0);
    return zeroPool.terminate();
  });
});
