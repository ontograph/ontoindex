/**
 * Default minimum buffer size for tree-sitter parsing (512 KB).
 * tree-sitter requires bufferSize >= file size in bytes.
 */
export const TREE_SITTER_BUFFER_SIZE = 512 * 1024;

/**
 * Maximum buffer size cap (32 MB) to prevent OOM on huge files.
 * Also used as the file-size skip threshold — files larger than this are not parsed.
 */
export const TREE_SITTER_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Maximum AST node count per parsed file. This catches compact generated or
 * deeply nested files that fit under the byte cap but would still make later
 * extractor passes walk an unbounded tree. Set ONTOINDEX_PARSE_MAX_AST_NODES=0
 * to disable the guard for diagnostics.
 */
export const DEFAULT_PARSE_MAX_AST_NODES = 750_000;
export const DEFAULT_PARSE_MAX_AST_DEPTH = 4_000;

export const getParseMaxAstNodes = (): number | null => {
  const raw = process.env.ONTOINDEX_PARSE_MAX_AST_NODES;
  if (raw == null || raw.trim() === '') return DEFAULT_PARSE_MAX_AST_NODES;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_PARSE_MAX_AST_NODES;
  return value === 0 ? null : Math.floor(value);
};

export const getParseMaxAstDepth = (): number | null => {
  const raw = process.env.ONTOINDEX_PARSE_MAX_AST_DEPTH;
  if (raw == null || raw.trim() === '') return DEFAULT_PARSE_MAX_AST_DEPTH;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_PARSE_MAX_AST_DEPTH;
  return value === 0 ? null : Math.floor(value);
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
 * Uses 2× file size, clamped between 512 KB and 32 MB.
 * Previous 256 KB fixed limit silently skipped files > ~200 KB (e.g., imgui.h at 411 KB).
 */
export const getTreeSitterBufferSize = (contentLength: number): number =>
  Math.min(Math.max(contentLength * 2, TREE_SITTER_BUFFER_SIZE), TREE_SITTER_MAX_BUFFER);
