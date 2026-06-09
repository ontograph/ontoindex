import { describe, expect, it } from 'vitest';
import { extractRustNamedBindings } from '../../../src/core/ingestion/named-bindings/rust.js';

interface FakeSyntaxNode {
  type: string;
  text: string;
  parent?: FakeSyntaxNode;
  children: FakeSyntaxNode[];
  namedChildCount: number;
  namedChild(index: number): FakeSyntaxNode | null;
  childForFieldName?(name: string): FakeSyntaxNode | null;
}

function makeNode(type: string, text = type, children: FakeSyntaxNode[] = []): FakeSyntaxNode {
  const node: FakeSyntaxNode = {
    type,
    text,
    children,
    namedChildCount: children.length,
    namedChild(index: number) {
      return this.children[index] ?? null;
    },
  };
  for (const child of children) child.parent = node;
  return node;
}

describe('extractRustNamedBindings', () => {
  it('walks deeply nested use declarations without recursive stack growth', () => {
    const leaf = makeNode('identifier', 'User');
    let current = makeNode('use_list', 'use_list', [leaf]);
    for (let i = 0; i < 10_000; i++) {
      current = makeNode('scoped_use_list', `scope${i}`, [current]);
    }
    const importNode = makeNode('use_declaration', 'use deeply::nested::User;', [current]);

    expect(extractRustNamedBindings(importNode as any)).toEqual([
      { local: 'User', exported: 'User' },
    ]);
  });
});
