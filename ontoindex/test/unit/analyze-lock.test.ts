import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireAnalyzeLock } from '../../src/cli/analyze.js';

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-analyze-lock-'));
  tempDirs.push(repo);
  await fs.mkdir(path.join(repo, '.ontoindex'), { recursive: true });
  return repo;
}

async function writeLock(repo: string, record: Record<string, unknown>): Promise<string> {
  const lockPath = path.join(repo, '.ontoindex', 'analyze.lock');
  await fs.writeFile(lockPath, JSON.stringify(record), 'utf-8');
  return lockPath;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('analyze lock lifecycle', () => {
  it.each(['fresh', 'recovered'])(
    'refuses a surviving workspace group after %s lock acquisition',
    async (state) => {
      const repo = await makeRepo();
      const storage = path.join(repo, '.ontoindex');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      const exited = once(child, 'exit');
      const markerPath = path.join(storage, 'workspace-build.owner.json');
      const marker = JSON.stringify({
        parentPid: process.pid,
        childPid: child.pid,
        state: 'quarantined',
        before: { overlay: [], 'workspace-inputs': [] },
      });
      try {
        await fs.mkdir(path.join(storage, 'overlay', 'live-generation'), { recursive: true });
        await fs.writeFile(markerPath, marker);
        if (state === 'recovered') await writeLock(repo, { pid: 2_147_483_647, token: 'stale' });
        await expect(acquireAnalyzeLock(repo)).rejects.toThrow('Cannot safely recover');
        expect(await fs.readFile(markerPath, 'utf8')).toBe(marker);
        expect(await fs.stat(path.join(storage, 'overlay', 'live-generation'))).toBeDefined();
        await expect(fs.access(path.join(storage, 'analyze.lock'))).rejects.toThrow();
        await expect(fs.access(path.join(storage, 'analyze.lock.recovery'))).rejects.toThrow();
        process.kill(-child.pid!, 'SIGKILL');
        await exited;
        const lock = await acquireAnalyzeLock(repo);
        await lock.release();
        await expect(fs.access(markerPath)).rejects.toThrow();
        await expect(fs.access(path.join(storage, 'overlay', 'live-generation'))).rejects.toThrow();
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          process.kill(-child.pid!, 'SIGKILL');
          await exited;
        }
      }
    },
  );

  it.each(['malformed', 'incomplete', 'unreadable', 'active'])(
    'releases only its provisional lock when workspace ownership is %s',
    async (state) => {
      const repo = await makeRepo();
      const markerPath = path.join(repo, '.ontoindex', 'workspace-build.owner.json');
      if (state === 'unreadable') {
        await fs.mkdir(markerPath);
      } else {
        await fs.writeFile(
          markerPath,
          state === 'malformed'
            ? '{not-json'
            : JSON.stringify({
                parentPid: state === 'active' ? process.pid : 2_147_483_647,
                before: state === 'incomplete' ? {} : { overlay: [], 'workspace-inputs': [] },
              }),
        );
      }
      await expect(acquireAnalyzeLock(repo)).rejects.toThrow('Cannot safely recover');
      await expect(fs.access(path.join(repo, '.ontoindex', 'analyze.lock'))).rejects.toThrow();
      expect(await fs.stat(markerPath)).toBeDefined();
    },
  );

  it('does not displace a live owner with matching identity', async () => {
    const repo = await makeRepo();
    const lockPath = await writeLock(repo, {
      pid: process.pid,
      token: 'live',
      startedAt: new Date().toISOString(),
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

  it.each(['', '{not-json'])(
    'preserves stale diagnostics when a recovery sentinel already exists: %j',
    async (sentinel) => {
      const repo = await makeRepo();
      const storage = path.join(repo, '.ontoindex');
      const lockPath = await writeLock(repo, { pid: 2_147_483_647, token: 'blocked-recovery' });
      const checkpointPath = path.join(storage, 'analysis-checkpoint.json');
      const recoveryLockPath = `${lockPath}.recovery`;
      await fs.writeFile(checkpointPath, '{"status":"failed","reason":"preserve bytes"}\n');
      await fs.writeFile(recoveryLockPath, sentinel);
      const before = await Promise.all(
        [lockPath, recoveryLockPath, checkpointPath].map((file) => fs.readFile(file)),
      );

      await expect(acquireAnalyzeLock(repo)).rejects.toThrow('Another process is recovering');

      expect(
        await Promise.all(
          [lockPath, recoveryLockPath, checkpointPath].map((file) => fs.readFile(file)),
        ),
      ).toEqual(before);
      await expect(fs.access(path.join(storage, 'recovery'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('cleans its recovery sentinel and preserves the replacement until release', async () => {
    const repo = await makeRepo();
    const lockPath = await writeLock(repo, { pid: 2_147_483_647, token: 'stale-recovery' });
    const recoveryLockPath = `${lockPath}.recovery`;

    const lock = await acquireAnalyzeLock(repo);
    const replacement = await fs.readFile(lockPath);
    expect(JSON.parse(replacement.toString()).pid).toBe(process.pid);
    expect(JSON.parse(replacement.toString()).token).not.toBe('stale-recovery');
    await expect(fs.access(recoveryLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(acquireAnalyzeLock(repo)).rejects.toThrow('already running');
    expect(await fs.readFile(lockPath)).toEqual(replacement);
    await expect(fs.access(recoveryLockPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await lock.release();
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const reacquired = await acquireAnalyzeLock(repo);
    expect(JSON.parse(await fs.readFile(lockPath, 'utf-8')).token).not.toBe(
      JSON.parse(replacement.toString()).token,
    );
    await reacquired.release();
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(recoveryLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('admits exactly one successor after its kernel-lock owner dies before publication', async () => {
    const repo = await makeRepo();
    const storage = path.join(repo, '.ontoindex');
    const lockPath = await writeLock(repo, { pid: 2_147_483_647, token: 'crashed-recovery' });
    const checkpointPath = path.join(storage, 'analysis-checkpoint.json');
    const recoveryLockPath = `${lockPath}.recovery`;
    await fs.writeFile(checkpointPath, '{"status":"failed","reason":"owned crash"}\n');
    const before = await Promise.all([lockPath, checkpointPath].map((file) => fs.readFile(file)));
    const moduleUrl = new URL('../../src/cli/analyze.ts', import.meta.url).href;
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

    const startChild = (source: string) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', source],
        {
          cwd: packageRoot,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      let stderr = '';
      let failure: Error | undefined;
      let terminated = false;
      const messages: unknown[] = [];
      let notify: (() => void) | undefined;
      child.stdout.resume();
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4096);
      });
      child.on('message', (message) => {
        messages.push(message);
        notify?.();
      });
      const exited = new Promise<void>((resolve) => {
        child.once('error', (error) => {
          failure = error;
          notify?.();
          resolve();
        });
        child.once('exit', () => {
          terminated = true;
          notify?.();
          resolve();
        });
      });
      const deadline = async <T>(pending: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout>;
        try {
          return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Owned child deadline: ${stderr}`)), 5000);
            }),
          ]);
        } finally {
          clearTimeout(timer!);
        }
      };
      const nextMessage = async () => {
        try {
          await deadline(
            new Promise<void>((resolve, reject) => {
              notify = () => {
                if (messages.length) resolve();
                else if (failure || terminated)
                  reject(
                    new Error(
                      `Owned child stopped: ${failure?.message ?? child.signalCode ?? child.exitCode}; ${stderr}`,
                    ),
                  );
              };
              notify();
            }),
          );
          return messages.shift();
        } finally {
          notify = undefined;
        }
      };
      return { child, nextMessage, reaped: () => deadline(exited) };
    };
    const children: ReturnType<typeof startChild>[] = [];
    try {
      const recovering = startChild(`
        import fs from 'node:fs/promises';
        const keepAlive = setInterval(() => {}, 1000);
        const realOpen = fs.open.bind(fs);
        fs.open = async (...args) => {
          const handle = await realOpen(...args);
          if (typeof args[0] === 'string'
            && args[0].startsWith(${JSON.stringify(`${lockPath}.`)})
            && args[0].endsWith('.tmp') && args[1] === 'wx') {
            process.send({ type: 'publication-opened', temporaryPath: args[0] });
            await new Promise(() => {});
          }
          return handle;
        };
        const { acquireAnalyzeLock } = await import(${JSON.stringify(moduleUrl)});
        await acquireAnalyzeLock(${JSON.stringify(repo)});
        clearInterval(keepAlive);
      `);
      children.push(recovering);
      const publication = (await recovering.nextMessage()) as {
        type: string;
        temporaryPath: string;
      };
      expect(publication.type).toBe('publication-opened');
      expect(publication.temporaryPath).toMatch(/\.tmp$/);
      expect(await fs.readFile(publication.temporaryPath)).toEqual(Buffer.alloc(0));
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(recoveryLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(checkpointPath)).toEqual(before[1]);
      const archiveNames = await fs.readdir(path.join(storage, 'recovery'));
      expect(archiveNames).toHaveLength(1);
      expect(
        JSON.parse(await fs.readFile(path.join(storage, 'recovery', archiveNames[0]), 'utf8')),
      ).toMatchObject({ lock: before[0].toString(), checkpoint: before[1].toString() });
      const kernelPath = `${lockPath}.kernel`;
      const kernelBefore = await fs.stat(kernelPath);
      expect(recovering.child.kill('SIGKILL')).toBe(true);
      await recovering.reaped();
      expect(recovering.child.signalCode).toBe('SIGKILL');

      const successorSource = `
        const { acquireAnalyzeLock } = await import(${JSON.stringify(moduleUrl)});
        const keepAlive = setInterval(() => {}, 1000);
        process.once('message', async () => {
          try {
            const lock = await acquireAnalyzeLock(${JSON.stringify(repo)});
            process.once('message', async () => {
              await lock.release();
              process.send({ type: 'released' });
              clearInterval(keepAlive);
              process.disconnect();
            });
            process.send({ type: 'acquired' });
          } catch (error) {
            process.send({ type: 'rejected', code: error.code, message: error.message });
            clearInterval(keepAlive);
            process.disconnect();
          }
        });
        process.send({ type: 'ready' });
      `;
      const successors = [startChild(successorSource), startChild(successorSource)];
      children.push(...successors);
      expect(await Promise.all(successors.map((successor) => successor.nextMessage()))).toEqual([
        { type: 'ready' },
        { type: 'ready' },
      ]);
      for (const successor of successors) successor.child.send({ type: 'go' });
      const outcomes = (await Promise.all(
        successors.map((successor) => successor.nextMessage()),
      )) as Array<{ type: string; code?: string; message?: string }>;
      expect(outcomes.filter((outcome) => outcome.type === 'acquired')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.type === 'rejected')).toEqual([
        { type: 'rejected', code: 'LOCK_CONFLICT', message: expect.any(String) },
      ]);
      const winner = successors[outcomes.findIndex((outcome) => outcome.type === 'acquired')];
      await expect(fs.access(publication.temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const replacement = await fs.readFile(lockPath);
      const published = JSON.parse(replacement.toString());
      expect(published.pid).toBe(winner.child.pid);
      expect(published.token).toEqual(expect.any(String));
      expect(published.token).not.toBe('crashed-recovery');
      await expect(acquireAnalyzeLock(repo)).rejects.toMatchObject({ code: 'LOCK_CONFLICT' });
      expect(await fs.readFile(lockPath)).toEqual(replacement);
      winner.child.send({ type: 'release' });
      expect(await winner.nextMessage()).toEqual({ type: 'released' });
      await Promise.all(successors.map((successor) => successor.reaped()));
      for (const { child } of successors) {
        expect(child.exitCode).toBe(0);
        expect(child.signalCode).toBeNull();
      }
      const reacquired = await acquireAnalyzeLock(repo);
      try {
        expect(JSON.parse(await fs.readFile(lockPath, 'utf8')).token).not.toBe(published.token);
      } finally {
        await reacquired.release();
      }
      expect(await fs.readFile(checkpointPath)).toEqual(before[1]);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(recoveryLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const kernelAfter = await fs.stat(kernelPath);
      expect({ dev: kernelAfter.dev, ino: kernelAfter.ino }).toEqual({
        dev: kernelBefore.dev,
        ino: kernelBefore.ino,
      });
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await Promise.all(children.map((child) => child.reaped()));
    }
  }, 30_000);

  it.each(['', '{"pid":'])(
    'removes orphan publication staging with contents %j',
    async (contents) => {
      const repo = await makeRepo();
      const staging = path.join(
        repo,
        '.ontoindex',
        'analyze.lock.01234567-89ab-4cde-8fab-0123456789ab.tmp',
      );
      await fs.writeFile(staging, contents);
      const lock = await acquireAnalyzeLock(repo);
      try {
        await expect(fs.access(staging)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await lock.release();
      }
    },
  );

  it('preserves non-staging entries, symlinks, directories, and durable diagnostics', async () => {
    const repo = await makeRepo();
    const storage = path.join(repo, '.ontoindex');
    const names = [
      'analyze.lock.invalid.tmp',
      'analyze.lock.01234567-89ab-1cde-8fab-0123456789ab.tmp',
      'analysis-checkpoint.json',
      'archive.tmp',
    ];
    for (const name of names) await fs.writeFile(path.join(storage, name), name);
    const directory = path.join(storage, 'analyze.lock.01234567-89ab-4cde-8fab-0123456789ac.tmp');
    const symlink = path.join(storage, 'analyze.lock.01234567-89ab-4cde-8fab-0123456789ad.tmp');
    await fs.mkdir(directory);
    await fs.symlink(path.join(storage, names[0]), symlink);
    const lock = await acquireAnalyzeLock(repo);
    try {
      for (const name of names)
        expect(await fs.readFile(path.join(storage, name), 'utf8')).toBe(name);
      expect((await fs.lstat(directory)).isDirectory()).toBe(true);
      expect((await fs.lstat(symlink)).isSymbolicLink()).toBe(true);
    } finally {
      await lock.release();
    }
  });

  it('aborts staging cleanup failures before diagnostic mutation and releases the kernel lock', async () => {
    const repo = await makeRepo();
    const lockPath = await writeLock(repo, { pid: 2_147_483_647, token: 'cleanup-failure' });
    const staging = `${lockPath}.01234567-89ab-4cde-8fab-0123456789ab.tmp`;
    await fs.writeFile(staging, 'partial');
    const original = await fs.readFile(lockPath);
    const failure = Object.assign(new Error('staging unlink denied'), { code: 'EACCES' });
    const unlink = fs.unlink.bind(fs);
    const spy = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (file === staging) throw failure;
      return unlink(file);
    });
    await expect(acquireAnalyzeLock(repo)).rejects.toBe(failure);
    expect(await fs.readFile(lockPath)).toEqual(original);
    await expect(fs.access(path.join(repo, '.ontoindex', 'recovery'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    spy.mockRestore();
    const lock = await acquireAnalyzeLock(repo);
    await lock.release();
  });

  it.each(['lock', 'recovery'])(
    'validates the %s diagnostic before sweeping orphan staging',
    async (malformed) => {
      const repo = await makeRepo();
      const lockPath = await writeLock(repo, { pid: 2_147_483_647, token: 'dead' });
      const staging = `${lockPath}.01234567-89ab-4cde-8fab-0123456789ab.tmp`;
      await fs.writeFile(staging, 'partial');
      await fs.writeFile(
        `${lockPath}.recovery`,
        JSON.stringify({ pid: 2_147_483_647, token: 'dead-recovery' }),
      );
      await fs.writeFile(malformed === 'lock' ? lockPath : `${lockPath}.recovery`, '{malformed');
      await expect(acquireAnalyzeLock(repo)).rejects.toThrow('Cannot safely recover');
      expect(await fs.readFile(staging, 'utf8')).toBe('partial');
      expect(
        await fs.readFile(malformed === 'lock' ? lockPath : `${lockPath}.recovery`, 'utf8'),
      ).toBe('{malformed');
    },
  );

  it('cleans its sentinel after archive-write failure and permits a recovery retry', async () => {
    const repo = await makeRepo();
    const storage = path.join(repo, '.ontoindex');
    const lockPath = await writeLock(repo, { pid: 2_147_483_647, token: 'archive-failure' });
    const checkpointPath = path.join(storage, 'analysis-checkpoint.json');
    const recoveryLockPath = `${lockPath}.recovery`;
    const recoveryPath = path.join(storage, 'recovery');
    await fs.writeFile(checkpointPath, '{"status":"failed","reason":"archive failure"}\n');
    const before = await Promise.all([lockPath, checkpointPath].map((file) => fs.readFile(file)));
    const writeFile = fs.writeFile.bind(fs);
    const archiveFailure = Object.assign(new Error('fixture archive write failed'), {
      code: 'EIO',
    });
    const injectedPaths: string[] = [];
    const archiveWrite = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      const file = args[0];
      if (
        typeof file === 'string' &&
        path.dirname(file) === recoveryPath &&
        /^stale-analyze-.*-archive-failure\.json$/.test(path.basename(file))
      ) {
        injectedPaths.push(file);
        throw archiveFailure;
      }
      return writeFile(...args);
    });

    try {
      await expect(acquireAnalyzeLock(repo)).rejects.toBe(archiveFailure);
      expect(injectedPaths).toHaveLength(1);
      expect(
        await Promise.all([lockPath, checkpointPath].map((file) => fs.readFile(file))),
      ).toEqual(before);
      await expect(fs.access(recoveryLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readdir(recoveryPath)).toEqual([]);
    } finally {
      archiveWrite.mockRestore();
    }

    const lock = await acquireAnalyzeLock(repo);
    const archiveNames = await fs.readdir(recoveryPath);
    expect(archiveNames).toHaveLength(1);
    expect(
      JSON.parse(await fs.readFile(path.join(recoveryPath, archiveNames[0]), 'utf-8')),
    ).toMatchObject({ lock: before[0].toString(), checkpoint: before[1].toString() });
    expect(await fs.readFile(checkpointPath)).toEqual(before[1]);
    await expect(fs.access(recoveryLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await lock.release();
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform !== 'linux')(
    'treats a reused PID as stale when process identity differs',
    async () => {
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
    },
  );

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
