import type { DefId, ParsedFile, Range } from 'ontoindex-shared';
import type { SyntaxNode } from './utils/ast-helpers.js';

type Candidate = { fingerprint: string; key: string };

const declarationLabels: Readonly<Record<string, string>> = {
  function_declaration: 'Function',
  generator_function_declaration: 'Function',
  class_declaration: 'Class',
  abstract_class_declaration: 'Class',
};

function validRange(range: Range | null | undefined): range is Range {
  return (
    range != null &&
    Number.isSafeInteger(range.startLine) &&
    range.startLine >= 1 &&
    Number.isSafeInteger(range.endLine) &&
    range.endLine >= range.startLine &&
    Number.isSafeInteger(range.startCol) &&
    range.startCol >= 0 &&
    Number.isSafeInteger(range.endCol) &&
    range.endCol >= 0 &&
    (range.endLine > range.startLine || range.endCol > range.startCol)
  );
}

function declarationKey(filePath: string, range: Range, name: string, type: string): string {
  return JSON.stringify([
    filePath,
    range.startLine,
    range.startCol,
    range.endLine,
    range.endCol,
    name,
    type,
  ]);
}

/** Collect before graph deduplication so every competing capture can veto an ID. */
export function createDeclarationCorrespondence(filePath: string): {
  observe(nodeId: string, name: string, label: string, node: SyntaxNode | null | undefined): void;
  attach(parsedFile: ParsedFile): ParsedFile;
} {
  const candidates = new Map<string, Candidate | null>();
  const nodeByKey = new Map<string, string | null>();
  return {
    observe(nodeId, name, label, node) {
      if (node?.type === 'export_statement') {
        node = node.hasError || node.isMissing ? null : node.childForFieldName('declaration');
      }
      // `const f = () => {}` anchors its Function definition at the initializer (anonymous) or the
      // declarator (named expression); map the legacy lexical node to exactly that anchor.
      let callableBinding = false;
      if (
        label === 'Function' &&
        node?.type === 'lexical_declaration' &&
        !node.hasError &&
        !node.isMissing &&
        node.children.some((child) => child.type === 'const' && !child.isNamed)
      ) {
        const matches = node.namedChildren.filter(
          (child) =>
            child.type === 'variable_declarator' &&
            !child.hasError &&
            !child.isMissing &&
            child.childForFieldName('name')?.type === 'identifier' &&
            child.childForFieldName('name')?.text === name,
        );
        const declarator = matches.length === 1 ? matches[0] : undefined;
        const value = declarator?.childForFieldName('value');
        if (
          value &&
          !value.hasError &&
          !value.isMissing &&
          ['arrow_function', 'function_expression'].includes(value.type)
        ) {
          node = value.childForFieldName('name') ? declarator : value;
          callableBinding = true;
        }
      }
      let candidate: Candidate | null = null;
      if (
        node &&
        name &&
        (callableBinding ||
          (declarationLabels[node.type] === label &&
            node.childForFieldName('name')?.text === name)) &&
        !node.hasError &&
        !node.isMissing
      ) {
        const range: Range = {
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column,
        };
        if (
          validRange(range) &&
          Number.isSafeInteger(node.startIndex) &&
          Number.isSafeInteger(node.endIndex) &&
          node.startIndex >= 0 &&
          node.endIndex > node.startIndex
        ) {
          const key = declarationKey(filePath, range, name, label);
          candidate = {
            key,
            fingerprint: JSON.stringify([key, node.type, node.startIndex, node.endIndex]),
          };
        }
      }
      if (candidate) {
        const previousNode = nodeByKey.get(candidate.key);
        nodeByKey.set(
          candidate.key,
          previousNode === undefined || previousNode === nodeId ? nodeId : null,
        );
      }
      const previous = candidates.get(nodeId);
      candidates.set(
        nodeId,
        !candidates.has(nodeId)
          ? candidate
          : previous && candidate && previous.fingerprint === candidate.fingerprint
            ? previous
            : null,
      );
    },
    attach(parsedFile) {
      const { definitionNodeIds: _previous, ...rest } = parsedFile;
      if (parsedFile.declarationSources === undefined) return Object.freeze(rest);
      const empty = () => Object.freeze({ ...rest, definitionNodeIds: Object.freeze([]) });
      if (!Array.isArray(parsedFile.declarationSources)) return empty();
      const localDefs = new Map(parsedFile.localDefs.map((def) => [def.nodeId, def]));

      const sourceByKey = new Map<string, DefId | null>();
      const keyByDef = new Map<DefId, string | null>();
      for (const source of parsedFile.declarationSources) {
        if (
          !source ||
          typeof source.defId !== 'string' ||
          !source.defId ||
          typeof source.name !== 'string' ||
          !source.name ||
          typeof source.type !== 'string' ||
          !validRange(source.range)
        )
          return empty();
        const localDef = localDefs.get(source.defId);
        if (
          !localDef ||
          localDef.filePath !== parsedFile.filePath ||
          localDef.type !== source.type
        ) {
          return empty();
        }
        const key = declarationKey(parsedFile.filePath, source.range, source.name, source.type);
        const previousDef = sourceByKey.get(key);
        sourceByKey.set(
          key,
          previousDef === undefined || previousDef === source.defId ? source.defId : null,
        );
        const previousKey = keyByDef.get(source.defId);
        keyByDef.set(source.defId, previousKey === undefined || previousKey === key ? key : null);
      }
      const definitionNodeIds: NonNullable<ParsedFile['definitionNodeIds']>[number][] = [];
      for (const [defId, key] of keyByDef) {
        if (key === null || sourceByKey.get(key) !== defId) continue;
        const nodeId = nodeByKey.get(key);
        if (nodeId && candidates.get(nodeId)?.key === key) {
          definitionNodeIds.push(Object.freeze({ defId, nodeId }));
        }
      }
      return Object.freeze({ ...rest, definitionNodeIds: Object.freeze(definitionNodeIds) });
    },
  };
}
