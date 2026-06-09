import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';

const DIST_ROOT = path.join(process.cwd(), 'dist', 'mcp', 'super');
const DIST_DISPATCH_PATH = path.join(DIST_ROOT, 'dispatch.js');

function parseDispatchModuleMap(dispatchSource: string): Map<string, string> {
  const caseImportPattern =
    /case\s+(?:'([^']+)'|"([^\"]+)")\s*:\s*\{[\s\S]*?import\(\s*(?:'([^']+\.js)'|"([^"]+\.js)")\s*\)/g;

  const mapping = new Map<string, string>();
  for (const match of dispatchSource.matchAll(caseImportPattern)) {
    const tool = match[1] ?? match[2];
    const moduleSpecifier = match[3] ?? match[4];
    if (!tool || !moduleSpecifier) continue;
    mapping.set(tool, moduleSpecifier);
  }
  return mapping;
}

function ensureDistDispatchAvailable(): string {
  if (!existsSync(DIST_DISPATCH_PATH)) {
    throw new Error(
      `Cannot run dist packaging smoke test: ${DIST_DISPATCH_PATH} is missing. Run node scripts/build.js first.`,
    );
  }
  return DIST_DISPATCH_PATH;
}

describe('MCP super dispatch packaging', () => {
  it('advertised super-tools map to existing dist module files', () => {
    const dispatchPath = ensureDistDispatchAvailable();
    const dispatchSource = readFileSync(dispatchPath, 'utf-8');
    const dispatchMap = parseDispatchModuleMap(dispatchSource);
    const advertisedTools = new Set(ONTOINDEX_SUPER_TOOLS.map((tool) => tool.name));

    expect(dispatchMap.size).toBe(advertisedTools.size);
    for (const tool of advertisedTools) {
      const moduleSpecifier = dispatchMap.get(tool);
      expect(moduleSpecifier, `Missing dispatch module import for ${tool}`).toBeDefined();
      const modulePath = path.join(DIST_ROOT, moduleSpecifier!);
      expect(
        existsSync(modulePath),
        `Cannot resolve module ${moduleSpecifier} for advertised tool ${tool}`,
      ).toBe(true);
    }

    for (const [tool] of dispatchMap) {
      expect(advertisedTools.has(tool)).toBe(true);
    }
  });
});
