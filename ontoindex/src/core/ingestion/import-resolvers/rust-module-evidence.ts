import type { SyntaxNode } from '../utils/ast-helpers.js';

const declaredModulesByRoot = new WeakMap<SyntaxNode, string[]>();

const hasPrecedingAttribute = (node: SyntaxNode): boolean => {
  let previous = node.previousNamedSibling;
  while (previous?.type === 'line_comment' || previous?.type === 'block_comment') {
    previous = previous.previousNamedSibling;
  }
  return previous?.type === 'attribute_item';
};

/** Only direct, unconditional external module declarations prove a local Rust path. */
export const collectRustDeclaredModules = (importNode: SyntaxNode): string[] => {
  const root = importNode.parent;
  if (root?.type !== 'source_file' || root.hasError || hasPrecedingAttribute(importNode)) {
    return [];
  }
  const cached = declaredModulesByRoot.get(root);
  if (cached) return cached;
  if (root.namedChildren.some((child) => child.type === 'inner_attribute_item')) {
    declaredModulesByRoot.set(root, []);
    return [];
  }

  const modules = new Map<string, boolean>();
  for (const child of root.namedChildren) {
    if (child.type !== 'mod_item') continue;
    const name = child.childForFieldName('name')?.text;
    if (!name) continue;
    const eligible = !child.childForFieldName('body') && !hasPrecedingAttribute(child);
    modules.set(name, !modules.has(name) && eligible);
  }
  const names = [...modules].filter(([, eligible]) => eligible).map(([name]) => name);
  declaredModulesByRoot.set(root, names);
  return names;
};
