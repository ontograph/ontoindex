import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceSkillsDir = path.join(repoRoot, 'ontoindex/skills');
const pluginSkillDirs = [
  path.join(repoRoot, 'ontoindex-claude-plugin/skills'),
  path.join(repoRoot, 'ontoindex-cursor-integration/skills'),
];

describe('plugin skills stay synchronized with bundled skills', () => {
  for (const pluginSkillsDir of pluginSkillDirs) {
    if (!fs.existsSync(pluginSkillsDir)) continue;

    const pluginNames = fs
      .readdirSync(pluginSkillsDir)
      .filter((name) => fs.statSync(path.join(pluginSkillsDir, name)).isDirectory());

    it(`${path.relative(repoRoot, pluginSkillsDir)} contains ontoindex-navigation`, () => {
      expect(pluginNames).toContain('ontoindex-navigation');
    });

    for (const skillName of pluginNames) {
      it(`${path.relative(repoRoot, pluginSkillsDir)}/${skillName} matches its source`, () => {
        const pluginSkill = fs.readFileSync(path.join(pluginSkillsDir, skillName, 'SKILL.md'));
        const sourceSkill = fs.readFileSync(path.join(sourceSkillsDir, `${skillName}.md`));
        expect(pluginSkill.equals(sourceSkill)).toBe(true);
      });
    }
  }
});
