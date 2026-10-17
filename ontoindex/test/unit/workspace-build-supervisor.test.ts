import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  afterEach(() => fs.rm(storage, { recursive: true, force: true }));

  const run = (script: string, timeoutMs = 10_000) =>
    superviseWorkspaceBuild({
      command: process.execPath,
      args: ['-e', script],
      cwd: storage,
      storagePath: storage,
      timeoutMs,
      reapMs: 3000,
    });
  const strand = `
    const fs = require('fs'); const path = require('path');
    const storage = ${JSON.stringify('__STORAGE__')};
  `;
  const withStorage = (body: string) => strand.replace('__STORAGE__', storage) + body;

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

    it('ignores a missing or malformed marker', async () => {
      expect(await sweepOrphanedWorkspaceBuild(storage)).toBe(false);
      await fs.writeFile(path.join(storage, 'workspace-build.owner.json'), '{not json');
      expect(await sweepOrphanedWorkspaceBuild(storage)).toBe(false);
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
  });
});
