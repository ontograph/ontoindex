import type { CaptureMatch } from 'ontoindex-shared';
import { ScopeUnsupportedSyntaxError } from '../scope-unsupported-syntax.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

const SCOPE_CAPTURE_NAMES = new Map([
  ['program', '@scope.module'],
  ['function_declaration', '@scope.function'],
  ['function_expression', '@scope.function'],
  ['generator_function_declaration', '@scope.function'],
  ['generator_function', '@scope.function'],
  ['arrow_function', '@scope.function'],
  ['method_definition', '@scope.function'],
  ['class_declaration', '@scope.class'],
  ['class', '@scope.class'],
  ['abstract_class_declaration', '@scope.class'],
  ['interface_declaration', '@scope.class'],
  ['internal_module', '@scope.namespace'],
  ['statement_block', '@scope.block'],
  ['for_statement', '@scope.block'],
  ['for_in_statement', '@scope.block'],
  ['catch_clause', '@scope.block'],
  ['switch_body', '@scope.block'],
]);

/**
 * Emit detached lexical ranges from a borrowed TS/TSX/JS/JSX program tree.
 * Traversal is synchronous and retains neither AST nodes nor source text.
 * Function bodies remain separate blocks; wrappers and signatures add no scope.
 * These captures alone are incomplete for full scope-resolution extraction:
 * declarations, bindings, imports, exports, and references are still required.
 */
export function emitTypeScriptLexicalScopeCaptures(rootNode: SyntaxNode): CaptureMatch[] {
  if (rootNode.type !== 'program' || rootNode.hasError || rootNode.isMissing) {
    throw new ScopeUnsupportedSyntaxError(
      'TS/JS lexical scope captures require an error-free program root',
    );
  }

  const matches: CaptureMatch[] = [];
  const cursor = rootNode.walk();
  while (true) {
    if (cursor.nodeIsMissing || cursor.nodeType === 'ERROR') {
      throw new ScopeUnsupportedSyntaxError(
        'TS/JS lexical scope captures refuse error or missing syntax',
      );
    }

    const name = SCOPE_CAPTURE_NAMES.get(cursor.nodeType);
    if (name && cursor.nodeIsNamed) {
      const start = cursor.startPosition;
      const end = cursor.endPosition;
      matches.push({
        [name]: {
          name,
          range: {
            startLine: start.row + 1,
            startCol: start.column,
            endLine: end.row + 1,
            endCol: end.column,
          },
          text: '',
        },
      });
    }

    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) return matches;
    }
  }
}
