import type { Capture, CaptureMatch, Range } from 'ontoindex-shared';
import type { LanguageProvider } from '../language-provider.js';
import { ScopeUnsupportedSyntaxError } from '../scope-unsupported-syntax.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_NAMES = new Set([
  '_',
  'as',
  'async',
  'await',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'abstract',
  'become',
  'box',
  'do',
  'final',
  'gen',
  'macro',
  'override',
  'priv',
  'try',
  'typeof',
  'unsized',
  'virtual',
  'yield',
  'default',
  'union',
]);

function unsupported(): never {
  throw new ScopeUnsupportedSyntaxError(
    'Rust captures require the supported function-only source file subset',
  );
}

function validName(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED_NAMES.has(name);
}

function capture(name: string, node: SyntaxNode, text = ''): Capture {
  return {
    name,
    text,
    range: {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    },
  };
}

function children(node: SyntaxNode): SyntaxNode[] {
  if (!node.isNamed || node.hasError || node.isMissing) unsupported();
  return node.children.filter((child) => !['line_comment', 'block_comment'].includes(child.type));
}

function token(node: SyntaxNode | undefined, type: string): boolean {
  return (
    !!node &&
    node.type === type &&
    node.text === type &&
    !node.isNamed &&
    !node.hasError &&
    !node.isMissing &&
    node.children.length === 0
  );
}

function identifier(node: SyntaxNode | null | undefined): node is SyntaxNode {
  return (
    !!node &&
    node.type === 'identifier' &&
    node.isNamed &&
    !node.hasError &&
    !node.isMissing &&
    node.children.length === 0 &&
    validName(node.text)
  );
}

function emptyArguments(node: SyntaxNode, type: string): void {
  const parts = children(node);
  if (node.type !== type || parts.length !== 2 || !token(parts[0], '(') || !token(parts[1], ')'))
    unsupported();
}

function appendStatement(
  statement: SyntaxNode,
  knownNames: ReadonlySet<string>,
  matches: CaptureMatch[],
): boolean {
  const expressions = children(statement);
  const expression = expressions[0];
  if (
    statement.type !== 'expression_statement' ||
    expressions.length !== 2 ||
    !expression ||
    !token(expressions[1], ';')
  )
    unsupported();
  const parts = children(expression);
  if (expression.type === 'return_expression') {
    if (parts.length !== 1 || !token(parts[0], 'return')) unsupported();
    return true;
  }
  if (expression.type !== 'call_expression') unsupported();
  const callee = expression.childForFieldName('function');
  const args = expression.childForFieldName('arguments');
  if (
    !identifier(callee) ||
    !knownNames.has(callee.text) ||
    !args ||
    parts.length !== 2 ||
    parts[0]!.id !== callee.id ||
    parts[1]!.id !== args.id
  )
    unsupported();
  emptyArguments(args, 'arguments');
  matches.push({
    '@reference.call.free': capture('@reference.call.free', expression),
    '@reference.name': capture('@reference.name', callee, callee.text),
    '@reference.arity': capture('@reference.arity', args, '0'),
  });
  return false;
}

/** Detach captures only after validating the entire borrowed Rust source tree. */
export function emitRustCaptures(root: SyntaxNode): CaptureMatch[] {
  if (root.type !== 'source_file' || !root.isNamed || root.hasError || root.isMissing)
    unsupported();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (
      node.hasError ||
      node.isMissing ||
      node.type === 'ERROR' ||
      ['doc_comment', 'inner_doc_comment_marker', 'outer_doc_comment_marker'].includes(node.type) ||
      (node.type === 'line_comment' && /^\/\/(?:!|\/(?!\/))/.test(node.text)) ||
      (node.type === 'block_comment' && /^\/\*(?:!|\*(?![*/]))/.test(node.text))
    )
      unsupported();
    pending.push(...node.children);
  }
  const functions: { node: SyntaxNode; name: SyntaxNode; body: SyntaxNode; exported: boolean }[] =
    [];
  const knownNames = new Set<string>();
  for (const node of children(root)) {
    if (node.type !== 'function_item') unsupported();
    const parts = children(node);
    const name = node.childForFieldName('name');
    const parameters = node.childForFieldName('parameters');
    const body = node.childForFieldName('body');
    const exported = parts[0]?.type === 'visibility_modifier';
    const offset = exported ? 1 : 0;
    if (exported) {
      const visibility = children(parts[0]!);
      if (visibility.length !== 1 || !token(visibility[0], 'pub')) unsupported();
    }
    if (
      !identifier(name) ||
      knownNames.has(name.text) ||
      !parameters ||
      !body ||
      body.type !== 'block' ||
      parts.length !== offset + 4 ||
      !token(parts[offset], 'fn') ||
      parts[offset + 1]!.id !== name.id ||
      parts[offset + 2]!.id !== parameters.id ||
      parts[offset + 3]!.id !== body.id
    )
      unsupported();
    emptyArguments(parameters, 'parameters');
    knownNames.add(name.text);
    functions.push({ node, name, body, exported });
  }
  const matches: CaptureMatch[] = [{ '@scope.module': capture('@scope.module', root) }];
  for (const { node, name, body, exported } of functions) {
    const statements = children(body);
    if (
      statements.length < 2 ||
      !token(statements[0], '{') ||
      !token(statements[statements.length - 1], '}')
    )
      unsupported();
    matches.push(
      { '@scope.function': capture('@scope.function', node) },
      {
        '@scope.block': capture('@scope.block', body),
      },
      {
        '@declaration.function': capture('@declaration.function', node),
        '@declaration.name': capture('@declaration.name', name, name.text),
      },
    );
    if (exported)
      matches.push({
        '@export.local': capture('@export.local', name, name.text),
        '@export.name': capture('@export.name', name, name.text),
      });
    let returned = false;
    for (const statement of statements.slice(1, -1)) {
      if (returned) unsupported();
      returned = appendStatement(statement, knownNames, matches);
    }
  }
  return matches;
}

