import { afterEach, describe, expect, it } from 'vitest';
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
