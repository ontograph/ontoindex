import { describe, expect, it } from 'vitest';
import type { ParsedFile, Range } from 'ontoindex-shared';
import { createDeclarationCorrespondence } from '../../src/core/ingestion/declaration-correspondence.js';
import {
  decodeParsedFileRecord,
  encodeParsedFileRecord,
} from '../../src/core/ingestion/pipeline-phases/parse-scope-codec.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from 'ontoindex-shared';

const filePath = 'src/declarations.ts';
type DeclarationSource = NonNullable<ParsedFile['declarationSources']>[number];
const range: Range = { startLine: 3, startCol: 4, endLine: 5, endCol: 9 };

function declaration(
  name = 'save',
  at = range,
  type = 'function_declaration',
  startIndex = 20,
): SyntaxNode {
  return {
    type,
    startPosition: { row: at.startLine - 1, column: at.startCol },
    endPosition: { row: at.endLine - 1, column: at.endCol },
    startIndex,
    endIndex: startIndex + 30,
    hasError: false,
    isMissing: false,
    childForFieldName: (field: string) => (field === 'name' ? { text: name } : null),
  } as unknown as SyntaxNode;
}

function source(
  defId = 'def:save',
  name = 'save',
  at = range,
  type: DeclarationSource['type'] = 'Function',
): DeclarationSource {
  return { defId, name, range: at, type };
}

function parsedFile(declarationSources?: readonly DeclarationSource[]): ParsedFile {
  return {
    filePath,
    moduleScope: 'scope:module',
    scopes: [],
    parsedImports: [],
    localDefs: (declarationSources ?? []).map(({ defId, type }) => ({
      nodeId: defId,
      filePath,
      type,
    })),
    referenceSites: [],
    ...(declarationSources === undefined ? {} : { declarationSources }),
  };
}

