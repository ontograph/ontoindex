import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../src/mcp/facade/tool-definitions.js';

const skillsDir = fileURLToPath(new URL('../../skills/', import.meta.url));
const registeredNames = new Set(
  [...ONTOINDEX_SUPER_TOOLS, ...ONTOINDEX_FACADE_TOOLS].map((tool) => tool.name),
);
const legacyNames =
  /\b(?:ontoindex_query|ontoindex_context|ontoindex_impact|ontoindex_detect_changes|ontoindex_rename|ontoindex_cypher|list_repos|detect_changes)\b/;

describe('bundled skill contracts', () => {
  for (const filename of fs
    .readdirSync(skillsDir)
    .filter((name) => name.endsWith('.md'))
    .sort()) {
    const content = fs.readFileSync(path.join(skillsDir, filename), 'utf8');

    it(`${filename} uses registered tools`, () => {
      expect(content).not.toMatch(legacyNames);
      const code = [...content.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g)]
        .map((match) => match[1] ?? match[2])
        .join('\n');
      const names = [
        ...[...code.matchAll(/\b(ontoindex_[a-z_]+|gn_[a-z_]+)\b/g)].map((match) => match[1]),
        ...[
          ...code.matchAll(/\b(search|inspect|impact|audit|discover|docs|manage|refactor)\(\{/g),
        ].map((match) => match[1]),
      ];
      for (const name of names) expect(registeredNames.has(name), name).toBe(true);
      expect(content).not.toContain('npx ontoindex analyze');
    });

    it(`${filename} has compact matching metadata`, () => {
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      expect(frontmatter).toBeDefined();
      expect(frontmatter).toMatch(new RegExp(`^name: ${filename.slice(0, -3)}$`, 'm'));
      expect(frontmatter).toMatch(/^description: (?![>|])\S[^\r\n]*$/m);
      expect(content.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(60);
    });
  }
});
