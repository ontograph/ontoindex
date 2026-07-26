import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireAnalyzeLock } from '../../src/cli/analyze.js';

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-analyze-lock-'));
  tempDirs.push(repo);
  await fs.mkdir(path.join(repo, '.ontoindex'), { recursive: true });
  return repo;
}

async function processIdentity(pid = process.pid): Promise<string> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
  return stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)[19];
}

async function writeLock(repo: string, record: Record<string, unknown>): Promise<string> {
  const lockPath = path.join(repo, '.ontoindex', 'analyze.lock');
  await fs.writeFile(lockPath, JSON.stringify(record), 'utf-8');
  return lockPath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('analyze lock lifecycle', () => {
  it('does not displace a live owner with matching identity', async () => {
    const repo = await makeRepo();
    const lockPath = await writeLock(repo, {
      pid: process.pid,
      token: 'live',
      startedAt: new Date().toISOString(),
      processStartIdentity: await processIdentity(),
    });

    await expect(acquireAnalyzeLock(repo)).rejects.toThrow('already running');
    await expect(fs.readFile(lockPath, 'utf-8')).resolves.toContain('"token":"live"');
  });

  it('recovers a dead owner and archives bounded diagnostics', async () => {
    const repo = await makeRepo();
    const lockPath = await writeLock(repo, {
      pid: 2_147_483_647,
      token: 'dead',
      startedAt: new Date().toISOString(),
      processStartIdentity: '1',
    });
    await fs.writeFile(
      path.join(repo, '.ontoindex', 'analysis-checkpoint.json'),
      JSON.stringify({ status: 'failed', reason: 'fixture' }),
    );

    const lock = await acquireAnalyzeLock(repo);
    const archiveNames = await fs.readdir(path.join(repo, '.ontoindex', 'recovery'));

    expect(JSON.parse(await fs.readFile(lockPath, 'utf-8')).pid).toBe(process.pid);
    expect(archiveNames).toHaveLength(1);
    expect(
      await fs.readFile(path.join(repo, '.ontoindex', 'recovery', archiveNames[0]), 'utf-8'),
    ).toContain('dead');
    await lock.release();
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('treats a reused PID as stale when process identity differs', async () => {
    const repo = await makeRepo();
    await writeLock(repo, {
      pid: process.pid,
      token: 'reused',
      startedAt: new Date().toISOString(),
      processStartIdentity: 'not-the-current-process',
    });

    const lock = await acquireAnalyzeLock(repo);
    expect(JSON.parse(await fs.readFile(lock.path, 'utf-8')).token).not.toBe('reused');
    await lock.release();
  });

  it('fails closed for a malformed lock', async () => {
    const repo = await makeRepo();
    const lockPath = path.join(repo, '.ontoindex', 'analyze.lock');
    await fs.writeFile(lockPath, '{not-json', 'utf-8');

    await expect(acquireAnalyzeLock(repo)).rejects.toThrow('Cannot safely recover');
    await expect(fs.readFile(lockPath, 'utf-8')).resolves.toBe('{not-json');
  });

  it('allows at most one concurrent replacement analysis', async () => {
    const repo = await makeRepo();
    await writeLock(repo, {
      pid: 2_147_483_647,
      token: 'dead-concurrent',
      startedAt: new Date().toISOString(),
      processStartIdentity: '1',
    });

    const results = await Promise.allSettled([acquireAnalyzeLock(repo), acquireAnalyzeLock(repo)]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireAnalyzeLock>>> =>
        result.status === 'fulfilled',
    );

    expect(fulfilled).toHaveLength(1);
    await fulfilled[0].value.release();
  });
});
