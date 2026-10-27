import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  removeCaptureOwner,
  sweepDeadCaptures,
  writeCaptureOwner,
} from '../../src/core/capture-owner.js';
import { readProcessStartIdentity } from '../../src/storage/repo-manager.js';
import { captureWorkspaceInputs } from '../../src/core/analyze-delta.js';
import { getScanMaxFileSizeBytes } from '../../src/core/ingestion/scan-config.js';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-capture-owner-'));
  roots.push(root);
  return root;
}

async function markedCapture(root: string, name: string, owner: unknown): Promise<string> {
  const capture = path.join(root, name);
  await fs.mkdir(capture);
  await fs.writeFile(`${capture}.owner.json`, JSON.stringify(owner));
  return capture;
}

function deadPid(): number {
  return Number(
    execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    }),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('workspace capture owner lifecycle', () => {
  async function makeRepo(): Promise<string> {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/main.ts'), 'export const value = 1;\n');
    return root;
  }

  it('keeps a private regular owner marker until the capture is disposed', async () => {
    const root = await makeRepo();
    const result = await captureWorkspaceInputs(root, { parserIdentity: 'test-parser-v1' });
    const marker = `${result.captureRoot}.owner.json`;
    try {
      const stat = await fs.lstat(marker);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(JSON.parse(await fs.readFile(marker, 'utf8'))).toEqual({
        version: 1,
        pid: process.pid,
        startTicks: readProcessStartIdentity(process.pid) ?? null,
      });
    } finally {
      await result.dispose();
    }
    await expect(fs.lstat(result.captureRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(path.dirname(result.captureRoot))).toEqual([]);
  });

  it('removes the capture and owner marker when an oversized input is refused', async () => {
    const root = await makeRepo();
    const cap = getScanMaxFileSizeBytes();
    expect(cap).not.toBeNull();
    const file = await fs.open(path.join(root, 'src/large.ts'), 'w');
    try {
      await file.truncate(cap! + 1);
    } finally {
      await file.close();
    }
    await expect(
      captureWorkspaceInputs(root, { parserIdentity: 'test-parser-v1' }),
    ).rejects.toMatchObject({ code: 'limit' });
    expect(await fs.readdir(path.join(root, '.ontoindex/workspace-inputs'))).toEqual([]);
  });

  it('reclaims an exited owner capture before creating a new live capture', async () => {
    const root = await makeRepo();
    const captureParent = path.join(root, '.ontoindex/workspace-inputs');
    await fs.mkdir(captureParent, { recursive: true });
    const child = spawnSync(process.execPath, ['-e', '0']);
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.pid).toBeGreaterThan(0);
    const stale = await markedCapture(captureParent, 'capture-DEAD01', {
      version: 1,
      pid: child.pid,
      startTicks: null,
    });
    await fs.writeFile(path.join(stale, 'orphan.ts'), 'export const orphan = true;\n');
    const result = await captureWorkspaceInputs(root, { parserIdentity: 'test-parser-v1' });
    try {
      await expect(fs.lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(`${stale}.owner.json`)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.lstat(result.captureRoot)).isDirectory()).toBe(true);
      expect((await fs.lstat(`${result.captureRoot}.owner.json`)).isFile()).toBe(true);
      expect((await fs.readdir(captureParent)).sort()).toEqual(
        [
          path.basename(result.captureRoot),
          `${path.basename(result.captureRoot)}.owner.json`,
        ].sort(),
      );
    } finally {
      await result.dispose();
    }
    expect(await fs.readdir(captureParent)).toEqual([]);
  });
});

