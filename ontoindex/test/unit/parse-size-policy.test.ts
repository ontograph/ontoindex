import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';

let repoPath: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (repoPath) await fs.rm(repoPath, { recursive: true, force: true });
  repoPath = undefined;
});

describe('parse file size policy', () => {
  it('parses above the former aggregate size threshold despite legacy safe mode', async () => {
    vi.stubEnv('ONTOINDEX_DISABLE_LARGE_REPO_PARSE', '1');
    vi.stubEnv('ONTOINDEX_ENABLE_LARGE_REPO_PARSE', '0');
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'parse-size-policy-'));
    await fs.writeFile(
      path.join(repoPath, 'large.ts'),
      `export function parsedBeyondFormerLimit() { return 1; }\n//${'x'.repeat(2048)}\n`,
    );
    const graph = createKnowledgeGraph();
    await runChunkedParseAndResolve(
      graph,
      [{ path: 'large.ts', size: 180 * 1024 * 1024 + 1 }],
      ['large.ts'],
      1,
      repoPath,
      Date.now(),
      () => {},
      { skipWorkers: true },
    );

    expect(
      [...graph.iterNodes()].some((node) => node.properties.name === 'parsedBeyondFormerLimit'),
    ).toBe(true);
  });
});
