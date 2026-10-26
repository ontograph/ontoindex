import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import {
  superviseWorkspaceBuild,
  sweepOrphanedWorkspaceBuild,
  WorkspaceBuildError,
} from '../../src/mcp/local/workspace-build-supervisor.js';

describe('superviseWorkspaceBuild', () => {
  let storage: string;
  beforeEach(async () => {
    storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-supervisor-'));
    await fs.mkdir(path.join(storage, 'overlay', 'old-gen'), { recursive: true });
    await fs.writeFile(path.join(storage, 'overlay', 'CURRENT'), 'old-gen\n');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(storage, { recursive: true, force: true });
  });

  const run = (script: string, timeoutMs = 10_000, signal?: AbortSignal) =>
    superviseWorkspaceBuild({
      command: process.execPath,
      args: ['-e', script],
      cwd: storage,
      storagePath: storage,
      timeoutMs,
      signal,
      reapMs: 3000,
    });
  const strand = `
    const fs = require('fs'); const path = require('path');
    const storage = ${JSON.stringify('__STORAGE__')};
  `;
  const withStorage = (body: string) => strand.replace('__STORAGE__', storage) + body;

  it('refuses a pre-aborted build without creating an owner marker', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      run("require('fs').writeFileSync('started', '')", 10_000, controller.signal),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(await fs.readdir(storage)).toEqual(['overlay']);
  });

  it('cancels the process group and cleans its unpublished artifacts', async () => {
    const controller = new AbortController();
    const pidFile = path.join(storage, 'grandchild.pid');
    const pending = run(
      withStorage(`
      fs.mkdirSync(path.join(storage, 'overlay', 'partial-gen'));
      fs.mkdirSync(path.join(storage, 'workspace-inputs', 'capture'), { recursive: true });
      const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      setInterval(() => {}, 1000);`),
      10_000,
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await vi.waitFor(async () => expect(await fs.readFile(pidFile, 'utf8')).toMatch(/^\d+$/));
    controller.abort();
    await rejected;
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await fs.readdir(path.join(storage, 'overlay'))).sort()).toEqual([
      'CURRENT',
      'old-gen',
    ]);
    expect(await fs.readdir(path.join(storage, 'workspace-inputs'))).toEqual([]);
    await expect(fs.stat(path.join(storage, 'workspace-build.owner.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('lets a cooperative build handle SIGTERM without escalation', async () => {
    const controller = new AbortController();
    const kill = vi.spyOn(process, 'kill');
    const ready = path.join(storage, 'ready');
    const handled = path.join(storage, 'term-handled');
    const pending = run(
      withStorage(`
      fs.mkdirSync(path.join(storage, 'overlay', 'partial-gen'));
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(handled)}, 'handled');
        process.exit(0);
      });
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setInterval(() => {}, 1000);`),
      10_000,
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await vi.waitFor(async () => expect(await fs.readFile(ready, 'utf8')).toMatch(/^\d+$/));
    const pid = Number(await fs.readFile(ready, 'utf8'));
    controller.abort();
    await rejected;
    expect(await fs.readFile(handled, 'utf8')).toBe('handled');
    expect(kill.mock.calls.filter(([target, signal]) => target === -pid && signal !== 0)).toEqual([
      [-pid, 'SIGTERM'],
    ]);
    expect((await fs.readdir(path.join(storage, 'overlay'))).sort()).toEqual([
      'CURRENT',
      'old-gen',
    ]);
    await expect(fs.stat(path.join(storage, 'workspace-build.owner.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('escalates a build that ignores SIGTERM after two seconds and cleans within five', async () => {
    const controller = new AbortController();
    const signals: Array<{
      target: number;
      signal: NodeJS.Signals | number | undefined;
      at: number;
    }> = [];
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (signal !== 0) signals.push({ target, signal, at: Date.now() });
      return realKill(target, signal);
    });
    const ready = path.join(storage, 'ready');
    const handled = path.join(storage, 'term-handled');
    const pending = run(
      withStorage(`
      fs.mkdirSync(path.join(storage, 'overlay', 'partial-gen'));
      process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(handled)}, 'ignored'));
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setInterval(() => {}, 1000);`),
      10_000,
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await vi.waitFor(async () => expect(await fs.readFile(ready, 'utf8')).toMatch(/^\d+$/));
    const pid = Number(await fs.readFile(ready, 'utf8'));
    const started = Date.now();
    controller.abort();
    await rejected;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await fs.readFile(handled, 'utf8')).toBe('ignored');
    const groupSignals = signals.filter(({ target }) => target === -pid);
    expect(groupSignals.map(({ signal }) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(groupSignals[1].at - groupSignals[0].at).toBeGreaterThanOrEqual(1900);
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await fs.readdir(path.join(storage, 'overlay'))).sort()).toEqual([
      'CURRENT',
      'old-gen',
    ]);
    await expect(fs.stat(path.join(storage, 'workspace-build.owner.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('kills a build that outlives its deadline and removes what it left behind', async () => {
    const script = withStorage(`
      fs.mkdirSync(path.join(storage, 'overlay', 'partial-gen'));
      fs.writeFileSync(path.join(storage, 'overlay', '.CURRENT-partial.tmp'), 'x');
      fs.mkdirSync(path.join(storage, 'workspace-inputs', 'capture-1'), { recursive: true });
      setInterval(() => {}, 1000);`);
    const started = Date.now();
    const error = await run(script, 600).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceBuildError);
    expect((error as WorkspaceBuildError).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await fs.readdir(path.join(storage, 'overlay'))).sort()).toEqual([
      'CURRENT',
      'old-gen',
    ]);
    expect(await fs.readdir(path.join(storage, 'workspace-inputs'))).toEqual([]);
    expect(await fs.readFile(path.join(storage, 'overlay', 'CURRENT'), 'utf8')).toBe('old-gen\n');
  });

  it('kills a grandchild that would otherwise outlive the build', async () => {
    const pidFile = path.join(storage, 'grandchild.pid');
    const script = withStorage(`
      const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      setInterval(() => {}, 1000);`);
    await run(script, 800).catch(() => undefined);
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reports a failing build with its stderr and cleans partial artifacts', async () => {
    const script = withStorage(`
      fs.mkdirSync(path.join(storage, 'overlay', 'half-gen'));
      console.error('parser exploded'); process.exit(3);`);
    const error = (await run(script).catch((e: unknown) => e)) as WorkspaceBuildError;
    expect(error.kind).toBe('failed');
    expect(error.message).toContain('code 3');
    expect(error.message).toContain('parser exploded');
    expect((await fs.readdir(path.join(storage, 'overlay'))).sort()).toEqual([
      'CURRENT',
      'old-gen',
    ]);
  });

  it('keeps what a successful build published', async () => {
    const script = withStorage(`
      fs.mkdirSync(path.join(storage, 'overlay', 'new-gen'));
      fs.writeFileSync(path.join(storage, 'overlay', 'CURRENT'), 'new-gen\\n');`);
    await run(script);
    expect((await fs.readdir(path.join(storage, 'overlay'))).sort()).toEqual([
      'CURRENT',
      'new-gen',
      'old-gen',
    ]);
  });

  it('never deletes a generation that became current before the kill', async () => {
    const script = withStorage(`
      fs.mkdirSync(path.join(storage, 'overlay', 'published-gen'));
      fs.writeFileSync(path.join(storage, 'overlay', 'CURRENT'), 'published-gen\\n');
      setInterval(() => {}, 1000);`);
    await run(script, 600).catch(() => undefined);
    expect(await fs.readdir(path.join(storage, 'overlay', 'published-gen'))).toEqual([]);
    expect(await fs.readFile(path.join(storage, 'overlay', 'CURRENT'), 'utf8')).toBe(
      'published-gen\n',
    );
  });

  it('reports a spawn failure', async () => {
    const error = await superviseWorkspaceBuild({
      command: path.join(storage, 'no-such-binary'),
      args: [],
      cwd: storage,
      storagePath: storage,
      timeoutMs: 2000,
    }).catch((e: unknown) => e);
    expect((error as WorkspaceBuildError).kind).toBe('failed');
  });

  it('refuses to spawn with an unreadable artifact snapshot', async () => {
    const read = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation(((directory: string) => {
      if (directory === path.join(storage, 'overlay')) {
        return Promise.reject(Object.assign(new Error('snapshot denied'), { code: 'EACCES' }));
      }
      return read(directory);
    }) as typeof fs.readdir);
    await expect(run('0')).rejects.toThrow('snapshot denied');
    await expect(fs.stat(path.join(storage, 'workspace-build.owner.json'))).rejects.toThrow();
    expect(await fs.stat(path.join(storage, 'overlay', 'old-gen'))).toBeDefined();
  });

  it('reaps its child but retains evidence when child identity publication fails', async () => {
    const write = fs.writeFile.bind(fs);
    let childPid: number | undefined;
    vi.spyOn(fs, 'writeFile').mockImplementation(((filename: string, data: string) => {
      if (filename === path.join(storage, 'workspace-build.owner.json')) {
        childPid = JSON.parse(data).childPid;
        if (childPid) return Promise.reject(new Error('identity publication denied'));
      }
      return write(filename, data);
    }) as typeof fs.writeFile);
    const error = await run('setInterval(() => {}, 1000)').catch(
      (error: WorkspaceBuildError) => error,
    );
    expect(error).toMatchObject({ kind: 'unstoppable' });
    expect(error!.message).toContain('owner identity could not be recorded');
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid!, 0)).toThrow();
    const marker = JSON.parse(
      await fs.readFile(path.join(storage, 'workspace-build.owner.json'), 'utf8'),
    );
    expect(marker.parentPid).toBe(process.pid);
    expect(marker.childPid).toBeUndefined();
    await expect(run('0')).rejects.toThrow('Cannot safely recover');
  });

  describe('sweepOrphanedWorkspaceBuild', () => {
    const deadPid = () => {
      const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
      return Number(r.stdout.toString());
    };
    const leave = async (marker: Record<string, unknown>) => {
      // Entries that predate the build and are not the current generation must survive.
      await fs.mkdir(path.join(storage, 'overlay', 'prior-gen'));
      await fs.mkdir(path.join(storage, 'workspace-inputs', 'capture-prior'), { recursive: true });
      await fs.mkdir(path.join(storage, 'overlay', 'orphan-gen'));
      await fs.writeFile(path.join(storage, 'overlay', '.CURRENT-orphan.tmp'), 'x');
      await fs.mkdir(path.join(storage, 'workspace-inputs', 'capture-orphan'), { recursive: true });
      await fs.writeFile(
        path.join(storage, 'workspace-build.owner.json'),
        JSON.stringify({
          before: {
            overlay: ['CURRENT', 'old-gen', 'prior-gen'],
            'workspace-inputs': ['capture-prior'],
          },
          ...marker,
        }),
      );
    };

    it('removes what a dead owner left and keeps what predates the build', async () => {
      await leave({ parentPid: deadPid() });
      expect(await sweepOrphanedWorkspaceBuild(storage)).toBe(true);
      expect((await fs.readdir(path.join(storage, 'overlay'))).sort()).toEqual([
        'CURRENT',
        'old-gen',
        'prior-gen',
      ]);
      expect(await fs.readdir(path.join(storage, 'workspace-inputs'))).toEqual(['capture-prior']);
      await expect(fs.stat(path.join(storage, 'workspace-build.owner.json'))).rejects.toThrow();
    });

    it('does nothing while the owner is alive', async () => {
      await leave({ parentPid: process.ppid });
      expect(await sweepOrphanedWorkspaceBuild(storage)).toBe(false);
      expect((await fs.readdir(path.join(storage, 'workspace-inputs'))).sort()).toEqual([
        'capture-orphan',
        'capture-prior',
      ]);
    });

    it('does nothing when this process owns the marker', async () => {
      await leave({ parentPid: process.pid });
      expect(await sweepOrphanedWorkspaceBuild(storage)).toBe(false);
    });

    it('does nothing while the build child group is still running', async () => {
      const survivor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      try {
        await leave({ parentPid: deadPid(), childPid: survivor.pid });
        expect(await sweepOrphanedWorkspaceBuild(storage)).toBe(false);
        expect(await fs.readdir(path.join(storage, 'workspace-inputs'))).toContain(
          'capture-orphan',
        );
      } finally {
        process.kill(-survivor.pid!, 'SIGKILL');
      }
    });

    it('never removes the generation that became current', async () => {
      await leave({ parentPid: deadPid() });
      await fs.writeFile(path.join(storage, 'overlay', 'CURRENT'), 'orphan-gen\n');
      expect(await sweepOrphanedWorkspaceBuild(storage)).toBe(true);
      expect(await fs.readdir(path.join(storage, 'overlay'))).toContain('orphan-gen');
    });

    it('ignores a missing marker and refuses a malformed marker', async () => {
      expect(await sweepOrphanedWorkspaceBuild(storage)).toBe(false);
      await fs.writeFile(path.join(storage, 'workspace-build.owner.json'), '{not json');
      await expect(sweepOrphanedWorkspaceBuild(storage)).rejects.toThrow('Cannot safely recover');
      await expect(run('0')).rejects.toThrow('Cannot safely recover');
      expect(await fs.readFile(path.join(storage, 'workspace-build.owner.json'), 'utf8')).toBe(
        '{not json',
      );
    });

    it.each([
      { parentPid: 0 },
      { parentPid: -1 },
      { childPid: 0 },
      { childPid: -1 },
      { childPid: 1.5 },
      { before: {} },
      { before: { overlay: [] } },
      { before: { overlay: 'old-gen', 'workspace-inputs': [] } },
      { before: { overlay: ['../old-gen'], 'workspace-inputs': [] } },
      { state: 'unknown' },
      { state: 'quarantined' },
    ])('retains artifacts and rejects invalid ownership evidence: %j', async (invalid) => {
      await leave({ parentPid: deadPid(), ...invalid });
      const markerPath = path.join(storage, 'workspace-build.owner.json');
      const before = await fs.readFile(markerPath, 'utf8');
      await expect(sweepOrphanedWorkspaceBuild(storage)).rejects.toThrow('Cannot safely recover');
      await expect(run('0')).rejects.toThrow('Cannot safely recover');
      expect(await fs.readFile(markerPath, 'utf8')).toBe(before);
      expect(await fs.readdir(path.join(storage, 'overlay'))).toContain('orphan-gen');
      expect(await fs.readdir(path.join(storage, 'workspace-inputs'))).toContain('capture-orphan');
    });

    it('fails closed when a marker is unreadable', async () => {
      await leave({ parentPid: deadPid() });
      const read = fs.readFile.bind(fs);
      vi.spyOn(fs, 'readFile').mockImplementation(((filename: string, encoding: BufferEncoding) => {
        if (filename === path.join(storage, 'workspace-build.owner.json')) {
          return Promise.reject(Object.assign(new Error('marker denied'), { code: 'EACCES' }));
        }
        return read(filename, encoding);
      }) as typeof fs.readFile);
      await expect(run('0')).rejects.toThrow('Cannot safely recover');
      expect(await fs.readdir(path.join(storage, 'overlay'))).toContain('orphan-gen');
    });

    it('does not clean artifacts if CURRENT cannot be read', async () => {
      await leave({ parentPid: deadPid() });
      const read = fs.readFile.bind(fs);
      vi.spyOn(fs, 'readFile').mockImplementation(((filename: string, encoding: BufferEncoding) => {
        if (filename === path.join(storage, 'overlay', 'CURRENT')) {
          return Promise.reject(Object.assign(new Error('current denied'), { code: 'EACCES' }));
        }
        return read(filename, encoding);
      }) as typeof fs.readFile);
      await expect(run('0')).rejects.toThrow('current denied');
      expect(await fs.readdir(path.join(storage, 'overlay'))).toContain('orphan-gen');
      expect(await fs.stat(path.join(storage, 'workspace-build.owner.json'))).toBeDefined();
    });

    it('recovers a stopped quarantined group while its original server is alive', async () => {
      await leave({ parentPid: process.pid, childPid: deadPid(), state: 'quarantined' });
      await run('0');
      expect(await fs.readdir(path.join(storage, 'overlay'))).not.toContain('orphan-gen');
      expect(await fs.readdir(path.join(storage, 'workspace-inputs'))).toEqual(['capture-prior']);
      await expect(fs.stat(path.join(storage, 'workspace-build.owner.json'))).rejects.toThrow();
    });

    it('a new supervised build sweeps a dead owner first and leaves no marker behind', async () => {
      await leave({ parentPid: deadPid() });
      await run('0');
      expect((await fs.readdir(path.join(storage, 'overlay'))).sort()).toEqual([
        'CURRENT',
        'old-gen',
        'prior-gen',
      ]);
      await expect(fs.stat(path.join(storage, 'workspace-build.owner.json'))).rejects.toThrow();
    });

    it.each(['absent', 'reaped', 'unresolved'])(
      'admits a successor only after its previous owner is resolved: %s',
      async (state) => {
        const markerPath = path.join(storage, 'workspace-build.owner.json');
        const spawnedPath = path.join(storage, 'successor.json');
        const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: 'ignore',
        });
        const exited = once(owner, 'exit');
        try {
          if (state !== 'unresolved') {
            owner.kill('SIGKILL');
            await exited;
          }
          if (state !== 'absent') {
            await leave({ parentPid: deadPid(), childPid: owner.pid });
          }
          const before = await fs.readFile(markerPath, 'utf8').catch(() => null);
          const swept = await sweepOrphanedWorkspaceBuild(storage);
          const result = await run(
            withStorage(`
            fs.writeFileSync(${JSON.stringify(spawnedPath)}, JSON.stringify({
              marker: JSON.parse(fs.readFileSync(path.join(storage, 'workspace-build.owner.json'), 'utf8')),
              liveArtifact: fs.existsSync(path.join(storage, 'workspace-inputs', 'capture-orphan')),
            }));
          `),
          ).then(
            () => 'completed',
            (error: WorkspaceBuildError) => error.kind,
          );
          const spawned = await fs
            .readFile(spawnedPath, 'utf8')
            .then(JSON.parse)
            .catch(() => null);
          const after = await fs.readFile(markerPath, 'utf8').catch(() => null);
          console.info(
            'IQ-4F supervisor admission',
            JSON.stringify({
              state,
              swept,
              result,
              spawned: spawned !== null,
              markerOverwritten: spawned !== null && JSON.stringify(spawned.marker) !== before,
              markerRetained: after === before && after !== null,
              liveArtifactRetained: await fs
                .stat(path.join(storage, 'workspace-inputs', 'capture-orphan'))
                .then(
                  () => true,
                  () => false,
                ),
            }),
          );
          if (state === 'unresolved') {
            expect.soft(swept).toBe(false);
            expect.soft(spawned, 'a surviving group must block the next writer').toBeNull();
            expect.soft(after, 'the unresolved owner marker must remain recoverable').toBe(before);
          } else {
            expect(swept).toBe(state === 'reaped');
            expect(spawned).not.toBeNull();
            expect(after).toBeNull();
          }
        } finally {
          if (owner.exitCode === null && owner.signalCode === null) {
            owner.kill('SIGKILL');
            await exited;
          }
        }
      },
    );
  });
});
