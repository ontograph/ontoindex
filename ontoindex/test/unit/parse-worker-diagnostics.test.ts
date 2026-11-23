import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Parser from 'tree-sitter';
import type {
  ParseWorkerResult,
  WorkerIncomingMessage,
} from '../../src/core/ingestion/workers/parse-types.js';

const port = vi.hoisted(() => ({ on: vi.fn(), postMessage: vi.fn() }));
const providerOverride = vi.hoisted(() => ({
  enabled: false,
  queries: undefined as string | undefined,
}));
const fetchFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  parentPort: port,
}));

vi.mock('../../src/core/ingestion/languages/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/languages/index.js')>();
  return {
    ...actual,
    getProvider: (language: string) => {
      const provider = actual.getProvider(language as Parameters<typeof actual.getProvider>[0]);
      return providerOverride.enabled && language === 'typescript'
        ? { ...provider, treeSitterQueries: providerOverride.queries }
        : provider;
    },
  };
});

vi.mock('../../src/core/ingestion/route-extractors/fetch-evidence.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/core/ingestion/route-extractors/fetch-evidence.js')
    >();
  return {
    ...actual,
    extractFetchEvidence: (...args: Parameters<typeof actual.extractFetchEvidence>) => {
      if (fetchFailure.enabled) {
        fetchFailure.enabled = false;
        throw new Error('partial-group-sentinel');
      }
      return actual.extractFetchEvidence(...args);
    },
  };
});

let handler: ((message: WorkerIncomingMessage) => Promise<void>) | undefined;

beforeEach(async () => {
  providerOverride.enabled = false;
  providerOverride.queries = undefined;
  fetchFailure.enabled = false;
  port.postMessage.mockClear();
  await import('../../src/core/ingestion/workers/parse-worker.js');
  handler = port.on.mock.calls.find(([event]) => event === 'message')?.[1] as
    ((message: WorkerIncomingMessage) => Promise<void>) | undefined;
  expect(handler).toBeDefined();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function parse(files: { path: string; content: string }[]): Promise<ParseWorkerResult> {
  port.postMessage.mockClear();
  await handler!(files);
  const message = port.postMessage.mock.calls
    .map(([value]) => value as { type?: string; data?: ParseWorkerResult })
    .find((value) => value.type === 'result');
  if (!message?.data) throw new Error('Missing parse worker result');
  return message.data;
}

describe('parse worker per-file diagnostics', () => {
  it('records files when the provider query does not compile', async () => {
    providerOverride.enabled = true;
    providerOverride.queries = '((';

    const result = await parse([{ path: 'src/a.ts', content: 'export const value = 1;' }]);

    expect(result.fileTimings).toEqual([
      expect.objectContaining({
        filePath: 'src/a.ts',
        status: 'skipped',
        reason: expect.stringContaining('Query compilation failed for typescript'),
      }),
    ]);
  });

  it('records an error and only the unprocessed remainder after a partial group failure', async () => {
    fetchFailure.enabled = true;

    const result = await parse([
      { path: 'src/a.ts', content: 'export const a = 1;' },
      { path: 'src/b.ts', content: "fetch('/b');" },
      { path: 'src/c.ts', content: "fetch('/c');" },
    ]);

    expect(result.fileTimings).toEqual([
      expect.objectContaining({ filePath: 'src/a.ts', status: 'processed' }),
      expect.objectContaining({
        filePath: 'src/b.ts',
        status: 'error',
        reason: expect.stringContaining('partial-group-sentinel'),
      }),
      expect.objectContaining({
        filePath: 'src/c.ts',
        status: 'skipped',
        reason: expect.stringContaining('Worker language group failed'),
      }),
    ]);
  });

  it('does not retain a duplicate skipped row for an already-processed path', async () => {
    const originalParse = Parser.prototype.parse;
    let parseCalls = 0;
    vi.spyOn(Parser.prototype, 'parse').mockImplementation(function (content, oldTree, options) {
      parseCalls++;
      if (parseCalls === 2) throw new Error('duplicate-path-sentinel');
      return originalParse.call(this, content, oldTree, options);
    });

    const result = await parse([
      { path: 'src/duplicate.ts', content: 'export const value = 1;' },
      { path: 'src/duplicate.ts', content: 'export const value = 2;' },
    ]);

    expect(result.fileTimings).toEqual([
      expect.objectContaining({ filePath: 'src/duplicate.ts', status: 'processed' }),
    ]);
  });

  it('records files without provider queries instead of silently omitting them', async () => {
    providerOverride.enabled = true;
    providerOverride.queries = undefined;

    const result = await parse([{ path: 'src/no-query.ts', content: 'export const value = 1;' }]);

    expect(result.fileTimings).toEqual([
      expect.objectContaining({
        filePath: 'src/no-query.ts',
        status: 'skipped',
        reason: expect.stringContaining('Tree-sitter queries for typescript are unavailable'),
      }),
    ]);
  });
});
