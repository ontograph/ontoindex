import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cancelAnalysisJob,
  completeAnalysisJob,
  getAnalysisJob,
  submitAnalysisJob as submitAnalysisJobCore,
} from '../../src/core/analysis/analysis-coordinator.js';
import type {
  AnalysisJobLifecycleUpdate,
  AnalysisJobRecord,
  SubmitAnalysisJobInput,
} from '../../src/core/analysis/analysis-coordinator.js';
import type { AnalysisRequestedCapabilities } from '../../src/core/analysis/analysis-publication-receipt.js';

const TEST_HEAD = 'a'.repeat(40);
const TEST_HEAD_B = 'b'.repeat(40);
const SOURCE_IDENTITY = `commit:${TEST_HEAD}`;
const SOURCE_IDENTITY_B = `commit:${TEST_HEAD_B}`;
const SOURCE_MANIFEST_DIGEST = 'c'.repeat(64);
const EMBEDDING_MODEL_HASH = 'test-embedding-model';
const GRAPH_ONLY: AnalysisRequestedCapabilities = {
  version: 1,
  graph: true,
  graphCapabilities: ['symbols'],
  embeddings: false,
  embeddingModelHash: null,
};
const GRAPH_AND_EMBEDDINGS: AnalysisRequestedCapabilities = {
  version: 1,
  graph: true,
  graphCapabilities: ['symbols'],
  embeddings: true,
  embeddingModelHash: EMBEDDING_MODEL_HASH,
};

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH;
  delete process.env.ONTOINDEX_TEST_INHERITED_ANALYSIS_ENV;
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
      targetHead: TEST_HEAD,
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      options: { embeddings: false },
      requestedCapabilities: GRAPH_ONLY,
      sourceIdentity: SOURCE_IDENTITY,
    });
    const second = await submitAnalysisJob({
      repoPath,
      targetHead: TEST_HEAD,
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      options: { embeddings: false },
      requestedCapabilities: GRAPH_ONLY,
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(first.reused).toBe(false);
    expect(second).toMatchObject({ reused: true, job: { id: first.job.id } });
    await waitFor(async () => (await getAnalysisJob(repoPath, first.job.id))?.runnerPid);
    const running = await getAnalysisJob(repoPath, first.job.id);
    expect(running).toMatchObject({
      status: 'running',
      targetHead: TEST_HEAD,
      requestedCapabilities: GRAPH_ONLY,
      sourceIdentity: SOURCE_IDENTITY,
    });
    if (running?.runnerPid) await terminateProcess(running.runnerPid);
  });

  it('does not reuse an active job when source identity is unknown', async () => {
    const repoPath = await makeRepo();
    const activeJob = makeJob(repoPath, {
      status: 'running',
      runnerPid: process.pid,
      sourceIdentity: undefined as unknown as string,
      optionsDigest: requestDigest(process.execPath, [], {}, GRAPH_ONLY, undefined),
    });
    await writeJobFixture(activeJob);

    await expect(
      submitAnalysisJob({
        repoPath,
        targetHead: TEST_HEAD,
        command: process.execPath,
        args: [],
        options: {},
        requestedCapabilities: GRAPH_ONLY,
        sourceIdentity: SOURCE_IDENTITY,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVE_JOB_CONFLICT', activeJobId: activeJob.id });
  });

  it('treats a legacy active job without requested capabilities as incompatible', async () => {
    const repoPath = await makeRepo();
    const activeJob = makeJob(repoPath, {
      status: 'running',
      runnerPid: process.pid,
      requestedCapabilities: undefined as unknown as AnalysisJobRecord['requestedCapabilities'],
      optionsDigest: requestDigest(process.execPath, [], {}, GRAPH_ONLY, SOURCE_IDENTITY),
    });
    await writeJobFixture(activeJob);

    await expect(
      submitAnalysisJob({
        repoPath,
        targetHead: TEST_HEAD,
        command: process.execPath,
        args: [],
        options: {},
        requestedCapabilities: GRAPH_ONLY,
        sourceIdentity: SOURCE_IDENTITY,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVE_JOB_CONFLICT', activeJobId: activeJob.id });
  });

  it('refuses to reuse an active job for a different target snapshot', async () => {
    const repoPath = await makeRepo();
    const activeJob = makeJob(repoPath, {
      status: 'running',
      runnerPid: process.pid,
      optionsDigest: requestDigest(process.execPath, [], {}, GRAPH_ONLY, SOURCE_IDENTITY),
      sourceIdentity: SOURCE_IDENTITY,
    });
    await writeJobFixture(activeJob);

    await expect(
      submitAnalysisJob({
        repoPath,
        targetHead: TEST_HEAD_B,
        command: process.execPath,
        args: [],
        options: {},
        sourceIdentity: SOURCE_IDENTITY_B,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVE_JOB_CONFLICT', activeJobId: activeJob.id });
  });

  it('refuses to reuse an active job for a different command', async () => {
    const repoPath = await makeRepo();
    const activeJob = makeJob(repoPath, {
      status: 'running',
      runnerPid: process.pid,
      targetHead: TEST_HEAD,
      optionsDigest: requestDigest(process.execPath, ['first'], {}, GRAPH_ONLY, SOURCE_IDENTITY),
      sourceIdentity: SOURCE_IDENTITY,
    });
    await writeJobFixture(activeJob);

    await expect(
      submitAnalysisJob({
        repoPath,
        targetHead: TEST_HEAD,
        command: process.execPath,
        args: ['second'],
        options: {},
        sourceIdentity: SOURCE_IDENTITY,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVE_JOB_CONFLICT', activeJobId: activeJob.id });
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
        targetHead: TEST_HEAD,
        command: process.execPath,
        args: [],
        options: {},
        sourceIdentity: SOURCE_IDENTITY,
      }),
    ).resolves.toMatchObject({
      reused: false,
      job: { targetHead: TEST_HEAD, sourceManifestDigest: SOURCE_MANIFEST_DIGEST },
    });
  });

  it('removes a newly written job record when active marker acquisition fails', async () => {
    const repoPath = await makeRepo();
    const dir = path.join(repoPath, '.ontoindex', 'analysis-jobs');
    await fs.mkdir(path.join(dir, 'active'), { recursive: true });

    await expect(
      submitAnalysisJob({
        repoPath,
        targetHead: TEST_HEAD,
        command: process.execPath,
        args: [],
        options: {},
        sourceIdentity: SOURCE_IDENTITY,
      }),
    ).rejects.toThrow();

    const entries = await fs.readdir(dir);
    expect(entries.filter((entry) => entry.endsWith('.json'))).toEqual([]);
  });

  it('fails closed without replacing a malformed active mutation lock', async () => {
    const repoPath = await makeRepo();
    const dir = path.join(repoPath, '.ontoindex', 'analysis-jobs');
    const lockPath = path.join(dir, 'active.mutation.lock');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(lockPath, '{"version":1');

    await expect(
      submitAnalysisJob({
        repoPath,
        targetHead: TEST_HEAD,
        command: process.execPath,
        args: [],
        options: {},
        sourceIdentity: SOURCE_IDENTITY,
      }),
    ).rejects.toThrow('malformed analysis active mutation lock');
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe('{"version":1');
  });

  it('reclaims a stale structured recovery sentinel and mutation lock', async () => {
    const repoPath = await makeRepo();
    const dir = path.join(repoPath, '.ontoindex', 'analysis-jobs');
    const lockPath = path.join(dir, 'active.mutation.lock');
    const deadOwner = {
      version: 1,
      token: 'dead-owner',
      pid: 2_147_483_647,
      processStartIdentity: 'dead-process',
      acquiredAt: new Date().toISOString(),
      repoPath,
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify(deadOwner));
    await fs.writeFile(
      `${lockPath}.recovery`,
      JSON.stringify({ ...deadOwner, token: 'dead-recovery' }),
    );
    const staleClaimPath = `${lockPath}.recovery.claim.${deadOwner.pid}.${Buffer.from(deadOwner.processStartIdentity).toString('hex')}.abandoned`;
    await fs.writeFile(staleClaimPath, JSON.stringify({ ...deadOwner, token: 'older-recovery' }));
    process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = await writeCompletingRunner(repoPath);

    await expect(
      submitAnalysisJob({
        repoPath,
        targetHead: TEST_HEAD,
        command: process.execPath,
        args: [],
        options: {},
        sourceIdentity: SOURCE_IDENTITY,
      }),
    ).resolves.toMatchObject({ reused: false });
    await expect(exists(`${lockPath}.recovery`)).resolves.toBe(false);
    await expect(exists(staleClaimPath)).resolves.toBe(false);
  });

  it('does not copy current graph metadata into a completed job', async () => {
    const repoPath = await makeRepo();
    const job = makeJob(repoPath, { status: 'running' });
    await writeJobFixture(job);
    await fs.writeFile(
      path.join(repoPath, '.ontoindex', 'meta.json'),
      JSON.stringify({ generationId: 'unproven-current-generation' }),
    );

    const forgedUpdate: AnalysisJobLifecycleUpdate & {
      generationId: string;
      sourceManifestDigest: string;
    } = {
      status: 'complete',
      completedAt: new Date().toISOString(),
      exitCode: 0,
      generationId: 'forged-generation',
      sourceManifestDigest: 'f'.repeat(64),
    };
    const completed = await completeAnalysisJob(jobFile(job), forgedUpdate);

    expect(completed.generationId).toBeUndefined();
    expect(completed.sourceManifestDigest).toBe(SOURCE_MANIFEST_DIGEST);
    expect(completed.status).toBe('failed');
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

  it('refuses cancellation with structured evidence when process identity is unavailable', async () => {
    const repoPath = await makeRepo();
    const job = makeJob(repoPath, {
      runnerPid: process.pid,
      runnerProcessStartIdentity: undefined,
    });
    await writeJobFixture(job);
    const kill = vi.spyOn(process, 'kill').mockImplementation(((_pid, signal) => {
      if (signal === 0) return true;
      return true;
    }) as typeof process.kill);

    try {
      await expect(cancelAnalysisJob(repoPath, job.id)).resolves.toMatchObject({
        cancelled: false,
        refusal: {
          reasonCode: 'PROCESS_IDENTITY_UNAVAILABLE',
        },
      });
      expect(kill.mock.calls.some(([, signal]) => signal === 'SIGTERM')).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

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
      targetHead: TEST_HEAD,
      command: process.execPath,
      args: [],
      options: {},
      sourceIdentity: SOURCE_IDENTITY,
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
      targetHead: TEST_HEAD,
      command: process.execPath,
      args: [],
      options: {},
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(first.job.sourceManifestDigest).toBe(SOURCE_MANIFEST_DIGEST);
    expect(second.job.sourceManifestDigest).toBe(SOURCE_MANIFEST_DIGEST);
  });

  it('submits when an untracked embedded repository is a dirty status entry', async () => {
    const repoPath = await makeRepo();
    await runGit(repoPath, ['init']);
    await fs.mkdir(path.join(repoPath, 'embedded'));
    await runGit(path.join(repoPath, 'embedded'), ['init']);
    process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = await writeCompletingRunner(repoPath);

    const result = await submitAnalysisJob({
      repoPath,
      targetHead: TEST_HEAD,
      command: process.execPath,
      args: [],
      options: {},
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(result.job.sourceManifestDigest).toBe(SOURCE_MANIFEST_DIGEST);
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
        targetHead: TEST_HEAD,
        command: process.execPath,
        args: [],
        options: {},
        sourceIdentity: SOURCE_IDENTITY,
      });

      expect(result.job.sourceManifestDigest).toBe(SOURCE_MANIFEST_DIGEST);
    },
  );

  it('passes validated managed identity to the analyzer and preserves inherited env', async () => {
    const repoPath = await makeRepo();
    const receivedPath = path.join(repoPath, 'received-env.json');
    const analyzerPath = path.join(repoPath, 'capture-env.mjs');
    await fs.writeFile(
      analyzerPath,
      `import fs from 'node:fs/promises';
await fs.writeFile(process.argv[2], JSON.stringify({
  inherited: process.env.ONTOINDEX_TEST_INHERITED_ANALYSIS_ENV,
  jobId: process.env.ONTOINDEX_ANALYSIS_JOB_ID,
  targetHead: process.env.ONTOINDEX_ANALYSIS_TARGET_HEAD,
  optionsDigest: process.env.ONTOINDEX_ANALYSIS_OPTIONS_DIGEST,
  requestedCapabilities: process.env.ONTOINDEX_ANALYSIS_REQUESTED_CAPABILITIES,
  sourceIdentity: process.env.ONTOINDEX_ANALYSIS_SOURCE_IDENTITY,
  sourceManifestDigest: process.env.ONTOINDEX_ANALYSIS_SOURCE_MANIFEST_DIGEST,
  embeddingModelHash: process.env.ONTOINDEX_EMBEDDING_MODEL_HASH,
}));
`,
    );
    process.env.ONTOINDEX_TEST_INHERITED_ANALYSIS_ENV = 'preserved';
    process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = path.resolve(
      'dist/core/analysis/analysis-job-runner.js',
    );

    const submitted = await submitAnalysisJob({
      repoPath,
      targetHead: TEST_HEAD,
      command: process.execPath,
      args: [analyzerPath, receivedPath],
      options: { withEmbeddings: true },
      requestedCapabilities: GRAPH_AND_EMBEDDINGS,
      sourceIdentity: SOURCE_IDENTITY,
    });
    await waitFor(async () => ((await exists(receivedPath)) ? true : undefined));
    const received = JSON.parse(await fs.readFile(receivedPath, 'utf8')) as Record<string, string>;

    expect(received).toEqual({
      inherited: 'preserved',
      jobId: submitted.job.id,
      targetHead: TEST_HEAD,
      optionsDigest: submitted.job.optionsDigest,
      requestedCapabilities: JSON.stringify(GRAPH_AND_EMBEDDINGS),
      sourceIdentity: SOURCE_IDENTITY,
      sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
      embeddingModelHash: EMBEDDING_MODEL_HASH,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'submits when a dirty status entry is a dangling symlink',
    async () => {
      const repoPath = await makeRepo();
      await runGit(repoPath, ['init']);
      await fs.symlink('missing-target', path.join(repoPath, 'dangling'));
      process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH = await writeCompletingRunner(repoPath);

      const result = await submitAnalysisJob({
        repoPath,
        targetHead: TEST_HEAD,
        command: process.execPath,
        args: [],
        options: {},
        sourceIdentity: SOURCE_IDENTITY,
      });

      expect(result.job.sourceManifestDigest).toBe(SOURCE_MANIFEST_DIGEST);
    },
  );

  it.skipIf(process.platform !== 'linux')(
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
        targetHead: TEST_HEAD,
        command: process.execPath,
        args: [analyzerPath],
        options: {},
        sourceIdentity: `commit:${TEST_HEAD}`,
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

function requestDigest(
  command: string,
  args: string[],
  options: Record<string, unknown>,
  requestedCapabilities: AnalysisJobRecord['requestedCapabilities'],
  sourceIdentity: string | undefined,
  sourceManifestDigest = SOURCE_MANIFEST_DIGEST,
): string {
  return createHash('sha256')
    .update(
      stableJson({
        args,
        command,
        options,
        requestedCapabilities,
        sourceIdentity: sourceIdentity ?? null,
        sourceManifestDigest,
      }),
    )
    .digest('hex');
}

function makeJob(repoPath: string, overrides: Partial<AnalysisJobRecord>): AnalysisJobRecord {
  const id = '00000000-0000-4000-8000-000000000001';
  return {
    version: 1,
    id,
    status: 'running',
    repoPath,
    targetHead: TEST_HEAD,
    requestedCapabilities: GRAPH_ONLY,
    sourceIdentity: SOURCE_IDENTITY,
    sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
    optionsDigest: 'e'.repeat(64),
    command: process.execPath,
    args: [],
    logPath: path.join(repoPath, '.ontoindex', 'analysis-jobs', `${id}.log`),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}

function submitAnalysisJob(
  input: Omit<SubmitAnalysisJobInput, 'requestedCapabilities' | 'sourceManifestDigest'> &
    Partial<Pick<SubmitAnalysisJobInput, 'requestedCapabilities' | 'sourceManifestDigest'>>,
) {
  return submitAnalysisJobCore({
    ...input,
    requestedCapabilities: input.requestedCapabilities ?? GRAPH_ONLY,
    sourceManifestDigest: input.sourceManifestDigest ?? SOURCE_MANIFEST_DIGEST,
  });
}

function jobFile(job: AnalysisJobRecord): string {
  return path.join(job.repoPath, '.ontoindex', 'analysis-jobs', `${job.id}.json`);
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
