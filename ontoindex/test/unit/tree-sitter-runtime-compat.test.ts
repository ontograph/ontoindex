import { describe, expect, it } from 'vitest';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

describe('tree-sitter runtime compatibility', () => {
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
