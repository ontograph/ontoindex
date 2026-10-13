import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  cleanGenerations,
  planGenerationCleanup,
  executeGenerationCleanup,
} from '../../src/storage/repo-manager.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(count = 6) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-clean-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'generations'));
  for (let i = 1; i <= count; i++) {
    const dir = path.join(root, 'generations', `${i}-1-a`);
    await fs.mkdir(dir);
    for (const name of ['meta.json', 'snapshot.json', 'lbug'])
      await fs.writeFile(path.join(dir, name), 'data');
  }
  await fs.symlink(`generations/${count}-1-a`, path.join(root, 'current'));
  return root;
}
describe('explicit generation cleanup', () => {
  it('retains the last published marker despite older directory names', async () => {
    const root = await fixture(3);
    for (const [old, name, marker] of [
      ['1-1-a', '1500-published-last', '9000'],
      ['2-1-a', '2000-new', '5000'],
      ['3-1-a', '1000-active', '6000'],
    ]) {
      await fs.rename(path.join(root, 'generations', old), path.join(root, 'generations', name));
      await fs.writeFile(path.join(root, 'generations', name, '.retention-managed'), marker);
    }
    await fs.unlink(path.join(root, 'current'));
    await fs.symlink('generations/1000-active', path.join(root, 'current'));
    const result = await planGenerationCleanup(root, { keepNewest: 1 });
    expect(result.kept).toContainEqual({ name: '1500-published-last', reason: 'rollback' });
    expect(result.candidates.map((g) => g.name)).toEqual(['2000-new']);
  });
  it.each(['invalid', '-9000', '9000.5', '9007199254740992', 'symlink'])(
    'falls back to directory epochs for %s markers',
    async (marker) => {
      const root = await fixture(3);
      const target = path.join(root, 'generations/1-1-a/.retention-managed');
      if (marker === 'symlink') {
        await fs.writeFile(path.join(root, 'marker'), '9000');
        await fs.symlink(path.join(root, 'marker'), target);
      } else await fs.writeFile(target, marker);
      expect((await planGenerationCleanup(root, { keepNewest: 1 })).kept).toContainEqual({
        name: '2-1-a',
        reason: 'rollback',
      });
    },
  );
  it('reports removal failures and continues deleting other candidates', async () => {
    const root = await fixture(4);
    const original = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (path.basename(String(target)) === '2-1-a')
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(target, options);
    });
    const result = await cleanGenerations(root, { dryRun: false, keepNewest: 0 });
    expect(result.deleted.map((g) => g.name)).toEqual(['3-1-a', '1-1-a']);
    expect(result.skipped).toContainEqual({ name: '2-1-a', reason: 'delete-failed: EACCES' });
    expect(result.hadFailures).toBe(true);
  });
  it('allows dead pins and refuses an active pointer outside generations', async () => {
    const root = await fixture();
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid!;
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await fs.writeFile(path.join(root, 'generations/1-1-a', `.reader-${pid}-a`), '');
    expect((await cleanGenerations(root, { dryRun: false })).deleted.map((g) => g.name)).toContain(
      '1-1-a',
    );
    await fs.unlink(path.join(root, 'current'));
    await fs.symlink(root, path.join(root, 'current'));
    expect((await cleanGenerations(root, { dryRun: false, keepNewest: 0 })).deleted).toEqual([]);
  });
  it('defaults to dry run and retains active plus two rollback generations', async () => {
    const root = await fixture();
    const result = await cleanGenerations(root, {});
    expect(result.deleted).toEqual([]);
    expect(result.bytesReclaimable).toBe(36);
    expect(await fs.readdir(path.join(root, 'generations'))).toHaveLength(6);
    const executed = await cleanGenerations(root, { dryRun: false });
    expect(executed.deleted.map((g) => g.name).sort()).toEqual(['1-1-a', '2-1-a', '3-1-a']);
  });
  it('protects pins, incomplete directories and ignores symlinks and files', async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, 'generations/1-1-a', `.reader-${process.pid}-a`), '');
    await fs.unlink(path.join(root, 'generations/2-1-a/meta.json'));
    await fs.symlink('3-1-a', path.join(root, 'generations/linked'));
    await fs.writeFile(path.join(root, 'generations/file'), '');
    const result = await cleanGenerations(root, { dryRun: false });
    expect(result.kept).toContainEqual({ name: '1-1-a', reason: 'live-pin' });
    expect(result.kept).toContainEqual({ name: '2-1-a', reason: 'unverified' });
    expect(result.deleted.map((g) => g.name)).toEqual(['3-1-a']);
  });
  it('fails closed without an active generation or with an analysis lock', async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, 'analyze.lock'), '');
    expect((await cleanGenerations(root, { dryRun: false })).deleted).toEqual([]);
    await fs.unlink(path.join(root, 'analyze.lock'));
    await fs.unlink(path.join(root, 'current'));
    expect((await cleanGenerations(root, { dryRun: false })).deleted).toEqual([]);
  });
  it('revalidates new pins between planning and execution', async () => {
    const root = await fixture();
    const plan = await planGenerationCleanup(root, {});
    await fs.writeFile(path.join(root, 'generations/1-1-a', `.reader-${process.pid}-a`), '');
    const result = await executeGenerationCleanup(root, plan);
    expect(result.skipped).toContainEqual({ name: '1-1-a', reason: 'live-pin' });
  });
  it('caps deletion at fifty and supports zero rollback generations', async () => {
    const root = await fixture(55);
    const result = await cleanGenerations(root, { dryRun: false, keepNewest: 0 });
    expect(result.deleted).toHaveLength(50);
    expect(result.deleted.some((g) => g.name === '55-1-a')).toBe(false);
    expect(result.skipped).toHaveLength(4);
  });
});
