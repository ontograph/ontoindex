import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import lbug from '@ladybugdb/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { closeLbug as closeCoreLbug } from '../../src/core/lbug/lbug-adapter.js';
import * as pool from '../../src/core/lbug/pool-adapter.js';
import {
  overlayRepoId,
  queryOverlay,
  resolveOverlayDbPath,
} from '../../src/mcp/local/backend-overlay.js';
import { buildTestGraph } from '../helpers/test-graph.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');
const require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;
const cypher = 'MATCH (n:Function) RETURN n.name AS name LIMIT 10';

describe('cross-process overlay generation immutability', () => {
  let root: string;
  let repo: { id: string; repoPath: string; storagePath: string };

  async function buildFirstGeneration() {
    const analyzeRepo = vi.fn(async () => ({
      graph: buildTestGraph([
        { id: 'File:source.ts', label: 'File', name: 'source.ts', filePath: 'source.ts' },
        { id: 'Function:gen1', label: 'Function', name: 'gen1', filePath: 'source.ts' },
      ]),
      repoPath: root,
      totalFileCount: 1,
      usedWorkerPool: false,
    }));
    await runFullAnalysis(
      root,
      { dirtyOverlay: true, overlayPaths: ['source.ts'] },
      { onProgress: () => undefined },
      { analyzeRuntime: { analyzeRepo } },
    );
  }

  async function runChildAnalyze() {
    const child = spawn(
      process.execPath,
      ['--import', tsxImportUrl, cliEntry, 'analyze', root, '--dirty-overlay'],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
        timeout: 90_000,
      },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(exitCode, output).toBe(0);
  }

  afterEach(async () => {
    if (repo) await pool.closeLbug(overlayRepoId(repo.id));
    await closeCoreLbug();
    if (root) await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('preserves gen1 bytes while another process publishes gen2', async () => {
    const Database = lbug.Database;
    vi.spyOn(lbug, 'Database').mockImplementation(function (
      dbPath?: string,
      bufferSize?: number,
      compression?: boolean,
      readOnly?: boolean,
      maxDBSize?: number,
    ) {
      return new Database(dbPath, bufferSize, compression, readOnly, maxDBSize ?? 2 ** 32);
    });

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-cross-process-'));
    repo = { id: root, repoPath: root, storagePath: path.join(root, '.ontoindex') };
    for (const args of [
      ['init', '-q'],
      ['config', 'user.name', 'test'],
      ['config', 'user.email', 'test@example.com'],
    ]) {
      expect(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status).toBe(0);
    }
    await fs.writeFile(path.join(root, 'source.ts'), 'export function baseline() {}\n');
    for (const args of [
      ['add', 'source.ts'],
      ['commit', '-qm', 'baseline'],
    ]) {
      expect(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status).toBe(0);
    }
    await fs.writeFile(path.join(root, 'source.ts'), 'export function gen1() {}\n');

    await buildFirstGeneration();
    const firstPath = await resolveOverlayDbPath(repo.storagePath);
    expect(firstPath).not.toBeNull();
    const firstCurrent = await fs.readFile(
      path.join(repo.storagePath, 'overlay', 'CURRENT'),
      'utf8',
    );
    const hashFirst = async () =>
      createHash('sha256')
        .update(await fs.readFile(firstPath!))
        .digest('hex');
    const originalHash = await hashFirst();

    await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'gen1' }]);
    await fs.writeFile(path.join(root, 'source.ts'), 'export function gen2() {}\n');
    await runChildAnalyze();

    const secondPath = await resolveOverlayDbPath(repo.storagePath);
    const secondCurrent = await fs.readFile(
      path.join(repo.storagePath, 'overlay', 'CURRENT'),
      'utf8',
    );
    expect(secondCurrent).not.toBe(firstCurrent);
    expect(secondPath).not.toBe(firstPath);
    expect(await pool.executeParameterized(overlayRepoId(repo.id), cypher, {})).toEqual([
      { name: 'gen1' },
    ]);
    // Windows forbids reading a store file while its native handle is open.
    if (process.platform !== 'win32') expect(await hashFirst()).toBe(originalHash);

    await pool.closeLbug(overlayRepoId(repo.id));
    expect(await hashFirst()).toBe(originalHash);
    await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'gen2' }]);
  }, 120_000);
});
