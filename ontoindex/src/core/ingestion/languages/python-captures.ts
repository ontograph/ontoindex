import type { Capture, CaptureMatch, Range } from 'ontoindex-shared';
import type { LanguageProvider } from '../language-provider.js';
import { ScopeUnsupportedSyntaxError } from '../scope-unsupported-syntax.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

function unsupported(): never {
  throw new ScopeUnsupportedSyntaxError(
    'Python captures require the supported function-only module subset',
  );
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
    IDENTIFIER.test(node.text)
  );
}

function emptyArguments(node: SyntaxNode, type: string): void {
  const parts = children(node);
  if (node.type !== type || parts.length !== 2 || !token(parts[0], '(') || !token(parts[1], ')'))
    unsupported();
}

function appendCall(
  statement: SyntaxNode,
  knownNames: ReadonlySet<string>,
  matches: CaptureMatch[],
): void {
  const expressions = children(statement);
  const call = expressions[0];
  if (expressions.length !== 1 || call?.type !== 'call') unsupported();
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

function appendStatement(
  statement: SyntaxNode,
  knownNames: ReadonlySet<string>,
  matches: CaptureMatch[],
  allowReturn: boolean,
): void {
  const parts = children(statement);
  if (statement.type === 'pass_statement') {
    if (parts.length !== 1 || !token(parts[0], 'pass')) unsupported();
    return;
  }
  if (statement.type === 'return_statement' && allowReturn) {
    if (parts.length < 1 || parts.length > 2 || !token(parts[0], 'return')) unsupported();
    const value = parts[1];
    if (
      value &&
      (!value.isNamed ||
        value.children.length !== 0 ||
        !['integer', 'float', 'true', 'false', 'none'].includes(value.type) ||
        (['integer', 'float'].includes(value.type) && /j$/i.test(value.text)) ||
        (value.type === 'true' && value.text !== 'True') ||
        (value.type === 'false' && value.text !== 'False') ||
        (value.type === 'none' && value.text !== 'None'))
    )
      unsupported();
    return;
  }
  if (statement.type !== 'expression_statement') unsupported();
  appendCall(statement, knownNames, matches);
}

/** Detach complete captures for the deliberately narrow Python module subset. */
export function emitPythonCaptures(root: SyntaxNode): CaptureMatch[] {
  if (root.type !== 'module' || !root.isNamed || root.hasError || root.isMissing) unsupported();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.hasError || node.isMissing || node.type === 'ERROR') unsupported();
    pending.push(...node.children);
  }
  const matches: CaptureMatch[] = [{ '@scope.module': capture('@scope.module', root) }];
  const knownNames = new Set<string>();
  for (const statement of children(root)) {
    if (statement.type !== 'function_definition') {
      appendStatement(statement, knownNames, matches, false);
      continue;
    }
    const parts = children(statement);
    const name = statement.childForFieldName('name');
    const parameters = statement.childForFieldName('parameters');
    const body = statement.childForFieldName('body');
    if (
      !identifier(name) ||
      knownNames.has(name.text) ||
      !parameters ||
      !body ||
      body.type !== 'block' ||
      parts.length !== 5 ||
      !token(parts[0], 'def') ||
      parts[1]!.id !== name.id ||
      parts[2]!.id !== parameters.id ||
      !token(parts[3], ':') ||
      parts[4]!.id !== body.id
    )
      unsupported();
    emptyArguments(parameters, 'parameters');
    knownNames.add(name.text);
    matches.push(
      { '@scope.function': capture('@scope.function', statement) },
      {
        '@declaration.function': capture('@declaration.function', statement),
        '@declaration.name': capture('@declaration.name', name, name.text),
      },
    );
    const statements = children(body);
    if (statements.length === 0) unsupported();
    for (const child of statements) appendStatement(child, knownNames, matches, true);
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

/** Python function names bind in their containing module, without a body block. */
export const pythonDeclarationBindingScope: NonNullable<LanguageProvider['bindingScopeFor']> = (
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
    !IDENTIFIER.test(name.text) ||
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

/** This subset has no imports or __all__; every admitted module name is public. */
export const interpretPythonExports: NonNullable<LanguageProvider['interpretExports']> = (
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
      !IDENTIFIER.test(name) ||
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
