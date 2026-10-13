import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
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
