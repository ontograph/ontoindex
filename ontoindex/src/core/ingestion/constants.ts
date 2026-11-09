/**
 * Default minimum buffer size for tree-sitter parsing (512 KB).
 * tree-sitter requires bufferSize >= file size in bytes.
 */
export const TREE_SITTER_BUFFER_SIZE = 512 * 1024;

/**
 * AST limits are opt-in. Set ONTOINDEX_PARSE_MAX_AST_NODES or
 * ONTOINDEX_PARSE_MAX_AST_DEPTH to a positive value to enable a guard;
 * unset, blank, or zero values leave parsing unlimited.
 */
export const DEFAULT_PARSE_MAX_AST_NODES: number | null = null;
export const DEFAULT_PARSE_MAX_AST_DEPTH: number | null = null;

export const getParseMaxAstNodes = (): number | null => {
  const raw = process.env.ONTOINDEX_PARSE_MAX_AST_NODES;
  if (raw == null || raw.trim() === '') return DEFAULT_PARSE_MAX_AST_NODES;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_PARSE_MAX_AST_NODES;
  return value === 0 ? null : Math.max(1, Math.floor(value));
};

export const getParseMaxAstDepth = (): number | null => {
  const raw = process.env.ONTOINDEX_PARSE_MAX_AST_DEPTH;
  if (raw == null || raw.trim() === '') return DEFAULT_PARSE_MAX_AST_DEPTH;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_PARSE_MAX_AST_DEPTH;
  return value === 0 ? null : Math.max(1, Math.floor(value));
};

interface AstDepthNode {
  childCount: number;
  child(index: number): AstDepthNode | null;
}

export const exceedsParseMaxAstDepth = (root: AstDepthNode, maxDepth: number): boolean => {
  const stack: { node: AstDepthNode; depth: number }[] = [{ node: root, depth: 1 }];

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > maxDepth) return true;

    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push({ node: child, depth: depth + 1 });
    }
  }

  return false;
};

/**
 * Compute adaptive buffer size for tree-sitter parsing.
 * Uses 2× content length with a minimum of 512 KB.
 * Previous 256 KB fixed limit silently skipped files > ~200 KB (e.g., imgui.h at 411 KB).
 */
export const getTreeSitterBufferSize = (contentLength: number): number =>
  Math.max(contentLength * 2, TREE_SITTER_BUFFER_SIZE);
