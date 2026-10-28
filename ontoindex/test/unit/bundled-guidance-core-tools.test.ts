import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  DEFAULT_MCP_STARTUP_PROFILE,
  getCallableToolNames,
  getPublicToolRegistry,
} from '../../src/mcp/shared/tool-registry.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const files = readdirSync(path.join(repoRoot, 'ontoindex/skills'))
  .filter((name) => name.endsWith('.md'))
  .map((name) => `ontoindex/skills/${name}`);
files.push('ontoindex/hooks/claude/session-start.sh');

for (const directory of ['ontoindex-claude-plugin/skills', 'ontoindex-cursor-integration/skills']) {
  if (!existsSync(path.join(repoRoot, directory))) continue;
  for (const entry of readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const file = `${directory}/${entry.name}/SKILL.md`;
      if (existsSync(path.join(repoRoot, file))) files.push(file);
    }
  }
}

it('bundled guidance names callable tools advertised by the default startup profile', () => {
  const advertised = new Set(
    getPublicToolRegistry({
      includeFacades: true,
      startupProfile: DEFAULT_MCP_STARTUP_PROFILE,
    }).map((tool) => tool.name),
  );
  const callable = new Set(getCallableToolNames({ includeFacades: true }));
  const violations: string[] = [];
  for (const file of files) {
    const names = new Set(readFileSync(path.join(repoRoot, file), 'utf8').match(/\bgn_[a-z_]+\b/g));
    for (const name of names) {
      if (!callable.has(name)) violations.push(`${file}: ${name} is not callable`);
      if (!advertised.has(name)) violations.push(`${file}: ${name} is not advertised`);
    }
  }
  // Guard against a vacuous pass: the scan must cover the hook, skills and both integration copies.
  expect(files.length).toBeGreaterThanOrEqual(4);
  expect(violations).toEqual([]);
});
