import type { Capture, CaptureMatch, Range } from 'ontoindex-shared';
import type { LanguageProvider } from '../language-provider.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

const EXPORT_KEYS = ['@export.local', '@export.name'] as const;
const IDENTIFIER = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

function unsupported(): never {
  throw new Error(
    'TS/JS export captures require ordinary local named exports and a unique local module binding',
  );
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type !== 'comment');
}

function capture(name: string, node: SyntaxNode): Capture {
  return {
    name,
    range: {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    },
    text: node.text,
  };
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

/** Detach ordinary top-level local export specifiers, refusing the whole unsupported statement. */
export function emitTypeScriptExportCaptures(node: SyntaxNode): CaptureMatch[] {
  if (
    node.type !== 'export_statement' ||
    !node.isNamed ||
    node.hasError ||
    node.isMissing ||
    node.parent?.type !== 'program'
  )
    unsupported();
  const cursor = node.walk();
  scan: while (true) {
    if (
      cursor.nodeIsMissing ||
      cursor.nodeType === 'ERROR' ||
      (!cursor.nodeIsNamed && cursor.nodeType === 'type')
    )
      unsupported();
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent() || cursor.currentNode.id === node.id) break scan;
    }
  }
  const statement = namedChildren(node);
  if (
    statement.length !== 1 ||
    statement[0].type !== 'export_clause' ||
    node.children.some((child) => !child.isNamed && !['export', ';'].includes(child.type))
  )
    unsupported();
  const clause = statement[0];
  if (clause.children.some((child) => !child.isNamed && !['{', '}', ','].includes(child.type)))
    unsupported();
  return namedChildren(clause).map((specifier) => {
    if (specifier.type !== 'export_specifier') unsupported();
    const local = specifier.childForFieldName('name');
    const alias = specifier.childForFieldName('alias');
    const names = namedChildren(specifier);
    if (
      !local ||
      names.length !== Number(local.isNamed) + Number(alias?.isNamed ?? false) ||
      local.type !== 'identifier' ||
      !IDENTIFIER.test(local.text) ||
      specifier.children.some(
        (child) => !child.isNamed && child.type !== 'as' && child.id !== alias?.id,
      )
    )
      unsupported();
    const exported = alias ?? local;
    if (
      !(
        (exported.type === 'identifier' && IDENTIFIER.test(exported.text)) ||
        (alias && exported.type === 'default' && exported.text === 'default')
      )
    )
      unsupported();
    return {
      '@export.local': capture('@export.local', local),
      '@export.name': capture('@export.name', exported),
    };
  });
}

/** Resolve explicit export names through completed canonical module bindings only. */
export const interpretTypeScriptExports: NonNullable<LanguageProvider['interpretExports']> = (
  matches,
  context,
) => {
  const exports = new Map<string, string>();
  const localIds = new Set(
    context.localDefs.filter((def) => def.filePath === context.filePath).map((def) => def.nodeId),
  );
  const modules = context.scopes.filter((scope) => scope.id === context.moduleScope);
  const module = modules[0];
  for (const match of matches) {
    const keys = Object.keys(match).filter((key) => key.startsWith('@export.'));
    if (keys.length === 0) continue;
    if (
      keys.length !== EXPORT_KEYS.length ||
      keys.some((key) => !EXPORT_KEYS.some((owned) => owned === key)) ||
      modules.length !== 1 ||
      !module ||
      module.kind !== 'Module' ||
      module.parent !== null ||
      module.filePath !== context.filePath ||
      !validRange(module.range)
    )
      unsupported();
    for (const key of EXPORT_KEYS) {
      const item = match[key];
      if (
        !item ||
        item.name !== key ||
        typeof item.text !== 'string' ||
        !IDENTIFIER.test(item.text) ||
        !item.range ||
        !validRange(item.range) ||
        !contains(module.range, item.range)
      )
        unsupported();
    }
    const local = match['@export.local'];
    const exported = match['@export.name'];
    const bindings = module.bindings.get(local.text);
    if (!bindings || bindings.length !== 1) unsupported();
    const binding = bindings[0];
    if (
      binding.origin !== 'local' ||
      binding.via !== undefined ||
      binding.def.filePath !== context.filePath ||
      !localIds.has(binding.def.nodeId) ||
      exports.has(exported.text)
    )
      unsupported();
    exports.set(exported.text, binding.def.nodeId);
  }
  return exports;
};