describe('declaration correspondence', () => {
  it.each([
    ['function_declaration', 'Function'],
    ['generator_function_declaration', 'Function'],
    ['class_declaration', 'Class'],
    ['abstract_class_declaration', 'Class'],
  ] as const)(
    'maps a unique named %s using one-based lines and unchanged columns',
    (type, label) => {
      const correspondence = createDeclarationCorrespondence(filePath);
      correspondence.observe('graph:save', 'save', label, declaration('save', range, type));
      expect(
        correspondence.attach(parsedFile([source('def:save', 'save', range, label)]))
          .definitionNodeIds,
      ).toEqual([{ defId: 'def:save', nodeId: 'graph:save' }]);
    },
  );

  it('canonicalizes exported declarations and deduplicates repeated captures', () => {
    const correspondence = createDeclarationCorrespondence(filePath);
    const node = declaration();
    const exported = {
      type: 'export_statement',
      childForFieldName: (field: string) => (field === 'declaration' ? node : null),
    } as unknown as SyntaxNode;
    correspondence.observe('graph:save', 'save', 'Function', exported);
    correspondence.observe('graph:save', 'save', 'Function', node);
    correspondence.observe('graph:save', 'save', 'Function', declaration());
    expect(correspondence.attach(parsedFile([source(), source()])).definitionNodeIds).toEqual([
      { defId: 'def:save', nodeId: 'graph:save' },
    ]);
  });

  it('keeps nested same-name declarations distinct by their full ranges', () => {
    const outer = { startLine: 1, startCol: 0, endLine: 9, endCol: 1 };
    const inner = { startLine: 3, startCol: 2, endLine: 4, endCol: 3 };
    const correspondence = createDeclarationCorrespondence(filePath);
    correspondence.observe(
      'graph:outer',
      'save',
      'Function',
      declaration('save', outer, undefined, 0),
    );
    correspondence.observe(
      'graph:inner',
      'save',
      'Function',
      declaration('save', inner, undefined, 15),
    );
    expect(
      correspondence.attach(
        parsedFile([source('def:outer', 'save', outer), source('def:inner', 'save', inner)]),
      ).definitionNodeIds,
    ).toEqual([
      { defId: 'def:outer', nodeId: 'graph:outer' },
      { defId: 'def:inner', nodeId: 'graph:inner' },
    ]);
  });

  it('distinguishes same-line declarations by columns instead of choosing the first name', () => {
    const first = { startLine: 1, startCol: 0, endLine: 1, endCol: 18 };
    const second = { startLine: 1, startCol: 20, endLine: 1, endCol: 38 };
    const correspondence = createDeclarationCorrespondence(filePath);
    correspondence.observe(
      'graph:first',
      'save',
      'Function',
      declaration('save', first, undefined, 0),
    );
    correspondence.observe(
      'graph:second',
      'save',
      'Function',
      declaration('save', second, undefined, 20),
    );
    expect(
      correspondence.attach(
        parsedFile([source('def:second', 'save', second), source('def:first', 'save', first)]),
      ).definitionNodeIds,
    ).toEqual([
      { defId: 'def:second', nodeId: 'graph:second' },
      { defId: 'def:first', nodeId: 'graph:first' },
    ]);
  });

  it.each(['file', 'range', 'name', 'type'] as const)(
    'refuses a source with a different %s',
    (mismatch) => {
      const correspondence = createDeclarationCorrespondence(filePath);
      correspondence.observe('graph:save', 'save', 'Function', declaration());
      const candidate = source();
      const file = parsedFile([
        {
          ...candidate,
          ...(mismatch === 'range' ? { range: { ...range, endCol: range.endCol + 1 } } : {}),
          ...(mismatch === 'name' ? { name: 'other' } : {}),
          ...(mismatch === 'type' ? { type: 'Class' as const } : {}),
        },
      ]);
      expect(
        correspondence.attach(mismatch === 'file' ? { ...file, filePath: 'other.ts' } : file)
          .definitionNodeIds,
      ).toEqual([]);
    },
  );

  it.each([
    ['unsupported', () => declaration('save', range, 'method_definition')],
    ['missing', () => null],
    ['undefined', () => undefined],
    ['different declaration', () => declaration('save', { ...range, startCol: 5 })],
    ['different byte provenance', () => declaration('save', range, undefined, 21)],
  ] as const)(
    'invalidates a graph ID when a competing capture is %s in either order',
    (_kind, competing) => {
      for (const reverse of [false, true]) {
        const correspondence = createDeclarationCorrespondence(filePath);
        const captures = [declaration(), competing()];
        if (reverse) captures.reverse();
        for (const node of captures) correspondence.observe('graph:save', 'save', 'Function', node);
        // A later valid duplicate must not restore an ambiguous ID.
        correspondence.observe('graph:save', 'save', 'Function', declaration());
        expect(correspondence.attach(parsedFile([source()])).definitionNodeIds).toEqual([]);
      }
    },
  );

  it('refuses multiple graph IDs for one declaration while preserving an unrelated declaration', () => {
    const correspondence = createDeclarationCorrespondence(filePath);
    correspondence.observe('graph:first', 'save', 'Function', declaration());
    correspondence.observe('graph:second', 'save', 'Function', declaration());
    correspondence.observe('graph:other', 'other', 'Function', declaration('other'));
    expect(
      correspondence.attach(parsedFile([source(), source('def:other', 'other')])).definitionNodeIds,
    ).toEqual([{ defId: 'def:other', nodeId: 'graph:other' }]);
  });

  it('refuses multiple DefIds for the same declaration provenance', () => {
    const correspondence = createDeclarationCorrespondence(filePath);
    correspondence.observe('graph:save', 'save', 'Function', declaration());
    expect(
      correspondence.attach(parsedFile([source('def:first'), source('def:second')]))
        .definitionNodeIds,
    ).toEqual([]);
  });

  it('does not resurrect declaration provenance when a competing graph ID is subsequently invalidated', () => {
    for (const reverse of [false, true]) {
      const correspondence = createDeclarationCorrespondence(filePath);
      const nodeIds = reverse ? ['graph:second', 'graph:first'] : ['graph:first', 'graph:second'];
      for (const nodeId of nodeIds)
        correspondence.observe(nodeId, 'save', 'Function', declaration());
      correspondence.observe('graph:second', 'save', 'Function', null);
      expect(correspondence.attach(parsedFile([source()])).definitionNodeIds).toEqual([]);
    }
  });

  it('refuses one DefId assigned to conflicting declaration provenance', () => {
    const correspondence = createDeclarationCorrespondence(filePath);
    const otherRange = { ...range, startLine: 4 };
    correspondence.observe('graph:first', 'save', 'Function', declaration());
    correspondence.observe('graph:second', 'save', 'Function', declaration('save', otherRange));
    expect(
      correspondence.attach(parsedFile([source(), source('def:save', 'save', otherRange)]))
        .definitionNodeIds,
    ).toEqual([]);
  });

  it('distinguishes unavailable declaration metadata from an available empty result', () => {
    const correspondence = createDeclarationCorrespondence(filePath);
    correspondence.observe('graph:save', 'save', 'Function', declaration());
    expect(correspondence.attach(parsedFile())).not.toHaveProperty('definitionNodeIds');
    expect(correspondence.attach(parsedFile([])).definitionNodeIds).toEqual([]);
    const stale = { ...parsedFile(), definitionNodeIds: [{ defId: 'old', nodeId: 'old' }] };
    expect(correspondence.attach(stale)).not.toHaveProperty('definitionNodeIds');
  });

  it.each([
    { ...range, startLine: 0 },
    { ...range, startCol: -1 },
    { ...range, endCol: NaN },
    { ...range, endLine: range.startLine - 1 },
    null,
  ])('refuses malformed source ranges without producing a correspondence: %j', (invalidRange) => {
    const correspondence = createDeclarationCorrespondence(filePath);
    correspondence.observe('graph:save', 'save', 'Function', declaration());
    const input = parsedFile([source()]);
    const malformed = {
      ...input,
      declarationSources: [{ ...source(), range: invalidRange }],
    } as unknown as ParsedFile;
    expect(correspondence.attach(malformed).definitionNodeIds).toEqual([]);
  });

  it.each(['missing', 'file', 'type'] as const)(
    'refuses source provenance with a %s local definition',
    (mismatch) => {
      const correspondence = createDeclarationCorrespondence(filePath);
      correspondence.observe('graph:save', 'save', 'Function', declaration());
      const input = parsedFile([source()]);
      const localDefs =
        mismatch === 'missing'
          ? []
          : [
              {
                nodeId: 'def:save',
                filePath: mismatch === 'file' ? 'other.ts' : filePath,
                type: mismatch === 'type' ? ('Class' as const) : ('Function' as const),
              },
            ];
      expect(correspondence.attach({ ...input, localDefs }).definitionNodeIds).toEqual([]);
    },
  );

  it('returns frozen correspondence records without modifying the input or retaining a mutable output array', () => {
    const correspondence = createDeclarationCorrespondence(filePath);
    const input = Object.freeze(parsedFile([source()]));
    correspondence.observe('graph:save', 'save', 'Function', declaration());
    const attached = correspondence.attach(input);
    expect(input).not.toHaveProperty('definitionNodeIds');
    expect(Object.isFrozen(attached)).toBe(true);
    expect(Object.isFrozen(attached.definitionNodeIds)).toBe(true);
    expect(Object.isFrozen(attached.definitionNodeIds![0])).toBe(true);
    expect(() => {
      (attached.definitionNodeIds![0] as { nodeId: string }).nodeId = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      (attached.definitionNodeIds as unknown[]).push({});
    }).toThrow(TypeError);
    correspondence.observe('graph:save', 'save', 'Function', null);
    expect(correspondence.attach(input).definitionNodeIds).toEqual([]);
    expect(attached.definitionNodeIds).toEqual([{ defId: 'def:save', nodeId: 'graph:save' }]);
  });

  it('preserves populated, empty, and absent correspondence through the scope record codec', () => {
    const correspondence = createDeclarationCorrespondence(filePath);
    correspondence.observe('graph:save', 'save', 'Function', declaration());
    const cases = [parsedFile(), parsedFile([]), parsedFile([source()])];
    for (const input of cases) {
      const attached = correspondence.attach(input);
      const replayed = decodeParsedFileRecord(encodeParsedFileRecord(attached));
      expect(replayed).toEqual(attached);
      expect(Object.hasOwn(replayed, 'definitionNodeIds')).toBe(
        Object.hasOwn(attached, 'definitionNodeIds'),
      );
      if (replayed.definitionNodeIds) {
        expect(Object.isFrozen(replayed)).toBe(true);
        expect(Object.isFrozen(replayed.definitionNodeIds)).toBe(true);
        for (const entry of replayed.definitionNodeIds) expect(Object.isFrozen(entry)).toBe(true);
      }
    }
  });

  describe('callable const bindings', () => {
    const rangeOf = (node: {
      startPosition: { row: number; column: number };
      endPosition: { row: number; column: number };
    }): Range => ({
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    });
    async function lexical(code: string) {
      const parser = await createParserForLanguage(SupportedLanguages.TypeScript, 'fixture.ts');
      const node = parser.parse(code).rootNode.namedChildren[0] as unknown as SyntaxNode;
      const declarator = node.namedChildren[0]!;
      return { node, declarator, value: declarator.childForFieldName('value')! };
    }

    it.each([
      ['const f = (x: number) => x;', 'value'],
      ['const f = function (x: number) { return x; };', 'value'],
      ['const f = function inner(x: number) { return x; };', 'declarator'],
    ] as const)('maps %s to its %s anchor', async (code, anchor) => {
      const { node, declarator, value } = await lexical(code);
      const at = rangeOf(anchor === 'value' ? value : declarator);
      const correspondence = createDeclarationCorrespondence(filePath);
      correspondence.observe('graph:f', 'f', 'Function', node);
      expect(
        correspondence.attach(parsedFile([source('def:f', 'f', at)])).definitionNodeIds,
      ).toEqual([{ defId: 'def:f', nodeId: 'graph:f' }]);
    });

    it.each(['let f = () => 1;', 'const f = 1;', 'const f = () => 1, g = () => 2;'])(
      'does not map %s',
      async (code) => {
        const { node, value } = await lexical(code);
        const correspondence = createDeclarationCorrespondence(filePath);
        correspondence.observe('graph:f', 'f', 'Function', node);
        expect(
          correspondence.attach(parsedFile([source('def:f', 'f', rangeOf(value))]))
            .definitionNodeIds,
        ).toEqual(code.endsWith('g = () => 2;') ? [{ defId: 'def:f', nodeId: 'graph:f' }] : []);
      },
    );
  });
});
