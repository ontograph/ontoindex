import type { Capture, CaptureMatch, ParsedImport } from 'ontoindex-shared';
import { ScopeUnsupportedSyntaxError } from '../scope-unsupported-syntax.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

const IMPORT_KEYS = ['@import.binding', '@import.source', '@import.name', '@import.kind'] as const;
const IDENTIFIER = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

function unsupported(): never {
  throw new ScopeUnsupportedSyntaxError(
    'TS/JS import captures require a supported ordinary static import',
  );
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type !== 'comment');
}

function identifier(node: SyntaxNode): string {
  if (node.type !== 'identifier' || !IDENTIFIER.test(node.text)) unsupported();
  return node.text;
}

function plainString(node: SyntaxNode): string {
  const text = node.text;
  if (
    node.type !== 'string' ||
    !['"', "'"].includes(text[0]) ||
    text.length < 2 ||
    text.at(-1) !== text[0] ||
    /[\\\r\n\u2028\u2029]/u.test(text)
  )
    unsupported();
  return text.slice(1, -1);
}

function capture(name: string, node: SyntaxNode, text: string): Capture {
  return {
    name,
    range: {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    },
    text,
  };
}

/** Detach ordinary static bindings; refuse unsupported syntax for the whole statement. */
export function emitTypeScriptImportCaptures(importNode: SyntaxNode): CaptureMatch[] {
  if (importNode.type !== 'import_statement' || importNode.hasError || importNode.isMissing)
    unsupported();
  const statementTokens = importNode.children.filter((child) => child.type !== 'comment');
  const statementType =
    statementTokens[1]?.type === 'type' && !statementTokens[1].isNamed
      ? statementTokens[1]
      : undefined;
  const cursor = importNode.walk();
  scan: while (true) {
    const node = cursor.currentNode;
    const inlineType =
      !cursor.nodeIsNamed &&
      cursor.nodeType === 'type' &&
      node.parent?.type === 'import_specifier' &&
      node.parent.children.find((child) => child.type !== 'comment')?.id === node.id;
    if (
      cursor.nodeIsMissing ||
      cursor.nodeType === 'ERROR' ||
      (!cursor.nodeIsNamed &&
        ['type', 'typeof'].includes(cursor.nodeType) &&
        !inlineType &&
        node.id !== statementType?.id)
    )
      unsupported();
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent() || cursor.currentNode.id === importNode.id) break scan;
    }
  }

  const statement = namedChildren(importNode);
  if (
    statement.length !== 2 ||
    statement[0].type !== 'import_clause' ||
    statement[1].type !== 'string'
  )
    unsupported();
  const source = statement[1];
  if (
    statementType &&
    (statementTokens.length !== (statementTokens.at(-1)?.type === ';' ? 6 : 5) ||
      statementTokens[0]?.type !== 'import' ||
      statementTokens[0]?.text !== 'import' ||
      statementTokens[0]?.isNamed ||
      statementType.text !== 'type' ||
      statementTokens[2]?.id !== statement[0].id ||
      statementTokens[3]?.type !== 'from' ||
      statementTokens[3]?.text !== 'from' ||
      statementTokens[3]?.isNamed ||
      statementTokens[4]?.id !== source.id ||
      (statementTokens.length === 6 &&
        (statementTokens[5]?.text !== ';' || statementTokens[5]?.isNamed)))
  )
    unsupported();
  const targetRaw = plainString(source);
  const matches: CaptureMatch[] = [];
  const emit = (
    local: SyntaxNode,
    imported: SyntaxNode,
    importedName: string,
    kind: 'named' | 'alias' | 'namespace',
    typeModifier?: SyntaxNode,
  ) => {
    matches.push({
      '@import.binding': capture('@import.binding', local, identifier(local)),
      '@import.source': capture('@import.source', source, targetRaw),
      '@import.name': capture('@import.name', imported, importedName),
      '@import.kind': capture('@import.kind', local, kind),
      ...(typeModifier
        ? { '@import.namespace': capture('@import.namespace', typeModifier, 'type') }
        : {}),
    });
  };

  const clause = namedChildren(statement[0]);
  if (statementType && (clause.length !== 1 || clause[0].type !== 'named_imports')) unsupported();
  if (
    clause.length === 0 ||
    clause.length > 2 ||
    (clause.length === 2 && clause[0].type !== 'identifier')
  )
    unsupported();
  for (let i = 0; i < clause.length; i++) {
    const child = clause[i];
    if (child.type === 'identifier' && i === 0) {
      emit(child, child, 'default', 'alias');
    } else if (child.type === 'namespace_import') {
      const names = namedChildren(child);
      if (names.length !== 1) unsupported();
      emit(names[0], source, targetRaw, 'namespace');
    } else if (child.type === 'named_imports') {
      const specifiers = namedChildren(child);
      if (specifiers.length === 0 && !(i === 1 && clause[0].type === 'identifier')) unsupported();
      for (const specifier of specifiers) {
        if (specifier.type !== 'import_specifier') unsupported();
        const names = namedChildren(specifier);
        const name = specifier.childForFieldName('name');
        const alias = specifier.childForFieldName('alias');
        if (!name || names.length !== Number(name.isNamed) + Number(alias?.isNamed ?? false))
          unsupported();
        const tokens = specifier.children.filter((child) => child.type !== 'comment');
        const modifier = tokens[0]?.type === 'type' && !tokens[0].isNamed ? tokens[0] : undefined;
        const offset = modifier ? 1 : 0;
        if (
          tokens.length !== offset + (alias ? 3 : 1) ||
          tokens[offset]?.id !== name.id ||
          (statementType && (modifier || name.type !== 'identifier' || name.text === 'default')) ||
          (modifier &&
            (modifier.text !== 'type' || name.type !== 'identifier' || name.text === 'default')) ||
          (alias &&
            (tokens[offset + 1]?.type !== 'as' ||
              tokens[offset + 1]?.text !== 'as' ||
              tokens[offset + 1]?.isNamed ||
              tokens[offset + 2]?.id !== alias.id))
        )
          unsupported();
        const importedName =
          name.type === 'string'
            ? plainString(name)
            : name.type === 'default' && name.text === 'default'
              ? 'default'
              : identifier(name);
        if (name.type === 'string' && !alias) unsupported();
        emit(
          alias ?? name,
          name,
          importedName,
          alias ? 'alias' : 'named',
          modifier ?? statementType,
        );
      }
    } else {
      unsupported();
    }
  }
  return matches;
}

