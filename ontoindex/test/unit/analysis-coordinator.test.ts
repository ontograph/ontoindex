import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cancelAnalysisJob,
  getAnalysisJob,
  submitAnalysisJob,
} from '../../src/core/analysis/analysis-coordinator.js';
import type { AnalysisJobRecord } from '../../src/core/analysis/analysis-coordinator.js';

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH;
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

describe('analysis coordinator', () => {
  it('persists and reuses one active job for the same HEAD and options', async () => {
    const repoPath = await makeRepo();
    await runGit(repoPath, ['init']);
    const runnerPath = path.join(repoPath, 'runner.mjs');
    await fs.writeFile(
      runnerPath,
      `import fs from 'node:fs/promises';
const file = process.argv[2];
const job = JSON.parse(await fs.readFile(file, 'utf8'));
job.status = 'running'; job.runnerPid = process.pid; job.startedAt = new Date().toISOString();
await fs.writeFile(file, JSON.stringify(job));
setTimeout(() => {}, 30000);
`,
    );
    process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = runnerPath;

    const first = await submitAnalysisJob({
      repoPath,
      targetHead: 'head-a',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      options: { embeddings: false },
    });
    const second = await submitAnalysisJob({
      repoPath,
      targetHead: 'head-a',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      options: { embeddings: false },
    });

    expect(first.reused).toBe(false);
    expect(second).toMatchObject({ reused: true, job: { id: first.job.id } });
    await waitFor(async () => (await getAnalysisJob(repoPath, first.job.id))?.runnerPid);
    const running = await getAnalysisJob(repoPath, first.job.id);
    expect(running).toMatchObject({ status: 'running', targetHead: 'head-a' });
    if (running?.runnerPid) await terminateProcess(running.runnerPid);
  });

  it('refuses to reuse an active job for a different target snapshot', async () => {
    const repoPath = await makeRepo();
    await runGit(repoPath, ['init']);
    const runnerPath = path.join(repoPath, 'runner.mjs');
    await fs.writeFile(runnerPath, 'setTimeout(() => {}, 30000);');
    process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = runnerPath;
    const first = await submitAnalysisJob({
      repoPath,
      targetHead: 'head-a',
      command: process.execPath,
      args: [],
      options: {},
    });

    await expect(
      submitAnalysisJob({
        repoPath,
        targetHead: 'head-b',
        command: process.execPath,
        args: [],
        options: {},
      }),
    ).rejects.toThrow('different analysis request');
    const processRecord = await waitFor(
      async () => (await getAnalysisJob(repoPath, first.job.id))?.runnerPid,
    );
    if (processRecord) await terminateProcess(processRecord);
  });

  it('refuses to reuse an active job for a different command', async () => {
    const repoPath = await makeRepo();
    await runGit(repoPath, ['init']);
    const runnerPath = path.join(repoPath, 'runner.mjs');
    await fs.writeFile(runnerPath, 'setTimeout(() => {}, 30000);');
    process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = runnerPath;
    const first = await submitAnalysisJob({
      repoPath,
      targetHead: 'head-a',
      command: process.execPath,
      args: ['first'],
      options: {},
    });

    await expect(
      submitAnalysisJob({
        repoPath,
        targetHead: 'head-a',
        command: process.execPath,
        args: ['second'],
        options: {},
      }),
    ).rejects.toThrow('different analysis request');
    const processRecord = await waitFor(
      async () => (await getAnalysisJob(repoPath, first.job.id))?.runnerPid,
    );
    if (processRecord) await terminateProcess(processRecord);
  });

  it('removes expired terminal job records and logs', async () => {
    const repoPath = await makeRepo();
    const job = makeJob(repoPath, {
      status: 'complete',
      completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    await writeJobFixture(job);
    await fs.writeFile(job.logPath, 'old log');

    await expect(getAnalysisJob(repoPath, job.id)).resolves.toBeNull();
    await expect(exists(job.logPath)).resolves.toBe(false);
  });

  it('marks an abandoned running job as failed', async () => {
    const repoPath = await makeRepo();
    const job = makeJob(repoPath, { runnerPid: 2_147_483_647 });
    await writeJobFixture(job);

    await expect(getAnalysisJob(repoPath, job.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'Analysis runner is no longer active.',
    });
  });

  it('submits without synchronously reading the source snapshot', async () => {
    const repoPath = await makeRepo();
    process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = await writeCompletingRunner(repoPath);

    await expect(
      submitAnalysisJob({
        repoPath,
        targetHead: 'head-a',
        command: process.execPath,
        args: [],
        options: {},
      }),
    ).resolves.toMatchObject({ reused: false, job: { targetHead: 'head-a' } });
  });

  it('rejects a missing repository without creating it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-analysis-job-missing-'));
    tempDirs.push(root);
    const repoPath = path.join(root, 'missing');

    await expect(
      submitAnalysisJob({
        repoPath,
        targetHead: 'head-a',
        command: process.execPath,
        args: [],
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(repoPath)).rejects.toThrow();
  });

  it.skipIf(process.platform !== 'linux')(
    'rejects a reused pid when the process start identity differs',
    async () => {
      const repoPath = await makeRepo();
      const job = makeJob(repoPath, {
        runnerPid: process.pid,
        runnerProcessStartIdentity: 'not-this-process',
      });
      await writeJobFixture(job);

      await expect(getAnalysisJob(repoPath, job.id)).resolves.toMatchObject({ status: 'failed' });
    },
  );

  it('submits after nested untracked content changes without a synchronous source scan', async () => {
    const repoPath = await makeRepo();
    await runGit(repoPath, ['init']);
    const runnerPath = path.join(repoPath, 'runner.mjs');
    await fs.writeFile(
      runnerPath,
      `import fs from 'node:fs/promises';
const file = process.argv[2];
const job = JSON.parse(await fs.readFile(file, 'utf8'));
job.status = 'complete'; job.completedAt = new Date().toISOString();
await fs.writeFile(file, JSON.stringify(job));
`,
    );
    process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = runnerPath;

    const first = await submitAnalysisJob({
      repoPath,
      targetHead: 'head-a',
      command: process.execPath,
      args: [],
      options: {},
    });
    await waitFor(async () => {
      const job = await getAnalysisJob(repoPath, first.job.id);
      return job?.status === 'complete' ? job : undefined;
    });

    const nested = path.join(repoPath, 'nested', 'source.ts');
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, 'export const value = 1;\n');
    const second = await submitAnalysisJob({
      repoPath,
      targetHead: 'head-a',
      command: process.execPath,
      args: [],
      options: {},
    });

    expect(first.job.sourceManifestDigest).toBeUndefined();
    expect(second.job.sourceManifestDigest).toBeUndefined();
  });

  it('submits when an untracked embedded repository is a dirty status entry', async () => {
    const repoPath = await makeRepo();
    await runGit(repoPath, ['init']);
    await fs.mkdir(path.join(repoPath, 'embedded'));
    await runGit(path.join(repoPath, 'embedded'), ['init']);
    process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = await writeCompletingRunner(repoPath);

    const result = await submitAnalysisJob({
      repoPath,
      targetHead: 'head-a',
      command: process.execPath,
      args: [],
      options: {},
    });

    expect(result.job.sourceManifestDigest).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'submits without following an untracked symlink to a directory',
    async () => {
      const repoPath = await makeRepo();
      await runGit(repoPath, ['init']);
      await fs.mkdir(path.join(repoPath, 'target'));
      await fs.writeFile(path.join(repoPath, 'target', 'inner.ts'), 'export const value = 1;\n');
      await fs.symlink('target', path.join(repoPath, 'link'));
      process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = await writeCompletingRunner(repoPath);

      const result = await submitAnalysisJob({
        repoPath,
        targetHead: 'head-a',
        command: process.execPath,
        args: [],
        options: {},
      });

      expect(result.job.sourceManifestDigest).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'submits when a dirty status entry is a dangling symlink',
    async () => {
      const repoPath = await makeRepo();
      await runGit(repoPath, ['init']);
      await fs.symlink('missing-target', path.join(repoPath, 'dangling'));
      process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = await writeCompletingRunner(repoPath);

      const result = await submitAnalysisJob({
        repoPath,
        targetHead: 'head-a',
        command: process.execPath,
        args: [],
        options: {},
      });

      expect(result.job.sourceManifestDigest).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not report cancellation until the analyzer process group exits',
    async () => {
      const repoPath = await makeRepo();
      await runGit(repoPath, ['init']);
      const childPidPath = path.join(repoPath, 'child.pid');
      const analyzerPath = path.join(repoPath, 'analyzer.mjs');
      await fs.writeFile(
        analyzerPath,
        `import { spawn } from 'node:child_process';
import fs from 'node:fs';
 const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)']);
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
setInterval(() => {}, 1000);
`,
      );
      process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = path.resolve(
        'dist/core/analysis/analysis-job-runner.js',
      );

      const submitted = await submitAnalysisJob({
        repoPath,
        targetHead: 'head-a',
        command: process.execPath,
        args: [analyzerPath],
        options: {},
      });
      const running = await waitFor(async () => {
        const job = await getAnalysisJob(repoPath, submitted.job.id);
        return job?.status === 'running' && (await exists(childPidPath)) ? job : undefined;
      });
      expect(running?.status).toBe('running');

      await cancelAnalysisJob(repoPath, submitted.job.id);
      const immediate = await getAnalysisJob(repoPath, submitted.job.id);
      expect(immediate?.status).toBe('running');

      const cancelled = await waitFor(
        async () => {
          const job = await getAnalysisJob(repoPath, submitted.job.id);
          return job?.status === 'cancelled' ? job : undefined;
        },
        400,
        20,
      );
      expect(cancelled?.status).toBe('cancelled');
      const childPid = Number(await fs.readFile(childPidPath, 'utf8'));
      expect(isAlive(childPid)).toBe(false);
    },
    15_000,
  );
});

async function makeRepo(): Promise<string> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-analysis-job-'));
  tempDirs.push(repoPath);
  await fs.mkdir(path.join(repoPath, '.ontoindex'));
  return repoPath;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  attempts = 50,
  delayMs = 20,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return undefined;
}

async function writeCompletingRunner(repoPath: string): Promise<string> {
  const runnerPath = path.join(repoPath, 'runner.mjs');
  await fs.writeFile(
    runnerPath,
    `import fs from 'node:fs/promises';
const file = process.argv[2];
const job = JSON.parse(await fs.readFile(file, 'utf8'));
job.status = 'complete'; job.completedAt = new Date().toISOString();
await fs.writeFile(file, JSON.stringify(job));
`,
  );
  return runnerPath;
}

async function exists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    () => true,
    () => false,
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(pid: number): Promise<void> {
  process.kill(pid, 'SIGTERM');
  if (await waitFor(async () => (isAlive(pid) ? undefined : true), 100, 50)) return;

  process.kill(pid, 'SIGKILL');
  if (!(await waitFor(async () => (isAlive(pid) ? undefined : true), 100, 50))) {
    throw new Error(`Process ${pid} did not exit during test cleanup`);
  }
}

function makeJob(repoPath: string, overrides: Partial<AnalysisJobRecord>): AnalysisJobRecord {
  const id = '00000000-0000-4000-8000-000000000001';
  return {
    version: 1,
    id,
    status: 'running',
    repoPath,
    targetHead: 'head-a',
    sourceManifestDigest: 'source',
    optionsDigest: 'options',
    command: process.execPath,
    args: [],
    logPath: path.join(repoPath, '.ontoindex', 'analysis-jobs', `${id}.log`),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function writeJobFixture(job: AnalysisJobRecord): Promise<void> {
  const dir = path.join(job.repoPath, '.ontoindex', 'analysis-jobs');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${job.id}.json`), JSON.stringify(job));
  await fs.writeFile(path.join(dir, 'active'), job.id);
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    execFile('git', args, { cwd }, (error) => (error ? reject(error) : resolve()));
  });
}
