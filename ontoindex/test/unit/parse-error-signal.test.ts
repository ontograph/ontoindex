import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo, type PipelineOptions } from '../../src/core/ingestion/pipeline.js';
import {
  createEmptyResult,
  mergeParseWorkerResult,
} from '../../src/core/ingestion/workers/parse-types.js';

type TelemetryEvent = Parameters<NonNullable<PipelineOptions['onTelemetry']>>[0];

describe('parse error telemetry', () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('preserves parse error paths when streamed worker results are merged', () => {
    const combined = createEmptyResult();
    const part = createEmptyResult();
    part.parseErrorPaths.push('bad.ts', 'bin.ts');
    mergeParseWorkerResult(combined, part);
    expect(combined.parseErrorPaths).toEqual(['bad.ts', 'bin.ts']);
  });

  it.each(['sequential', 'worker'] as const)(
    'reports error-tolerant trees while retaining valid graph output (%s)',
    async (mode) => {
      vi.stubEnv('ONTOINDEX_MAX_WORKERS', '1');
      const dir = await mkdtemp(path.join(os.tmpdir(), 'ontoindex-parse-error-'));
      directories.push(dir);
      await Promise.all([
        writeFile(path.join(dir, 'good.ts'), 'export function goodFunction() { return 1; }'),
        writeFile(path.join(dir, 'bad.ts'), 'export function broken( { !!!'),
        writeFile(path.join(dir, 'bin.ts'), Buffer.from([0, 1, 2, 255, 0])),
      ]);
      const events: TelemetryEvent[] = [];
      const result = await runPipelineFromRepo(dir, () => {}, {
        profile: 'full',
        skipWorkers: mode === 'sequential',
        workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
        onTelemetry: (event) => events.push(event),
      });
      expect(events.find((event) => event.event === 'parse-plan')?.usedWorkerPool).toBe(
        mode === 'worker',
      );
      expect(result.usedWorkerPool).toBe(mode === 'worker');
      const errors = events.filter((event) => event.event === 'parse-error-files');
      expect(errors).toHaveLength(1);
      expect(errors[0].parseErrorFiles?.slice().sort()).toEqual(['bad.ts', 'bin.ts']);
      expect(errors[0].parseErrorCount).toBe(2);
      expect(errors[0].parseErrorFiles).not.toContain('good.ts');
      expect(events.some((event) => event.event === 'parse-degraded-files')).toBe(false);
      expect(result.graph.nodes.some((node) => node.properties.name === 'goodFunction')).toBe(true);
    },
    60_000,
  );
});
