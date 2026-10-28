import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';

const DIST_ROOT = path.join(process.cwd(), 'dist', 'mcp', 'super');
const DIST_DISPATCH_PATH = path.join(DIST_ROOT, 'dispatch.js');

function parseDispatchModuleMap(dispatchSource: string): Map<string, string> {
  const source = ts.createSourceFile(
    'dispatch.js',
    dispatchSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const mapping = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node)) {
      let pendingLabels: string[] = [];
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) {
          pendingLabels.push(clause.expression.text);
        }
        if (clause.statements.length === 0) continue;

        let moduleSpecifier: string | undefined;
        const findImport = (child: ts.Node): void => {
          if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const argument = child.arguments[0];
            if (argument && ts.isStringLiteral(argument) && argument.text.endsWith('.js')) {
              moduleSpecifier ??= argument.text;
            }
          }
          ts.forEachChild(child, findImport);
        };
        clause.statements.forEach(findImport);
        if (moduleSpecifier) {
          for (const label of pendingLabels) mapping.set(label, moduleSpecifier);
        }
        pendingLabels = [];
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
  it('maps grouped labels to their shared dynamic import', () => {
    expect(
      parseDispatchModuleMap(`
      switch (name) {
        case 'gn_verify_diff':
        case 'gn_test_gap': {
          const handlers = await import('./write-through-verification.js');
          return handlers[name](params);
        }
      }
    `),
    ).toEqual(
      new Map([
        ['gn_verify_diff', './write-through-verification.js'],
        ['gn_test_gap', './write-through-verification.js'],
      ]),
    );
  });

  it('does not borrow imports across a nonempty clause without an import', () => {
    expect(
      parseDispatchModuleMap(`
      switch (name) {
        case 'gn_missing_alias':
        case 'gn_missing': { return undefined; }
        case 'gn_present': {
          return import('./present.js');
        }
      }
    `),
    ).toEqual(new Map([['gn_present', './present.js']]));
  });

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