/** Interpret only this helper's detached capture contract. */
export function interpretTypeScriptImport(match: CaptureMatch): ParsedImport | null {
  if (!Object.keys(match).some((key) => key.startsWith('@import.'))) return null;
  const hasNamespace = Object.prototype.hasOwnProperty.call(match, '@import.namespace');
  for (const key of Object.keys(match)) {
    if (
      key.startsWith('@import.') &&
      key !== '@import.namespace' &&
      !IMPORT_KEYS.some((owned) => owned === key)
    )
      unsupported();
  }
  for (const key of [...IMPORT_KEYS, ...(hasNamespace ? ['@import.namespace'] : [])]) {
    const item = match[key];
    if (!item || item.name !== key || typeof item.text !== 'string' || !item.range) unsupported();
    const { startLine, startCol, endLine, endCol } = item.range;
    if (
      ![startLine, startCol, endLine, endCol].every(Number.isSafeInteger) ||
      startLine < 1 ||
      startCol < 0 ||
      endLine < startLine ||
      endCol < 0 ||
      (endLine === startLine && (endCol < startCol || (hasNamespace && endCol === startCol)))
    )
      unsupported();
  }
  const localName = match['@import.binding'].text;
  const targetRaw = match['@import.source'].text;
  const importedName = match['@import.name'].text;
  const kind = match['@import.kind'].text;
  const namespace = match['@import.namespace'];
  if (
    namespace &&
    (!['named', 'alias', 'reexport'].includes(kind) ||
      namespace.text !== 'type' ||
      !IDENTIFIER.test(importedName) ||
      importedName === 'default' ||
      localName === 'default')
  )
    unsupported();
  if (
    !IDENTIFIER.test(localName) ||
    /[\\\r\n\u2028\u2029]/u.test(targetRaw) ||
    /[\\\r\n\u2028\u2029]/u.test(importedName)
  )
    unsupported();
  switch (kind) {
    case 'reexport':
      if (
        !IDENTIFIER.test(importedName) ||
        importedName === 'default' ||
        localName === 'default' ||
        [...IMPORT_KEYS, ...(hasNamespace ? ['@import.namespace'] : [])].some((key) => {
          const range = match[key]!.range;
          return range.startLine === range.endLine && range.startCol === range.endCol;
        })
      )
        unsupported();
      return {
        kind,
        localName,
        importedName,
        targetRaw,
        ...(localName !== importedName ? { alias: localName } : {}),
        ...(namespace ? { namespace: 'type' as const } : {}),
      };
    case 'named':
      if (importedName !== localName) unsupported();
      return {
        kind,
        localName,
        importedName,
        targetRaw,
        ...(namespace ? { namespace: 'type' as const } : {}),
      };
    case 'alias':
      return {
        kind,
        localName,
        importedName,
        alias: localName,
        targetRaw,
        ...(namespace ? { namespace: 'type' as const } : {}),
      };
    case 'namespace':
      if (importedName !== targetRaw) unsupported();
      return { kind, localName, importedName, targetRaw };
    default:
      return unsupported();
  }
}
