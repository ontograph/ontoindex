import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

describe('tree-sitter runtime compatibility', () => {
  it.each([
    '../../src/core/group/service-boundary-detector.ts',
    '../../src/mcp/super/write-through-verification.ts',
    '../../src/mcp/local/backend-hotspot-coupling-kernel.ts',
    '../../../ontoindex-web/src/components/HelpPanel.tsx',
  ])('parses production TypeScript source without errors: %s', async (filePath) => {
    const source = await readFile(new URL(filePath, import.meta.url), 'utf8');
    const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
    const tree = parser.parse(source);

    expect(tree.rootNode.hasError).toBe(false);
  });

  it.each(
    ['compat.ts', 'compat.tsx'].flatMap((filePath) =>
      [
        "f<typeof import('x')>()",
        "f<typeof import('x')>(value)",
        "f<typeof import('x').member>(value)",
      ].map((source) => ({ filePath, source })),
    ),
  )(
    'parses import type-query generics as calls: $filePath $source',
    async ({ filePath, source }) => {
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      const tree = parser.parse(source);
      const expression = tree.rootNode.firstNamedChild?.firstNamedChild;

      expect(tree.rootNode.hasError).toBe(false);
      expect(expression?.type).toBe('call_expression');
      expect(expression?.childForFieldName('function')?.text).toBe('f');
      const typeArguments = expression?.childForFieldName('type_arguments');
      expect(typeArguments?.type).toBe('type_arguments');
      expect(typeArguments?.namedChildren.map((node) => node.type)).toEqual(['type_query']);
    },
  );

  it.each(
    ['compat.ts', 'compat.tsx'].flatMap((filePath) =>
      [
        { source: "import('x')", expressionType: 'call_expression' },
        { source: 'a < b > c', expressionType: 'binary_expression' },
      ].map((testCase) => ({ filePath, ...testCase })),
    ),
  )(
    'preserves ordinary expressions: $filePath $source',
    async ({ filePath, source, expressionType }) => {
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, filePath);
      const tree = parser.parse(source);
      const expression = tree.rootNode.firstNamedChild?.firstNamedChild;

      expect(tree.rootNode.hasError).toBe(false);
      expect(expression?.type).toBe(expressionType);
      if (expressionType === 'call_expression') {
        expect(expression?.childForFieldName('function')?.type).toBe('import');
        expect(expression?.childForFieldName('type_arguments')).toBeNull();
        expect(expression?.childForFieldName('arguments')?.text).toBe("('x')");
      }
    },
  );

  type TreeSitterNodeLike = { children: TreeSitterNodeLike[]; fields?: string[]; type: string };

  const findNodeWithFields = (node: TreeSitterNodeLike) => {
    const queue = [node];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index] as TreeSitterNodeLike & { fields?: unknown[] };
      if (Array.isArray(current.fields) && current.fields.length > 0) {
        return current;
      }
      queue.push(...current.children);
    }
    return undefined;
  };

  it('initializes parser node subclasses without setter-only metadata errors', async () => {
    const parser = await createParserForLanguage(SupportedLanguages.TypeScript, 'compat.ts');
    const tree = parser.parse('const value: string = "ok";');

    const declarationNode = findNodeWithFields(tree.rootNode);
    expect(declarationNode).toBeDefined();
    expect(typeof declarationNode!.type).toBe('string');
    expect(Array.isArray(declarationNode!.fields)).toBe(true);
    expect(declarationNode!.fields.length).toBeGreaterThan(0);
    expect(Object.isFrozen(declarationNode!.fields)).toBe(true);

    const proto = Object.getPrototypeOf(declarationNode!);
    expect(proto).toBeDefined();
    expect(Object.getOwnPropertyDescriptor(proto, 'type')).toMatchObject({
      value: declarationNode!.type,
      configurable: true,
    });
    expect(Object.getOwnPropertyDescriptor(proto, 'fields')?.value).toEqual(
      declarationNode!.fields,
    );
  });
});