function sameRange(left: Range, right: Range): boolean {
  return (
    left.startLine === right.startLine &&
    left.startCol === right.startCol &&
    left.endLine === right.endLine &&
    left.endCol === right.endCol
  );
}

function validRange(range: Range): boolean {
  const { startLine, startCol, endLine, endCol } = range;
  return (
    [startLine, startCol, endLine, endCol].every(Number.isSafeInteger) &&
    startLine >= 1 &&
    startCol >= 0 &&
    endLine >= startLine &&
    endCol >= 0 &&
    (endLine > startLine || endCol > startCol)
  );
}

function contains(outer: Range, inner: Range): boolean {
  return (
    (outer.startLine < inner.startLine ||
      (outer.startLine === inner.startLine && outer.startCol <= inner.startCol)) &&
    (outer.endLine > inner.endLine ||
      (outer.endLine === inner.endLine && outer.endCol >= inner.endCol))
  );
}

/** Function definitions own their declaration and bind it in the module. */
export const rustDeclarationBindingScope: NonNullable<LanguageProvider['bindingScopeFor']> = (
  match,
  innermost,
  tree,
) => {
  const anchor = match['@declaration.function'];
  const name = match['@declaration.name'];
  const stored = tree.getScope(innermost.id);
  const parent = tree.getParent(innermost.id);
  if (
    !anchor ||
    anchor.name !== '@declaration.function' ||
    anchor.text !== '' ||
    !name ||
    name.name !== '@declaration.name' ||
    !validName(name.text) ||
    Object.keys(match).length !== 2 ||
    innermost.kind !== 'Function' ||
    !sameRange(anchor.range, innermost.range) ||
    !stored ||
    stored.kind !== 'Function' ||
    stored.parent !== innermost.parent ||
    stored.filePath !== innermost.filePath ||
    !sameRange(stored.range, innermost.range) ||
    !parent ||
    parent.kind !== 'Module' ||
    parent.parent !== null ||
    parent.id !== innermost.parent ||
    parent.filePath !== innermost.filePath
  )
    unsupported();
  return parent.id;
};

/** Only explicit unrestricted pub functions contribute module exports. */
export const interpretRustExports: NonNullable<LanguageProvider['interpretExports']> = (
  matches,
  context,
) => {
  const modules = context.scopes.filter((scope) => scope.id === context.moduleScope);
  const module = modules[0];
  if (
    modules.length !== 1 ||
    !module ||
    module.kind !== 'Module' ||
    module.parent !== null ||
    module.filePath !== context.filePath
  )
    unsupported();
  const localIds = new Set(
    context.localDefs.filter((def) => def.filePath === context.filePath).map((def) => def.nodeId),
  );
  const exports = new Map<string, string>();
  for (const match of matches) {
    if (!Object.keys(match).some((key) => key.startsWith('@export.'))) continue;
    const local = match['@export.local'];
    const exported = match['@export.name'];
    if (
      Object.keys(match).length !== 2 ||
      !local ||
      !exported ||
      local.name !== '@export.local' ||
      exported.name !== '@export.name' ||
      !validName(local.text) ||
      exported.text !== local.text ||
      !validRange(local.range) ||
      !validRange(exported.range) ||
      !sameRange(local.range, exported.range) ||
      !contains(module.range, local.range)
    )
      unsupported();
    const bindings = module.bindings.get(local.text);
    const binding = bindings?.[0];
    if (
      !bindings ||
      bindings.length !== 1 ||
      !binding ||
      binding.origin !== 'local' ||
      binding.via !== undefined ||
      binding.def.type !== 'Function' ||
      binding.def.filePath !== context.filePath ||
      !localIds.has(binding.def.nodeId) ||
      exports.has(exported.text)
    )
      unsupported();
    exports.set(exported.text, binding.def.nodeId);
  }
  return exports;
};
