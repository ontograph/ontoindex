import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getLanguageFromFilename, SupportedLanguages } from 'ontoindex-shared';
import {
  createEmptyResult,
  hydrateParseWorkerInput,
  mergeParseWorkerResult,
  PARSE_WORKER_PROTOCOL_VERSION,
  resolveParseWorkerInputPath,
  type WorkerIncomingMessage,
  type WorkerOutgoingMessage,
} from '../../src/core/ingestion/workers/parse-types.js';

describe('parse worker protocol schema', () => {
  it('pins the serialized protocol version', () => {
    expect(PARSE_WORKER_PROTOCOL_VERSION).toBe(2);
  });

  it('creates the complete empty result shape used by worker and native boundaries', () => {
    expect(createEmptyResult()).toEqual({
      nodes: [],
      relationships: [],
      symbols: [],
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
      parsedFiles: [],
      processedPaths: [],
      fileTimings: [],
      extractorTimings: [],
      skippedLanguages: {},
      fileCount: 0,
    });
  });

  it('merges result parts without spread-based array appends', () => {
    const target = createEmptyResult();
    const source = createEmptyResult();
    source.nodes.push({
      id: 'Function:src/a.ts:run',
      label: 'Function',
      properties: {
        name: 'run',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 3,
        language: SupportedLanguages.TypeScript,
        isExported: true,
      },
    });
    source.processedPaths.push('src/a.ts');
    source.fileTimings.push({
      filePath: 'src/a.ts',
      language: SupportedLanguages.TypeScript,
      durationMs: 7,
      status: 'processed',
    });
    source.skippedLanguages.ruby = 2;
    source.fileCount = 1;

    mergeParseWorkerResult(target, source);

    expect(target.nodes).toHaveLength(1);
    expect(target.processedPaths).toEqual(['src/a.ts']);
    expect(target.fileTimings).toEqual([
      {
        filePath: 'src/a.ts',
        language: 'typescript',
        durationMs: 7,
        status: 'processed',
      },
    ]);
    expect(target.skippedLanguages).toEqual({ ruby: 2 });
    expect(target.fileCount).toBe(1);
  });

  it('accepts the stable incoming and outgoing message variants at compile time', () => {
    const incoming: WorkerIncomingMessage[] = [
      [],
      {
        type: 'sub-batch',
        files: [{ path: 'src/a.ts', content: 'export const a = 1;' }],
        diagnostics: {
          workerIndex: 0,
          subBatchIndex: 1,
          subBatchSize: 1,
          workerChunkSize: 1,
          firstFilePath: 'src/a.ts',
          lastFilePath: 'src/a.ts',
        },
      },
      {
        type: 'sub-batch',
        files: [{ path: 'src/b.ts', contentSource: 'path', repoPath: '/repo' }],
      },
      { type: 'flush' },
    ];
    const outgoing: WorkerOutgoingMessage[] = [
      { type: 'progress', filesProcessed: 1, filePath: 'src/a.ts' },
      {
        type: 'diagnostic',
        diagnostics: {
          workerIndex: 0,
          subBatchIndex: 1,
          subBatchSize: 1,
          workerChunkSize: 1,
          currentFilePath: 'src/a.ts',
          phase: 'process-file',
        },
      },
      { type: 'warning', message: 'slow file' },
      { type: 'result-part', data: createEmptyResult() },
      { type: 'sub-batch-done' },
      {
        type: 'error',
        error: 'parse failed',
        diagnostics: { currentFilePath: 'src/a.ts', phase: 'process-file' },
      },
      { type: 'result', data: createEmptyResult() },
    ];

    expect(incoming.map((message) => (Array.isArray(message) ? 'legacy' : message.type))).toEqual([
      'legacy',
      'sub-batch',
      'sub-batch',
      'flush',
    ]);
    expect(outgoing.map((message) => message.type)).toEqual([
      'progress',
      'diagnostic',
      'warning',
      'result-part',
      'sub-batch-done',
      'error',
      'result',
    ]);
  });

  it('hydrates path-based inputs from parent-approved repo-relative paths', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-parse-worker-'));
    await fs.mkdir(path.join(repoPath, 'src'));
    await fs.writeFile(path.join(repoPath, 'src', 'path-mode.ts'), 'export const pathMode = 1;');

    const hydrated = await hydrateParseWorkerInput({
      path: 'src/path-mode.ts',
      contentSource: 'path',
      repoPath,
    });

    expect(hydrated.content).toBe('export const pathMode = 1;');
    expect(hydrated.path).toBe('src/path-mode.ts');
    expect(getLanguageFromFilename(hydrated.path)).toBe(SupportedLanguages.TypeScript);
  });

  it('rejects path-based inputs that escape the parent-approved repo root', () => {
    expect(() => resolveParseWorkerInputPath('/repo', '../outside.ts')).toThrow(
      'escapes repo root',
    );
    expect(() => resolveParseWorkerInputPath('/repo', '/repo/src/a.ts')).toThrow('repo-relative');
  });
});
