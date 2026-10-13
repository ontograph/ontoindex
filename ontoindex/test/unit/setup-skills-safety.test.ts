import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSkillsTo, removeInvalidLegacyGitNexusSkills } from '../../src/cli/setup.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-skills-safety-'));
  tempDirs.push(dir);
  return dir;
}

async function makeSource(root: string, name: string, content: string): Promise<void> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), content);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('setup skill installation safety', () => {
  it('marks fresh installs and refreshes managed skills', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await makeSource(source, 'sample', '---\nname: sample\n---\nfirst\n');

    await expect(installSkillsTo(target, undefined, source)).resolves.toEqual(['sample']);
    const installed = path.join(target, 'sample');
    await expect(fs.readFile(path.join(installed, '.ontoindex-managed'), 'utf-8')).resolves.toBe(
      '',
    );

    await fs.writeFile(path.join(installed, 'SKILL.md'), 'user edit\n');
    await fs.writeFile(path.join(source, 'sample', 'SKILL.md'), '---\nname: sample\n---\nsecond\n');
    await expect(installSkillsTo(target, undefined, source)).resolves.toEqual(['sample']);
    await expect(fs.readFile(path.join(installed, 'SKILL.md'), 'utf-8')).resolves.toContain(
      'second',
    );
  });

  it('cleans up a partial fresh install and allows a later retry', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await makeSource(source, 'sample', '---\nname: sample\n---\nsource\n');
    await fs.mkdir(path.join(source, 'sample', 'nested'));
    await fs.writeFile(path.join(source, 'sample', 'nested', 'extra.txt'), 'extra');
    const skipped: string[] = [];
    const broken = path.join(source, 'sample', 'nested', 'extra.txt');
    await fs.rm(broken);
    await fs.symlink(path.join(root, 'missing-source-file'), broken);

    await expect(installSkillsTo(target, skipped, source)).resolves.toEqual([]);
    await expect(fs.access(path.join(target, 'sample'))).rejects.toThrow();
    expect(skipped).toEqual([]);
    expect((await fs.readdir(target)).filter((name) => name.includes('ontoindex-staging'))).toEqual(
      [],
    );

    await fs.rm(broken);
    await fs.writeFile(broken, 'extra');
    await expect(installSkillsTo(target, undefined, source)).resolves.toEqual(['sample']);
  });

  it('preserves existing managed content when refreshing fails', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await makeSource(source, 'sample', '---\nname: sample\n---\nfirst\n');
    await expect(installSkillsTo(target, undefined, source)).resolves.toEqual(['sample']);
    await fs.writeFile(path.join(source, 'sample', 'SKILL.md'), '---\nname: sample\n---\nsecond\n');
    await fs.mkdir(path.join(source, 'sample', 'nested'));
    await fs.symlink(
      path.join(root, 'missing-source-file'),
      path.join(source, 'sample', 'nested', 'broken'),
    );

    await expect(installSkillsTo(target, undefined, source)).resolves.toEqual([]);
    await expect(fs.readFile(path.join(target, 'sample', 'SKILL.md'), 'utf-8')).resolves.toContain(
      'first',
    );
    expect((await fs.readdir(target)).filter((name) => name.includes('ontoindex-staging'))).toEqual(
      [],
    );
  });

  it('removes only stale real staging and backup directories for managed skills', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await makeSource(source, 'sample', '---\nname: sample\n---\nsource\n');
    await fs.mkdir(target, { recursive: true });
    const stale = path.join(target, '.sample.ontoindex-staging-old');
    const fresh = path.join(target, '.sample.ontoindex-staging-fresh');
    const oldBackup = path.join(target, 'sample.ontoindex-old-old');
    const unrelated = path.join(target, '.other.ontoindex-staging-old');
    for (const dir of [stale, fresh, oldBackup, unrelated]) await fs.mkdir(dir);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    for (const dir of [stale, oldBackup, unrelated]) await fs.utimes(dir, old, old);

    await expect(installSkillsTo(target, undefined, source)).resolves.toEqual(['sample']);
    await expect(fs.access(stale)).rejects.toThrow();
    await expect(fs.access(oldBackup)).rejects.toThrow();
    await expect(fs.access(fresh)).resolves.toBeUndefined();
    await expect(fs.access(unrelated)).resolves.toBeUndefined();
  });

  it('keeps old-looking artifacts owned by a live process and removes dead or very old owners', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await makeSource(source, 'sample', '---\nname: sample\n---\nsource\n');
    await fs.mkdir(target, { recursive: true });
    const live = path.join(target, `.sample.ontoindex-staging-${process.pid}-live`);
    const dead = path.join(target, '.sample.ontoindex-staging-2147483646-dead');
    const reused = path.join(target, `.sample.ontoindex-staging-${process.pid}-reused`);
    for (const dir of [live, dead, reused]) await fs.mkdir(dir);
    await fs.writeFile(path.join(live, 'active'), 'active');
    const old = new Date(Date.now() - 20 * 60 * 1000);
    const veryOld = new Date(Date.now() - 90 * 60 * 1000);
    await fs.utimes(live, old, old);
    await fs.utimes(dead, old, old);
    await fs.utimes(reused, veryOld, veryOld);

    await expect(installSkillsTo(target, undefined, source)).resolves.toEqual(['sample']);
    await expect(fs.access(path.join(live, 'active'))).resolves.toBeUndefined();
    await expect(fs.access(dead)).rejects.toThrow();
    await expect(fs.access(reused)).rejects.toThrow();
  });

  it('keeps the existing managed skill available when a refresh swap fails', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await makeSource(source, 'sample', '---\nname: sample\n---\nfirst\n');
    await installSkillsTo(target, undefined, source);
    await fs.writeFile(path.join(source, 'sample', 'SKILL.md'), '---\nname: sample\n---\nsecond\n');
    const originalRename = fs.rename.bind(fs);
    let renames = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      renames += 1;
      if (renames === 2) throw Object.assign(new Error('swap failed'), { code: 'EIO' });
      return originalRename(...args);
    });
    try {
      await installSkillsTo(target, undefined, source);
    } finally {
      vi.restoreAllMocks();
    }
    await expect(fs.readFile(path.join(target, 'sample', 'SKILL.md'), 'utf-8')).resolves.toContain(
      'first',
    );
  });

  it('retries a staging mkdir collision', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await makeSource(source, 'sample', '---\nname: sample\n---\nsource\n');
    await fs.mkdir(target, { recursive: true });
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValueOnce(0.5).mockReturnValueOnce(0.6).mockReturnValue(0.7);
    await fs.mkdir(
      path.join(target, `.sample.ontoindex-staging-${process.pid}-${(0.5).toString(36).slice(2)}`),
    );
    await expect(installSkillsTo(target, undefined, source)).resolves.toEqual(['sample']);
    expect(
      (await fs.readdir(target)).some((name) => name.endsWith((0.5).toString(36).slice(2))),
    ).toBe(true);
    vi.restoreAllMocks();
  });

  it('skips a differing unmarked user skill and reports its name', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await makeSource(source, 'sample', '---\nname: sample\n---\nsource\n');
    const userSkill = path.join(target, 'sample');
    await fs.mkdir(userSkill, { recursive: true });
    await fs.writeFile(path.join(userSkill, 'SKILL.md'), 'user-owned\n');
    const skipped: string[] = [];

    await expect(installSkillsTo(target, skipped, source)).resolves.toEqual([]);
    expect(skipped).toEqual(['sample']);
    await expect(fs.readFile(path.join(userSkill, 'SKILL.md'), 'utf-8')).resolves.toBe(
      'user-owned\n',
    );
  });

  it('adopts an identical unmarked skill and installs into a directory without SKILL.md', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    const content = '---\nname: sample\n---\nsource\n';
    await makeSource(source, 'sample', content);
    await fs.mkdir(path.join(target, 'sample'), { recursive: true });
    await fs.writeFile(path.join(target, 'sample', 'SKILL.md'), content);
    await expect(installSkillsTo(target, undefined, source)).resolves.toEqual(['sample']);
    await expect(
      fs.access(path.join(target, 'sample', '.ontoindex-managed')),
    ).resolves.toBeUndefined();

    await fs.rm(path.join(target, 'sample'), { recursive: true });
    await fs.mkdir(path.join(target, 'sample'), { recursive: true });
    await expect(installSkillsTo(target, undefined, source)).resolves.toEqual(['sample']);
    await expect(fs.readFile(path.join(target, 'sample', 'SKILL.md'), 'utf-8')).resolves.toBe(
      content,
    );
  });

  it('skips symlink skill targets without following them', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    const outside = path.join(root, 'outside');
    await makeSource(source, 'sample', '---\nname: sample\n---\nsource\n');
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'SKILL.md'), 'untouched\n');
    await fs.symlink(outside, path.join(target, 'sample'), 'dir');
    const skipped: string[] = [];

    await expect(installSkillsTo(target, skipped, source)).resolves.toEqual([]);
    expect(skipped).toEqual(['sample']);
    await expect(fs.readFile(path.join(outside, 'SKILL.md'), 'utf-8')).resolves.toBe('untouched\n');
  });

  it('removes only invalid legacy directories containing exactly SKILL.md', async () => {
    const root = await makeTempDir();
    const extra = path.join(root, 'gitnexus-extra');
    const invalid = path.join(root, 'gitnexus-invalid');
    const valid = path.join(root, 'gitnexus-valid');
    await fs.mkdir(extra);
    await fs.writeFile(path.join(extra, 'SKILL.md'), 'no frontmatter\n');
    await fs.writeFile(path.join(extra, 'notes.txt'), 'keep\n');
    await fs.mkdir(invalid);
    await fs.writeFile(path.join(invalid, 'SKILL.md'), 'no frontmatter\n');
    await fs.mkdir(valid);
    await fs.writeFile(path.join(valid, 'SKILL.md'), '---\nname: valid\n---\n');

    await expect(removeInvalidLegacyGitNexusSkills(root)).resolves.toEqual(['gitnexus-invalid']);
    await expect(fs.access(extra)).resolves.toBeUndefined();
    await expect(fs.access(invalid)).rejects.toThrow();
    await expect(fs.access(valid)).resolves.toBeUndefined();
  });
});
