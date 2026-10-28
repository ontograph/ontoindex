import type { Capture, CaptureMatch, Range } from 'ontoindex-shared';
import { ScopeUnsupportedSyntaxError } from '../scope-unsupported-syntax.js';
import type { LanguageProvider } from '../language-provider.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { interpretTypeScriptImport } from './typescript-import-captures.js';
import {
  emitTypeScriptDeclarationCaptures,
  emitTypeScriptLexicalBindingCaptures,
  emitTypeScriptVarBindingCaptures,
  emitTypeScriptVarBindingCapturesForNodes,
} from './typescript-declaration-captures.js';

const EXPORT_KEYS = ['@export.local', '@export.name'] as const;
const IDENTIFIER = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

function unsupported(): never {
  throw new ScopeUnsupportedSyntaxError(
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

/** Detach top-level local exports and bounded source-bearing named reexports. */
export function emitTypeScriptExportCaptures(node: SyntaxNode): CaptureMatch[] {
  return emitExportCaptures(node, emitTypeScriptVarBindingCaptures);
}

/** Detach direct exports while sharing module collision validation for exported var bindings. */
export function emitTypeScriptExportCapturesForFile(root: SyntaxNode): CaptureMatch[] {
  if (root.type !== 'program' || !root.isNamed || root.hasError || root.isMissing) unsupported();
  const statements = root.namedChildren.filter((node) => node.type === 'export_statement');
  const publishedNames = new Set<string>();
  const clauses = statements
    .map((node) => node.childForFieldName('declaration'))
    .filter((node): node is SyntaxNode => node?.type === 'variable_declaration');
  const groups = emitTypeScriptVarBindingCapturesForNodes(clauses);
  const bindings = new Map(clauses.map((node, index) => [node.id, groups[index]!]));
  const matches = statements.flatMap((node) =>
    emitExportCaptures(node, (clause) => {
      const captures = bindings.get(clause.id);
      if (!captures) unsupported();
      return captures;
    }),
  );
  for (const match of matches) {
    const name = (match['@export.name'] ?? match['@import.binding'])!.text;
    if (publishedNames.has(name)) unsupported();
    publishedNames.add(name);
  }
  return matches;
}

function emitReexportCaptures(node: SyntaxNode, source: SyntaxNode): CaptureMatch[] {
  const children = node.children.filter((child) => child.type !== 'comment');
  const typeOnly = children[1]?.type === 'type' && !children[1].isNamed;
  const clauseIndex = typeOnly ? 2 : 1;
  const clause = children[clauseIndex];
  const last = children.at(-1)!;
  if (
    children.length !== clauseIndex + 3 + Number(last.type === ';' && !last.isNamed) ||
    children[0]?.type !== 'export' ||
    children[0].isNamed ||
    !clause ||
    clause.type !== 'export_clause' ||
    !clause.isNamed ||
    children[clauseIndex + 1]?.type !== 'from' ||
    children[clauseIndex + 1]!.isNamed ||
    children[clauseIndex + 2]?.id !== source.id ||
    source.type !== 'string' ||
    !source.isNamed ||
    source.text.length < 2 ||
    !['"', "'"].includes(source.text[0]!) ||
    source.text.at(-1) !== source.text[0] ||
    /[\\\r\n\u2028\u2029]/u.test(source.text)
  )
    unsupported();
  const statementRange = capture('', node).range;
  if (!validRange(statementRange)) unsupported();
  const list = clause.children.filter((child) => child.type !== 'comment');
  if (
    list.length < 3 ||
    list[0]!.type !== '{' ||
    list[0]!.isNamed ||
    list.at(-1)!.type !== '}' ||
    list.at(-1)!.isNamed
  )
    unsupported();
  const matches: CaptureMatch[] = [];
  const publishedNames = new Set<string>();
  let expectSpecifier = true;
  for (const specifier of list.slice(1, -1)) {
    if (!expectSpecifier) {
      if (specifier.type !== ',' || specifier.isNamed) unsupported();
      expectSpecifier = true;
      continue;
    }
    if (specifier.type !== 'export_specifier' || !specifier.isNamed) unsupported();
    const name = specifier.childForFieldName('name');
    const alias = specifier.childForFieldName('alias');
    const tokens = specifier.children.filter((child) => child.type !== 'comment');
    const inlineType = tokens[0]?.type === 'type' && !tokens[0].isNamed;
    const offset = Number(inlineType);
    if (
      (typeOnly && inlineType) ||
      !name ||
      name.type !== 'identifier' ||
      !name.isNamed ||
      !IDENTIFIER.test(name.text) ||
      name.text === 'default' ||
      (alias &&
        (alias.type !== 'identifier' ||
          !alias.isNamed ||
          !IDENTIFIER.test(alias.text) ||
          alias.text === 'default')) ||
      tokens.length !== offset + (alias ? 3 : 1) ||
      tokens[offset]?.id !== name.id ||
      (alias &&
        (tokens[offset + 1]?.type !== 'as' ||
          tokens[offset + 1]!.isNamed ||
          tokens[offset + 2]?.id !== alias.id))
    )
      unsupported();
    const published = alias ?? name;
    if (publishedNames.has(published.text)) unsupported();
    publishedNames.add(published.text);
    const match: CaptureMatch = {
      '@import.binding': capture('@import.binding', published),
      '@import.source': { ...capture('@import.source', source), text: source.text.slice(1, -1) },
      '@import.name': capture('@import.name', name),
      '@import.kind': { ...capture('@import.kind', published), text: 'reexport' },
      ...(typeOnly || inlineType
        ? {
            '@import.namespace': { ...capture('@import.namespace', published), text: 'type' },
          }
        : {}),
    };
    for (const item of Object.values(match)) {
      if (!validRange(item.range) || !contains(statementRange, item.range)) unsupported();
    }
    matches.push(match);
    expectSpecifier = false;
  }
  if (matches.length === 0) unsupported();
  return matches;
}

function emitExportCaptures(
  node: SyntaxNode,
  varBindings: (node: SyntaxNode) => CaptureMatch[],
): CaptureMatch[] {
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
    if (cursor.nodeIsMissing || cursor.nodeType === 'ERROR' || cursor.currentNode.hasError)
      unsupported();
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent() || cursor.currentNode.id === node.id) break scan;
    }
  }
  const source = node.childForFieldName('source');
  if (source) return emitReexportCaptures(node, source);
  const statement = namedChildren(node);
  if (
    statement.length !== 1 ||
    node.children.some((child) => !child.isNamed && !['export', ';'].includes(child.type))
  )
    unsupported();
  const clause = statement[0];
  if (
    [
      'function_declaration',
      'generator_function_declaration',
      'class_declaration',
      'abstract_class_declaration',
      'enum_declaration',
      'interface_declaration',
      'type_alias_declaration',
    ].includes(clause.type)
  ) {
    if (
      ['enum_declaration', 'interface_declaration', 'type_alias_declaration'].includes(clause.type)
    )
      emitTypeScriptDeclarationCaptures(clause);
    if (
      clause.type === 'abstract_class_declaration' &&
      clause.namedChildren.some((child) => child.type === 'decorator')
    )
      unsupported();
    const name = clause.childForFieldName('name');
    if (
      !name ||
      !['identifier', 'type_identifier'].includes(name.type) ||
      !IDENTIFIER.test(name.text)
    )
      unsupported();
    return [
      {
        '@export.local': capture('@export.local', name),
        '@export.name': capture('@export.name', name),
      },
    ];
  }
  if (clause.type === 'lexical_declaration' || clause.type === 'variable_declaration') {
    const bindings =
      clause.type === 'lexical_declaration'
        ? emitTypeScriptLexicalBindingCaptures(clause)
        : varBindings(clause);
    return bindings.map((binding) => {
      const name = binding['@declaration.name']!;
      return {
        '@export.local': { ...name, range: { ...name.range }, name: '@export.local' },
        '@export.name': { ...name, range: { ...name.range }, name: '@export.name' },
      };
    });
  }
  if (clause.type !== 'export_clause') unsupported();
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
  const publishedNames = new Set<string>();
  const localIds = new Set(
    context.localDefs.filter((def) => def.filePath === context.filePath).map((def) => def.nodeId),
  );
  const modules = context.scopes.filter((scope) => scope.id === context.moduleScope);
  const module = modules[0];
  for (const match of matches) {
    if (match['@import.kind']?.text === 'reexport') {
      if (
        Object.keys(match).some((key) => key.startsWith('@export.')) ||
        modules.length !== 1 ||
        !module ||
        module.kind !== 'Module' ||
        module.parent !== null ||
        module.filePath !== context.filePath ||
        !validRange(module.range)
      )
        unsupported();
      const reexport = interpretTypeScriptImport(match);
      if (reexport?.kind !== 'reexport' || publishedNames.has(reexport.localName)) unsupported();
      for (const [key, item] of Object.entries(match)) {
        if (key.startsWith('@import.') && !contains(module.range, item.range)) unsupported();
      }
      publishedNames.add(reexport.localName);
      continue;
    }
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
      publishedNames.has(exported.text)
    )
      unsupported();
    exports.set(exported.text, binding.def.nodeId);
    publishedNames.add(exported.text);
  }
  return exports;
};
