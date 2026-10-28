import type { Capture, CaptureMatch, Range } from 'ontoindex-shared';
import type { LanguageProvider } from '../language-provider.js';
import { ScopeUnsupportedSyntaxError } from '../scope-unsupported-syntax.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const RESERVED_NAMES = new Set([
  'alignas',
  'alignof',
  'and',
  'and_eq',
  'asm',
  'atomic_cancel',
  'atomic_commit',
  'atomic_noexcept',
  'auto',
  'bitand',
  'bitor',
  'bool',
  'break',
  'case',
  'catch',
  'char',
  'char8_t',
  'char16_t',
  'char32_t',
  'class',
  'compl',
  'concept',
  'const',
  'consteval',
  'constexpr',
  'constinit',
  'const_cast',
  'continue',
  'co_await',
  'co_return',
  'co_yield',
  'decltype',
  'default',
  'delete',
  'do',
  'double',
  'dynamic_cast',
  'else',
  'enum',
  'explicit',
  'export',
  'extern',
  'false',
  'float',
  'for',
  'friend',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'mutable',
  'namespace',
  'new',
  'noexcept',
  'not',
  'not_eq',
  'nullptr',
  'operator',
  'or',
  'or_eq',
  'private',
  'protected',
  'public',
  'reflexpr',
  'register',
  'reinterpret_cast',
  'requires',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'static_assert',
  'static_cast',
  'struct',
  'switch',
  'synchronized',
  'template',
  'this',
  'thread_local',
  'throw',
  'true',
  'try',
  'typedef',
  'typeid',
  'typename',
  'union',
  'unsigned',
  'using',
  'virtual',
  'void',
  'volatile',
  'wchar_t',
  'while',
  'xor',
  'xor_eq',
  'main',
]);

function unsupported(): never {
  throw new ScopeUnsupportedSyntaxError(
    'C++ captures require the supported function-only translation unit subset',
  );
}

function validName(name: string): boolean {
  return IDENTIFIER.test(name) && !name.includes('__') && !RESERVED_NAMES.has(name);
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
  return node.children.filter((child) => child.type !== 'comment');
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
): void {
  const expressions = children(statement);
  if (statement.type === 'return_statement') {
    if (expressions.length !== 2 || !token(expressions[0], 'return') || !token(expressions[1], ';'))
      unsupported();
    return;
  }
  const call = expressions[0];
  if (
    statement.type !== 'expression_statement' ||
    expressions.length !== 2 ||
    call?.type !== 'call_expression' ||
    !token(expressions[1], ';')
  )
    unsupported();
  const parts = children(call);
  const callee = call.childForFieldName('function');
  const args = call.childForFieldName('arguments');
  if (
    !identifier(callee) ||
    !knownNames.has(callee.text) ||
    !args ||
    parts.length !== 2 ||
    parts[0]!.id !== callee.id ||
    parts[1]!.id !== args.id
  )
    unsupported();
  emptyArguments(args, 'argument_list');
  matches.push({
    '@reference.call.free': capture('@reference.call.free', call),
    '@reference.name': capture('@reference.name', callee, callee.text),
    '@reference.arity': capture('@reference.arity', args, '0'),
  });
}

/** Detach complete captures from the deliberately narrow borrowed C++ tree. */
export function emitCppCaptures(root: SyntaxNode): CaptureMatch[] {
  if (root.type !== 'translation_unit' || !root.isNamed || root.hasError || root.isMissing)
    unsupported();
  const topLevelStatements = root.children.filter((child) => child.type !== 'comment');
  if (topLevelStatements.some((statement) => statement.type !== 'function_definition'))
    unsupported();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.hasError || node.isMissing || node.type === 'ERROR') unsupported();
    pending.push(...node.children);
  }
  const matches: CaptureMatch[] = [{ '@scope.module': capture('@scope.module', root) }];
  const knownNames = new Set<string>();
  for (const statement of topLevelStatements) {
    const parts = children(statement);
    const type = statement.childForFieldName('type');
    const declarator = statement.childForFieldName('declarator');
    const body = statement.childForFieldName('body');
    if (
      !type ||
      type.type !== 'primitive_type' ||
      type.text !== 'void' ||
      !type.isNamed ||
      type.children.length !== 0 ||
      !declarator ||
      declarator.type !== 'function_declarator' ||
      !body ||
      body.type !== 'compound_statement' ||
      parts.length !== 3 ||
      parts[0]!.id !== type.id ||
      parts[1]!.id !== declarator.id ||
      parts[2]!.id !== body.id
    )
      unsupported();
    const signature = children(declarator);
    const name = declarator.childForFieldName('declarator');
    const parameters = declarator.childForFieldName('parameters');
    if (
      !identifier(name) ||
      knownNames.has(name.text) ||
      !parameters ||
      signature.length !== 2 ||
      signature[0]!.id !== name.id ||
      signature[1]!.id !== parameters.id
    )
      unsupported();
    emptyArguments(parameters, 'parameter_list');
    const statements = children(body);
    if (
      statements.length < 2 ||
      !token(statements[0], '{') ||
      !token(statements[statements.length - 1], '}')
    )
      unsupported();
    knownNames.add(name.text);
    matches.push(
      { '@scope.function': capture('@scope.function', statement) },
      {
        '@scope.block': capture('@scope.block', body),
      },
      {
        '@declaration.function': capture('@declaration.function', statement),
        '@declaration.name': capture('@declaration.name', name, name.text),
      },
    );
    for (const child of statements.slice(1, -1)) appendStatement(child, knownNames, matches);
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

/** Function definitions own their declaration and bind it in the module. */
export const cppDeclarationBindingScope: NonNullable<LanguageProvider['bindingScopeFor']> = (
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

/** All admitted functions have external linkage and are explicit exports. */
export const interpretCppExports: NonNullable<LanguageProvider['interpretExports']> = (
  _matches,
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
  const localIds = new Set(context.localDefs.map((def) => def.nodeId));
  const exports = new Map<string, string>();
  for (const [name, bindings] of module.bindings) {
    const binding = bindings[0];
    if (
      !validName(name) ||
      bindings.length !== 1 ||
      !binding ||
      binding.origin !== 'local' ||
      binding.via !== undefined ||
      binding.def.type !== 'Function' ||
      binding.def.filePath !== context.filePath ||
      !localIds.has(binding.def.nodeId)
    )
      unsupported();
    exports.set(name, binding.def.nodeId);
  }
  return exports;
};
