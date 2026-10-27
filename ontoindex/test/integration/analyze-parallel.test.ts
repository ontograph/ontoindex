/** Parsing and resolution must produce the same graph with one or four workers. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo, type PipelineOptions } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const files: Record<string, string> = {
  'js/helper.js': 'export function jsHelper() { return 1; }\n',
  'js/main.js':
    "import { jsHelper } from './helper.js';\nexport function jsCaller() { return jsHelper(); }\n",
  'ts/helper.ts': 'export function tsHelper(): number { return 2; }\n',
  'ts/main.ts':
    "import { tsHelper } from './helper';\nexport function tsCaller(): number { return tsHelper(); }\n",
  'cpp/helper.h': 'int cppHelper() { return 3; }\n',
  'cpp/main.cpp': '#include "helper.h"\nint cppCaller() { return cppHelper(); }\n',
  'rust/helper.rs': 'pub fn rust_helper() -> i32 { 4 }\n',
  'rust/Cargo.toml':
    '[package]\nname = "parallel-fixture"\nversion = "0.1.0"\nedition = "2021"\n[[bin]]\nname = "parallel-fixture"\npath = "main.rs"\n',
  'rust/main.rs':
    'mod helper;\nuse helper::rust_helper;\npub fn rust_caller() -> i32 { rust_helper() }\n',
  'python/helper.py': 'def python_helper():\n    return 5\n',
  'python/main.py':
    'from .helper import python_helper\ndef python_caller():\n    return python_helper()\n',
};

function snapshot(result: PipelineResult) {
  return {
    totalFileCount: result.totalFileCount,
    nodes: [...result.graph.iterNodes()].sort((a, b) => a.id.localeCompare(b.id)),
    relationships: [...result.graph.iterRelationships()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

describe('Parallel parsing and resolution determinism', () => {
  let directory: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('produces identical graph content with one and four real workers across five languages', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-parallel-'));
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(directory, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }

    async function run(workerCount: number) {
      vi.stubEnv('ONTOINDEX_MAX_WORKERS', String(workerCount));
      const parsePlans: Parameters<NonNullable<PipelineOptions['onTelemetry']>>[0][] = [];
      const result = await runPipelineFromRepo(directory!, () => {}, {
        // Community/process detection is outside this parser/resolver regression.
        skipGraphPhases: true,
        workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
        onTelemetry(event) {
          if (event.event === 'parse-plan') parsePlans.push(event);
        },
      });
      expect(result.usedWorkerPool).toBe(true);
      expect(parsePlans).toHaveLength(1);
      expect(parsePlans[0]).toMatchObject({ usedWorkerPool: true, workerPoolSize: workerCount });
      return result;
    }

    const single = await run(1);
    const parallel = await run(4);
    const actual = snapshot(single);
    expect(actual.totalFileCount).toBe(Object.keys(files).length);
    for (const [callerName, helperName, callerPath, helperPath] of [
      ['jsCaller', 'jsHelper', 'js/main.js', 'js/helper.js'],
      ['tsCaller', 'tsHelper', 'ts/main.ts', 'ts/helper.ts'],
      ['cppCaller', 'cppHelper', 'cpp/main.cpp', 'cpp/helper.h'],
      ['rust_caller', 'rust_helper', 'rust/main.rs', 'rust/helper.rs'],
      ['python_caller', 'python_helper', 'python/main.py', 'python/helper.py'],
    ]) {
      const caller = actual.nodes.find(
        (node) =>
          node.label === 'Function' &&
          node.properties.name === callerName &&
          node.properties.filePath === callerPath,
      );
      const helper = actual.nodes.find(
        (node) =>
          node.label === 'Function' &&
          node.properties.name === helperName &&
          node.properties.filePath === helperPath,
      );
      expect(caller, callerName).toBeDefined();
      expect(helper, helperName).toBeDefined();
      expect(actual.relationships, `${callerName} calls ${helperName}`).toContainEqual(
        expect.objectContaining({ type: 'CALLS', sourceId: caller!.id, targetId: helper!.id }),
      );
      const callerFile = actual.nodes.find(
        (node) => node.label === 'File' && node.properties.filePath === callerPath,
      );
      const helperFile = actual.nodes.find(
        (node) => node.label === 'File' && node.properties.filePath === helperPath,
      );
      expect(callerFile, callerPath).toBeDefined();
      expect(helperFile, helperPath).toBeDefined();
      expect(actual.relationships, `${callerPath} imports ${helperPath}`).toContainEqual(
        expect.objectContaining({
          type: 'IMPORTS',
          sourceId: callerFile!.id,
          targetId: helperFile!.id,
        }),
      );
    }
    expect(snapshot(parallel)).toEqual(actual);
  }, 120_000);
});
