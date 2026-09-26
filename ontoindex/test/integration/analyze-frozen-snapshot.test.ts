/**
 * End-to-end: a real `runFullAnalysis` over a git repository whose files are
 * edited while the pipeline runs. With source snapshots the run publishes the
 * frozen state; without them the same edits abort publication.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { createTypeScriptAnalyzeRuntime } from '../../src/core/ingestion/runtime/index.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { loadMeta } from '../../src/storage/repo-manager.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

describe('analyze with a frozen source snapshot', () => {
  let repo: string;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-frozen-e2e-'));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-frozen-home-'));
    process.env.HOME = home;
    process.env.ONTOINDEX_HOME = path.join(home, '.ontoindex');
    await fs.mkdir(path.join(repo, 'src'));
    await fs.writeFile(
      path.join(repo, 'src', 'math.ts'),
      'export function add(a: number, b: number) {\n  return a + b;\n}\n',
    );
    await fs.writeFile(
      path.join(repo, 'src', 'main.ts'),
      "import { add } from './math';\nexport function run() {\n  return add(1, 2);\n}\n",
    );
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  /** Real pipeline that edits the live tree as soon as it starts. */
  function editingRuntime() {
    return createTypeScriptAnalyzeRuntime({
      runPipeline: async (root, onProgress, options) => {
        await fs.writeFile(
          path.join(repo, 'src', 'math.ts'),
          'export function add(a: number, b: number) {\n  return a - b;\n}\n',
        );
        await fs.writeFile(path.join(repo, 'src', 'late.ts'), 'export const late = 1;\n');
        return runPipelineFromRepo(root, onProgress, { ...options, skipWorkers: true });
      },
    });
  }

  it('publishes the frozen state despite concurrent edits', async () => {
    process.env.ONTOINDEX_ANALYZE_SNAPSHOT = '1';
    const head = git(repo, 'rev-parse', 'HEAD');

    const result = await runFullAnalysis(
      repo,
      { skipAgentsMd: true, noStats: true, skipNativeClose: false },
      { onProgress: () => {} },
      { analyzeRuntime: editingRuntime() },
    );

    expect(result.alreadyUpToDate).toBeUndefined();
    const meta = await loadMeta(path.join(repo, '.ontoindex'));
    expect(meta?.lastCommit).toBe(head);
    // meta.json persists repoPath as '.'; the snapshot path must never leak in.
    expect(JSON.stringify(meta)).not.toContain('source-snapshots');
    expect(result.repoPath).toBe(repo);
    expect(meta?.sourceManifest?.sourceEntryCount).toBe(2);
    expect(meta?.stats?.files).toBe(2);
    const leftovers = await fs.readdir(path.join(repo, '.ontoindex', 'source-snapshots'));
    expect(leftovers).toEqual([]);
  });

  it('refuses to publish the same edits without a snapshot', async () => {
    process.env.ONTOINDEX_ANALYZE_SNAPSHOT = '0';

    await expect(
      runFullAnalysis(
        repo,
        { skipAgentsMd: true, noStats: true },
        { onProgress: () => {} },
        { analyzeRuntime: editingRuntime() },
      ),
    ).rejects.toThrow('Source inputs changed during analysis');
  });
});