describe('capture owner', () => {
  it('writes a private owner marker and removes it', async () => {
    const root = await makeRoot();
    const capture = path.join(root, 'capture-one');
    await fs.mkdir(capture);
    await writeCaptureOwner(capture);
    const marker = `${capture}.owner.json`;
    expect(JSON.parse(await fs.readFile(marker, 'utf8'))).toEqual({
      version: 1,
      pid: process.pid,
      startTicks: readProcessStartIdentity(process.pid) ?? null,
    });
    expect((await fs.stat(marker)).mode & 0o777).toBe(0o600);
    await removeCaptureOwner(capture);
    await removeCaptureOwner(capture);
    expect(await fs.readdir(root)).toEqual(['capture-one']);
    expect(await fs.readdir(capture)).toEqual([]);
  });

  it('reclaims a capture whose owner has exited', async () => {
    const root = await makeRoot();
    await markedCapture(root, 'capture-dead', { version: 1, pid: deadPid(), startTicks: null });
    await sweepDeadCaptures(root);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each([null, '0'])(
    'preserves the current process even with startTicks %s',
    async (startTicks) => {
      const root = await makeRoot();
      await markedCapture(root, 'capture-current', { version: 1, pid: process.pid, startTicks });
      await sweepDeadCaptures(root);
      expect((await fs.readdir(root)).sort()).toEqual([
        'capture-current',
        'capture-current.owner.json',
      ]);
    },
  );

  it('preserves unmarked, malformed, symlink, and unrelated directories', async () => {
    const root = await makeRoot();
    const owner = { version: 1, pid: deadPid(), startTicks: null };
    await fs.mkdir(path.join(root, 'capture-unmarked'));
    await fs.mkdir(path.join(root, 'capture-malformed'));
    await fs.writeFile(path.join(root, 'capture-malformed.owner.json'), '{');
    await markedCapture(root, 'unrelated', owner);
    await fs.symlink(path.join(root, 'unrelated'), path.join(root, 'capture-link'));
    await markedCapture(root, 'capture-invalid', { ...owner, startTicks: 1 });
    await fs.mkdir(path.join(root, 'capture-marker-link'));
    await fs.symlink(
      path.join(root, 'unrelated.owner.json'),
      path.join(root, 'capture-marker-link.owner.json'),
    );
    const before = (await fs.readdir(root)).sort();
    await sweepDeadCaptures(root);
    expect((await fs.readdir(root)).sort()).toEqual(before);
    expect((await fs.lstat(path.join(root, 'capture-link'))).isSymbolicLink()).toBe(true);
  });

  it('preserves captures owned by another uid', async () => {
    const root = await makeRoot();
    await markedCapture(root, 'capture-other', { version: 1, pid: deadPid(), startTicks: null });
    await sweepDeadCaptures(root, { uid: (process.getuid?.() ?? 0) + 1 });
    expect((await fs.readdir(root)).sort()).toEqual(['capture-other', 'capture-other.owner.json']);
  });

  it('preserves owners when liveness is indeterminate and tolerates inaccessible roots', async () => {
    const root = await makeRoot();
    await markedCapture(root, 'capture-unknown', { version: 1, pid: deadPid(), startTicks: null });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    });
    await sweepDeadCaptures(root);
    expect((await fs.readdir(root)).sort()).toEqual([
      'capture-unknown',
      'capture-unknown.owner.json',
    ]);
    await expect(sweepDeadCaptures(path.join(root, 'missing'))).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== 'linux')(
    'detects a different instance of another live pid while preserving matching owners',
    async () => {
      const root = await makeRoot();
      const pid = process.ppid;
      const startTicks = readProcessStartIdentity(pid);
      expect(startTicks).toMatch(/^\d+$/);
      await markedCapture(root, 'capture-reused', { version: 1, pid, startTicks: '0' });
      await markedCapture(root, 'capture-live', { version: 1, pid, startTicks });
      await markedCapture(root, 'capture-no-identity', { version: 1, pid, startTicks: null });
      await sweepDeadCaptures(root);
      expect((await fs.readdir(root)).sort()).toEqual([
        'capture-live',
        'capture-live.owner.json',
        'capture-no-identity',
        'capture-no-identity.owner.json',
      ]);
    },
  );
});
