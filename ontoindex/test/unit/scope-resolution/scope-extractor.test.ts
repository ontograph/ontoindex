/**
 * Unit tests for `scope-extractor.extract` — the 5-pass driver
 * (RFC §5.3; Ring 2 PKG #919).
 *
 * Tests are organized by pass so a regression localizes to the pass it
 * broke. A `MockProvider` emits synthetic `CaptureMatch[]` with no real
 * AST; the extractor is pure given those captures.
 */

import { describe, it, expect } from 'vitest';
import { buildPositionIndex, buildScopeTree } from 'ontoindex-shared';
import type {
  Capture,
  CaptureMatch,
  ParsedImport,
  ParsedTypeBinding,
  ReferenceKind,
  Scope,
  ScopeKind,
} from 'ontoindex-shared';
import { extract, type ScopeExtractorHooks } from '../../../src/core/ingestion/scope-extractor.js';
import type { LocalBindingCandidate } from '../../../src/core/ingestion/language-provider.js';

describe('detached declaration metadata', () => {
  it('uses the declaration ID owner and preserves zero arity independently of capture order', () => {
    const owner = cap('@declaration.owner', 2, 0, 6, 1, 'Owner');
    const method = declMatch('method', 'zero', 3, 2, 3, 20, {
      '@declaration.owner': owner,
      '@declaration.parameter_count': cap('@declaration.parameter_count', 3, 2, 3, 20, '0'),
      '@declaration.required_parameter_count': cap(
        '@declaration.required_parameter_count',
        3,
        2,
        3,
        20,
        '0',
      ),
      '@declaration.return_type': cap('@declaration.return_type', 3, 10, 3, 14, 'void'),
    });
    const field = declMatch('property', 'value', 4, 2, 4, 15, {
      '@declaration.owner': owner,
      '@declaration.declared_type': cap('@declaration.declared_type', 4, 9, 4, 15, 'Value'),
    });
    const result = extract(
      [
        scopeMatch('module', 1, 0, 7, 0),
        scopeMatch('class', 2, 0, 6, 1),
        method,
        field,
        declMatch('class', 'Owner', 2, 0, 6, 1),
      ],
      'fixture.ts',
      {},
    );
    const ownerDef = result.localDefs.find((def) => def.type === 'Class')!;
    expect(result.localDefs[0]).toMatchObject({
      ownerId: ownerDef.nodeId,
      parameterCount: 0,
      requiredParameterCount: 0,
      returnType: 'void',
    });
    expect(result.localDefs[1]).toMatchObject({ ownerId: ownerDef.nodeId, declaredType: 'Value' });
  });

  it('refuses malformed counts and owner metadata', () => {
    for (const text of ['-1', '1.5', 'NaN', '9007199254740992']) {
      expect(() =>
        extract(
          [
            scopeMatch('module', 1, 0, 5, 0),
            declMatch('function', 'f', 2, 0, 3, 1, {
              '@declaration.parameter_count': cap('@declaration.parameter_count', 2, 0, 3, 1, text),
            }),
          ],
          'fixture.ts',
          {},
        ),
      ).toThrow(/arity metadata/);
    }
    expect(() =>
      extract(
        [
          scopeMatch('module', 1, 0, 5, 0),
          declMatch('method', 'f', 2, 0, 3, 1, {
            '@declaration.owner': cap('@declaration.owner', 4, 0, 4, 5, 'Other'),
          }),
        ],
        'fixture.ts',
        {},
      ),
    ).toThrow(/owner metadata/);
  });
});

// ─── Synthetic-capture helpers ──────────────────────────────────────────────

const cap = (
  name: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
  text = '',
): Capture => ({
  name,
  range: { startLine, startCol, endLine, endCol },
  text,
});

const scopeMatch = (
  kind: Lowercase<ScopeKind>,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): CaptureMatch => ({
  [`@scope.${kind}`]: cap(`@scope.${kind}`, startLine, startCol, endLine, endCol),
});

const declMatch = (
  kindStr: string,
  name: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
  extras: Record<string, Capture> = {},
): CaptureMatch => ({
  [`@declaration.${kindStr}`]: cap(`@declaration.${kindStr}`, startLine, startCol, endLine, endCol),
  '@declaration.name': cap('@declaration.name', startLine, startCol, endLine, endCol, name),
  ...extras,
});

const importMatch = (
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): CaptureMatch => ({
  '@import.statement': cap('@import.statement', startLine, startCol, endLine, endCol),
});

const typeBindingMatch = (
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): CaptureMatch => ({
  '@type-binding.parameter': cap('@type-binding.parameter', startLine, startCol, endLine, endCol),
});

const refMatch = (
  suffix: string,
  name: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
  extras: Record<string, Capture> = {},
): CaptureMatch => ({
  [`@reference.${suffix}`]: cap(`@reference.${suffix}`, startLine, startCol, endLine, endCol),
  '@reference.name': cap('@reference.name', startLine, startCol, endLine, endCol, name),
  ...extras,
});

// ─── MockProvider ───────────────────────────────────────────────────────────
describe('computed read metadata', () => {
  const computed = (): Record<string, Capture> => ({
    '@reference.read.computed': cap('@reference.read.computed', 3, 2, 3, 12),
    '@reference.object': cap('@reference.object', 3, 2, 3, 7),
    '@reference.index': cap('@reference.index', 3, 8, 3, 11),
  });
  const extractComputed = (match: CaptureMatch) =>
    extract(
      [scopeMatch('module', 1, 0, 8, 0), scopeMatch('block', 2, 0, 6, 0), match],
      'fixture.ts',
      {},
    );

  it('selects the expression scope, emits no name and detaches all ranges', () => {
    const match = computed();
    const result = extractComputed(match);
    const site = result.referenceSites[0]!;
    expect(result.referenceSites).toEqual([
      {
        kind: 'read',
        atRange: { startLine: 3, startCol: 2, endLine: 3, endCol: 12 },
        inScope: result.scopes.find((scope) => scope.kind === 'Block')!.id,
        selection: {
          kind: 'computed',
          objectRange: { startLine: 3, startCol: 2, endLine: 3, endCol: 7 },
          indexRange: { startLine: 3, startCol: 8, endLine: 3, endCol: 11 },
        },
      },
    ]);
    expect(Object.hasOwn(site, 'name')).toBe(false);
    expect(site.atRange).not.toBe(match['@reference.read.computed']!.range);
    expect(site.selection!.objectRange).not.toBe(match['@reference.object']!.range);
    expect(site.selection!.indexRange).not.toBe(match['@reference.index']!.range);
    const saved = JSON.stringify(site);
    for (const capture of Object.values(match)) Object.assign(capture.range, { startLine: 999 });
    expect(JSON.stringify(site)).toBe(saved);
  });

  it('accepts multiline containment and object/index subtags before the anchor', () => {
    const result = extractComputed({
      '@reference.index': cap('@reference.index', 4, 0, 4, 3),
      '@reference.object': cap('@reference.object', 3, 2, 3, 7),
      '@reference.read.computed': cap('@reference.read.computed', 3, 1, 5, 0),
    });
    expect(result.referenceSites).toHaveLength(1);
    expect(result.referenceSites[0]!.selection).toEqual({
      kind: 'computed',
      objectRange: { startLine: 3, startCol: 2, endLine: 3, endCol: 7 },
      indexRange: { startLine: 4, startCol: 0, endLine: 4, endCol: 3 },
    });
  });

  it('refuses missing, conflicting, mistagged and nonempty capture metadata', () => {
    for (const tag of ['@reference.read.computed', '@reference.object', '@reference.index']) {
      const missing = computed();
      delete missing[tag];
      expect(() => extractComputed(missing)).toThrow(/computed read metadata/);
      for (const change of [{ name: '@reference.read' }, { text: 'value' }]) {
        const match = computed();
        match[tag] = { ...match[tag]!, ...change };
        expect(() => extractComputed(match)).toThrow(/computed read metadata/);
      }
    }
    for (const tag of [
      '@reference.name',
      '@reference.receiver',
      '@reference.arity',
      '@reference.read',
      '@reference.call',
    ]) {
      expect(() =>
        extractComputed({ ...computed(), [tag]: cap(tag, 3, 2, 3, 7, 'value') }),
      ).toThrow(/computed read metadata/);
    }
    for (const tag of [
      '@scope.block',
      '@declaration.variable',
      '@import.named',
      '@type-binding.variable',
    ]) {
      const extra = { [tag]: cap(tag, 3, 2, 3, 7) };
      for (const match of [
        { ...extra, ...computed() },
        { ...computed(), ...extra },
      ]) {
        expect(() => extractComputed(match)).toThrow(/computed read metadata/);
      }
    }
  });

  it('refuses invalid coordinates, empty ranges, overlaps and missing bracket space', () => {
    for (const tag of ['@reference.read.computed', '@reference.object', '@reference.index']) {
      for (const coordinate of ['startLine', 'startCol', 'endLine', 'endCol']) {
        for (const value of [
          NaN,
          Infinity,
          -Infinity,
          1.5,
          Number.MAX_SAFE_INTEGER + 1,
          -1,
          -0,
          ...(coordinate.endsWith('Line') ? [0] : []),
        ]) {
          const match = computed();
          match[tag] = { ...match[tag]!, range: { ...match[tag]!.range, [coordinate]: value } };
          expect(() => extractComputed(match), `${tag}.${coordinate}=${value}`).toThrow(
            /computed read metadata/,
          );
        }
      }
    }
    for (const [tag, range] of [
      ['@reference.object', { startLine: 3, startCol: 1, endLine: 3, endCol: 7 }],
      ['@reference.object', { startLine: 3, startCol: 2, endLine: 3, endCol: 8 }],
      ['@reference.object', { startLine: 3, startCol: 2, endLine: 3, endCol: 9 }],
      ['@reference.object', { startLine: 3, startCol: 7, endLine: 3, endCol: 2 }],
      ['@reference.index', { startLine: 3, startCol: 8, endLine: 3, endCol: 8 }],
      ['@reference.index', { startLine: 3, startCol: 8, endLine: 3, endCol: 12 }],
      ['@reference.index', { startLine: 3, startCol: 8, endLine: 4, endCol: 0 }],
      ['@reference.read.computed', { startLine: 3, startCol: 12, endLine: 3, endCol: 12 }],
    ] as const) {
      const match = computed();
      match[tag] = { ...match[tag]!, range };
      expect(() => extractComputed(match)).toThrow(/computed read metadata/);
    }
  });
});

//
// The extractor declares its dependency on a narrow `ScopeExtractorHooks`
// surface — not the full `LanguageProvider`. Tests implement exactly that
// surface, so adding a new hook to `extract()` that's not in
// `ScopeExtractorHooks` is a compile error, not a silent test pass.

function mockProvider(hooks: Partial<ScopeExtractorHooks> = {}): ScopeExtractorHooks {
  return hooks;
}

// ─── §Pass 1: scope tree construction ──────────────────────────────────────

describe('Pass 1: scope tree', () => {
  for (const kind of ['function', 'class'] as const) {
    for (const end of [
      { line: 10, col: 5 },
      { line: 1, col: 0 },
    ]) {
      it(`retains a whole-file ${kind} under its Module ending at ${end.line}:${end.col}`, () => {
        const moduleMatch = scopeMatch('module', 1, 0, end.line, end.col);
        const childMatch = scopeMatch(kind, 1, 0, end.line, end.col);
        const range = { startLine: 1, startCol: 0, endLine: end.line, endCol: end.col };
        for (const matches of [
          [moduleMatch, childMatch],
          [childMatch, moduleMatch],
        ]) {
          const result = extract(matches, 'a.ts', mockProvider());
          const mod = result.scopes.find((scope) => scope.kind === 'Module')!;
          const child = result.scopes.find((scope) => scope.kind !== 'Module')!;
          expect(result.scopes).toHaveLength(2);
          expect(result.moduleScope).toBe(mod.id);
          expect(mod.parent).toBeNull();
          expect(child.parent).toBe(mod.id);
          expect(mod.range).toEqual(range);
          expect(child.range).toEqual(range);
          const tree = buildScopeTree(result.scopes);
          expect(tree.getParent(child.id)).toBe(mod);
          const index = buildPositionIndex(result.scopes);
          expect(index.atPosition('a.ts', 1, 0)).toBe(child.id);
          expect(index.atPosition('a.ts', end.line, end.col)).toBe(child.id);
        }
      });
    }
  }

  it('creates a single Module scope from one @scope.module match', () => {
    const result = extract([scopeMatch('module', 1, 0, 100, 0)], 'a.ts', mockProvider());
    expect(result.scopes).toHaveLength(1);
    expect(result.scopes[0]!.kind).toBe('Module');
    expect(result.scopes[0]!.parent).toBeNull();
    expect(result.moduleScope).toBe(result.scopes[0]!.id);
  });

  it('nests Class under Module when the class range is contained in the module range', () => {
    const result = extract(
      [scopeMatch('module', 1, 0, 100, 0), scopeMatch('class', 5, 0, 50, 0)],
      'a.ts',
      mockProvider(),
    );
    expect(result.scopes).toHaveLength(2);
    const cls = result.scopes.find((s) => s.kind === 'Class')!;
    const mod = result.scopes.find((s) => s.kind === 'Module')!;
    expect(cls.parent).toBe(mod.id);
  });

  it('nests Method under Class, Class under Module — deep nesting', () => {
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        scopeMatch('class', 5, 0, 50, 0),
        scopeMatch('function', 10, 2, 30, 2),
      ],
      'a.ts',
      mockProvider(),
    );
    const mod = result.scopes.find((s) => s.kind === 'Module')!;
    const cls = result.scopes.find((s) => s.kind === 'Class')!;
    const fn = result.scopes.find((s) => s.kind === 'Function')!;
    expect(cls.parent).toBe(mod.id);
    expect(fn.parent).toBe(cls.id);
  });

  it('places non-nested siblings at the same level under the module', () => {
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        scopeMatch('function', 10, 0, 20, 0),
        scopeMatch('function', 30, 0, 40, 0),
      ],
      'a.ts',
      mockProvider(),
    );
    const mod = result.scopes.find((s) => s.kind === 'Module')!;
    const fns = result.scopes.filter((s) => s.kind === 'Function');
    expect(fns).toHaveLength(2);
    for (const fn of fns) expect(fn.parent).toBe(mod.id);
  });

  it('honors `provider.shouldCreateScope === false` by reparenting children to next real scope', () => {
    // Block at [10:0..25:0] is SUPPRESSED; inner function at [12:0..20:0]
    // should reparent to the enclosing Module instead of the Block.
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        scopeMatch('block', 10, 0, 25, 0),
        scopeMatch('function', 12, 0, 20, 0),
      ],
      'a.ts',
      mockProvider({
        shouldCreateScope: (match) => match['@scope.block'] === undefined,
      }),
    );
    const mod = result.scopes.find((s) => s.kind === 'Module')!;
    const fn = result.scopes.find((s) => s.kind === 'Function')!;
    expect(result.scopes).toHaveLength(2); // block suppressed
    expect(fn.parent).toBe(mod.id);
  });

  it('uses `provider.resolveScopeKind` to override the default kind from the suffix', () => {
    // Provider upgrades a `@scope.block` to `Expression` for a comprehension-
    // style use case.
    const result = extract(
      [scopeMatch('module', 1, 0, 100, 0), scopeMatch('block', 10, 0, 15, 0)],
      'a.ts',
      mockProvider({
        resolveScopeKind: (match) => (match['@scope.block'] !== undefined ? 'Expression' : null),
      }),
    );
    expect(result.scopes.find((s) => s.kind === 'Expression')).toBeDefined();
  });

  it('throws ScopeTreeInvariantError when siblings overlap (provider bug)', () => {
    expect(() =>
      extract(
        [
          scopeMatch('module', 1, 0, 100, 0),
          scopeMatch('function', 10, 0, 20, 0),
          scopeMatch('function', 15, 0, 25, 0), // overlaps
        ],
        'a.ts',
        mockProvider(),
      ),
    ).toThrow(/overlap/i);
  });

  it('rejects equal-range non-Module scopes inside a larger Module', () => {
    expect(() =>
      extract(
        [
          scopeMatch('module', 1, 0, 100, 0),
          scopeMatch('class', 5, 0, 20, 0),
          scopeMatch('function', 5, 0, 20, 0),
        ],
        'a.ts',
        mockProvider(),
      ),
    ).toThrow(/overlap/i);
  });

  it('rejects multiple children sharing the whole Module range', () => {
    expect(() =>
      extract(
        [
          scopeMatch('module', 1, 0, 10, 0),
          scopeMatch('class', 1, 0, 10, 0),
          scopeMatch('function', 1, 0, 10, 0),
        ],
        'a.ts',
        mockProvider(),
      ),
    ).toThrow(/overlap/i);
  });

  it('throws when no Module scope is present', () => {
    expect(() => extract([scopeMatch('function', 1, 0, 10, 0)], 'a.ts', mockProvider())).toThrow(
      /Module/,
    );
  });
});

// ─── §Pass 2: declarations + local bindings ────────────────────────────────

describe('declaration sources', () => {
  it('retains same-line and nested anchors in localDefs order with exact declaration names', () => {
    const declarations = [
      declMatch('method', 'same', 2, 20, 2, 30),
      declMatch('class', 'Outer', 2, 0, 5, 1),
      declMatch('method', 'same', 2, 5, 2, 15),
      declMatch('function', 'inner:with#punctuation', 3, 2, 4, 3, {
        '@declaration.qualified_name': cap(
          '@declaration.qualified_name',
          3,
          2,
          4,
          3,
          'Outer.alias',
        ),
      }),
    ];
    const result = extract(
      [
        scopeMatch('module', 1, 0, 6, 0),
        scopeMatch('class', 2, 0, 5, 1),
        scopeMatch('function', 3, 2, 4, 3),
        ...declarations,
      ],
      'source.ts',
      mockProvider(),
    );

    expect(result.declarationSources).toEqual(
      declarations.map((match, index) => {
        const anchor = Object.values(match)[0]!;
        return {
          defId: result.localDefs[index]!.nodeId,
          range: anchor.range,
          name: match['@declaration.name']!.text,
          type: result.localDefs[index]!.type,
        };
      }),
    );
    expect(result.declarationSources![0]!.defId).not.toBe(result.declarationSources![2]!.defId);
  });

  it('uses kind-specific and anchor names without deriving them from qualified names', () => {
    const specific = {
      '@declaration.function': cap('@declaration.function', 2, 0, 2, 10, 'anchor'),
      '@declaration.function.name': cap('@declaration.function.name', 2, 2, 2, 8, 'specific'),
      '@declaration.qualified_name': cap('@declaration.qualified_name', 2, 0, 2, 10, 'Other.alias'),
    };
    const fallback = {
      '@declaration.variable': cap('@declaration.variable', 3, 0, 3, 10, 'raw:name'),
    };
    const result = extract(
      [scopeMatch('module', 1, 0, 4, 0), specific, fallback],
      'source.ts',
      mockProvider(),
    );
    expect(result.declarationSources!.map(({ name }) => name)).toEqual(['specific', 'raw:name']);
  });

  it('clones anchors before provider hooks and freezes the array, records and ranges', () => {
    const declaration = declMatch('function', 'original', 2, 1, 3, 4);
    const anchor = declaration['@declaration.function']!;
    const result = extract(
      [scopeMatch('module', 1, 0, 5, 0), declaration],
      'source.ts',
      mockProvider({
        bindingScopeFor: () => {
          Object.assign(anchor.range, { startLine: 4, startCol: 9 });
          Object.assign(declaration['@declaration.name']!, { text: 'changed' });
          return null;
        },
      }),
    );
    const source = result.declarationSources![0]!;
    expect(source).toEqual({
      defId: result.localDefs[0]!.nodeId,
      range: { startLine: 2, startCol: 1, endLine: 3, endCol: 4 },
      name: 'original',
      type: 'Function',
    });
    expect(source.range).not.toBe(anchor.range);
    expect(Object.isFrozen(anchor.range)).toBe(false);
    expect(Object.isFrozen(result.declarationSources)).toBe(true);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.range)).toBe(true);
    expect(Reflect.set(source.range, 'startLine', 99)).toBe(false);
    expect(Reflect.set(source, 'name', 'mutated')).toBe(false);
    expect(Reflect.set(result.declarationSources!, '0', {})).toBe(false);
  });

  it('emits an empty frozen array when no declarations are accepted', () => {
    for (const declarations of [
      [],
      [declMatch('unknown', 'ignored', 2, 0, 2, 5), declMatch('function', 'outside', 8, 0, 8, 5)],
    ]) {
      const result = extract(
        [scopeMatch('module', 1, 0, 4, 0), ...declarations],
        'source.ts',
        mockProvider(),
      );
      expect(result.localDefs).toEqual([]);
      expect(result.declarationSources).toEqual([]);
      expect(Object.isFrozen(result.declarationSources)).toBe(true);
    }
  });
});

describe('exact scope declaration ownership', () => {
  it.each(['function', 'class'] as const)(
    'uses the full %s declaration range rather than its shared start',
    (kind) => {
      const result = extract(
        [
          scopeMatch('module', 1, 0, 30, 0),
          scopeMatch(kind, 2, 1, 20, 3),
          declMatch(kind, 'shorter', 2, 1, 15, 3),
          declMatch(kind, 'differentColumn', 2, 1, 20, 2),
          declMatch(kind, 'exact', 2, 1, 20, 3),
        ],
        'owner.ts',
        mockProvider(),
      );
      const owner = result.localDefs[2]!;
      const ownedScope = result.scopes.find((scope) => scope.kind !== 'Module')!;
      expect(ownedScope.ownerDefId).toBe(owner.nodeId);
      expect(result.scopes.find((scope) => scope.kind === 'Module')!.ownerDefId).toBeNull();
    },
  );

  it('leaves an anonymous Function owner null despite a nested Function declaration', () => {
    const result = extract(
      [
        scopeMatch('module', 1, 0, 30, 0),
        scopeMatch('function', 2, 0, 20, 0),
        declMatch('function', 'nested', 5, 2, 10, 3),
      ],
      'owner.ts',
      mockProvider(),
    );
    const anonymous = result.scopes.find((scope) => scope.kind === 'Function')!;
    expect(anonymous.ownedDefs.map((def) => def.nodeId)).toEqual([result.localDefs[0]!.nodeId]);
    expect(anonymous.ownerDefId).toBeNull();
  });

  it.each(['function', 'class'] as const)(
    'leaves conflicting same-range %s owners null in either declaration order',
    (kind) => {
      const declarations = [
        declMatch(kind, 'first', 2, 1, 20, 3),
        declMatch(kind, 'second', 2, 1, 20, 3),
      ];
      for (const ordered of [declarations, [...declarations].reverse()]) {
        const result = extract(
          [scopeMatch('module', 1, 0, 30, 0), scopeMatch(kind, 2, 1, 20, 3), ...ordered],
          'owner.ts',
          mockProvider(),
        );
        expect(result.localDefs).toHaveLength(2);
        expect(result.scopes.find((scope) => scope.kind !== 'Module')!.ownerDefId).toBeNull();
      }
    },
  );

  it('does not assign a callable declaration as a Block owner even at the exact range', () => {
    const result = extract(
      [
        scopeMatch('module', 1, 0, 30, 0),
        scopeMatch('block', 2, 1, 20, 3),
        declMatch('function', 'nested', 2, 1, 20, 3),
      ],
      'owner.ts',
      mockProvider(),
    );
    const block = result.scopes.find((scope) => scope.kind === 'Block')!;
    expect(block.ownedDefs.map((def) => def.nodeId)).toEqual([result.localDefs[0]!.nodeId]);
    expect(block.ownerDefId).toBeNull();
    expect(result.scopes.every((scope) => Object.hasOwn(scope, 'ownerDefId'))).toBe(true);
  });
});

describe('Pass 2: declarations + local bindings', () => {
  for (const hook of [undefined, () => null]) {
    it(`preserves all same-name bindings when selection is ${hook === undefined ? 'absent' : 'null'}`, () => {
      const result = extract(
        [
          scopeMatch('module', 1, 0, 100, 0),
          declMatch('variable', 'x', 5, 0, 5, 1),
          declMatch('variable', 'x', 10, 0, 10, 1),
        ],
        'a.ts',
        mockProvider(hook === undefined ? {} : { selectLocalBindings: hook }),
      );
      expect(result.scopes[0]!.bindings.get('x')).toEqual(
        result.localDefs.map((def) => ({ def, origin: 'local' })),
      );
      expect(result.scopes[0]!.ownedDefs).toEqual(result.localDefs);
    });
  }

  it('selects complete candidate groups by host and name while preserving structural ownership', () => {
    const first = declMatch('variable', 'x', 15, 0, 15, 1);
    const second = declMatch('variable', 'x', 35, 0, 35, 1);
    const otherName = declMatch('variable', 'y', 40, 0, 40, 1);
    const moduleDecl = declMatch('variable', 'x', 80, 0, 80, 1);
    const groups: (readonly LocalBindingCandidate[])[] = [];
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        scopeMatch('function', 10, 0, 50, 0),
        scopeMatch('block', 12, 0, 20, 0),
        first,
        second,
        otherName,
        moduleDecl,
      ],
      'a.ts',
      mockProvider({
        bindingScopeFor: (_match, innermost, tree) =>
          innermost.kind === 'Block' ? tree.getParent(innermost.id)!.id : null,
        selectLocalBindings: (candidates, host, tree) => {
          groups.push(candidates);
          expect(host).toBe(tree.getScope(host.id));
          expect(host.bindings.size).toBe(0);
          expect(host.ownedDefs).toEqual([]);
          expect(host.typeBindings.size).toBe(0);
          return [candidates[candidates.length - 1]!];
        },
      }),
    );
    expect(groups.map((group) => group.map(({ match }) => match))).toEqual([
      [first, second],
      [otherName],
      [moduleDecl],
    ]);
    const fn = result.scopes.find((scope) => scope.kind === 'Function')!;
    const block = result.scopes.find((scope) => scope.kind === 'Block')!;
    const mod = result.scopes.find((scope) => scope.kind === 'Module')!;
    expect(result.localDefs).toHaveLength(4);
    expect(block.ownedDefs).toEqual([result.localDefs[0]]);
    expect(fn.ownedDefs).toEqual([result.localDefs[1], result.localDefs[2]]);
    expect(mod.ownedDefs).toEqual([result.localDefs[3]]);
    expect(fn.bindings.get('x')).toEqual([{ def: result.localDefs[1], origin: 'local' }]);
    expect(fn.bindings.get('y')).toEqual([{ def: result.localDefs[2], origin: 'local' }]);
    expect(mod.bindings.get('x')).toEqual([{ def: result.localDefs[3], origin: 'local' }]);
    expect(block.bindings.size).toBe(0);
  });

  for (const [label, selection] of [
    ['empty', () => []],
    ['non-array', () => ({})],
    ['undefined', () => undefined],
    ['copied candidate', (candidates: readonly LocalBindingCandidate[]) => [{ ...candidates[0]! }]],
    ['duplicate', (candidates: readonly LocalBindingCandidate[]) => [candidates[0], candidates[0]]],
  ] as const) {
    it(`rejects a ${label} local binding selection`, () => {
      expect(() =>
        extract(
          [scopeMatch('module', 1, 0, 100, 0), declMatch('variable', 'x', 5, 0, 5, 1)],
          'a.ts',
          mockProvider({
            selectLocalBindings: selection as NonNullable<
              ScopeExtractorHooks['selectLocalBindings']
            >,
          }),
        ),
      ).toThrow(/ScopeExtractor: selectLocalBindings/);
    });
  }

  it('attaches a Class declaration to its enclosing Module scope', () => {
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        scopeMatch('class', 5, 0, 50, 0),
        declMatch('class', 'User', 5, 6, 5, 10),
      ],
      'a.ts',
      mockProvider(),
    );
    // The declaration sits at line 5 → innermost scope is Class (at 5:0..50:0).
    const cls = result.scopes.find((s) => s.kind === 'Class')!;
    expect(cls.ownedDefs).toHaveLength(1);
    expect(cls.ownedDefs[0]!.type).toBe('Class');
    expect(cls.ownedDefs[0]!.qualifiedName).toBe('User');
    expect(cls.bindings.get('User')).toBeDefined();
    expect(cls.bindings.get('User')![0]!.origin).toBe('local');
  });

  it('records the declaration in `localDefs` as well', () => {
    const result = extract(
      [scopeMatch('module', 1, 0, 100, 0), declMatch('function', 'render', 5, 0, 5, 6)],
      'a.ts',
      mockProvider(),
    );
    expect(result.localDefs).toHaveLength(1);
    expect(result.localDefs[0]!.type).toBe('Function');
  });

  it('honors `provider.bindingScopeFor` to hoist a binding to an outer scope', () => {
    // Treat every declaration as hoisted to the module scope.
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        scopeMatch('function', 10, 0, 30, 0),
        declMatch('variable', 'x', 15, 4, 15, 5),
      ],
      'a.ts',
      mockProvider({
        bindingScopeFor: (_match, _innermost, scopeTree) => {
          for (const s of scopeTree.byId.values()) if (s.kind === 'Module') return s.id;
          return null;
        },
      }),
    );
    const mod = result.scopes.find((s) => s.kind === 'Module')!;
    const fn = result.scopes.find((s) => s.kind === 'Function')!;
    // Binding hoisted to module; function scope's bindings empty for 'x'.
    expect(mod.bindings.get('x')).toBeDefined();
    expect(fn.bindings.get('x')).toBeUndefined();
    // `ownedDefs` stays structural (innermost = function).
    expect(fn.ownedDefs).toHaveLength(1);
  });

  it('ignores declarations with unknown kind suffixes', () => {
    const result = extract(
      [scopeMatch('module', 1, 0, 100, 0), declMatch('mystery', 'x', 5, 0, 5, 1)],
      'a.ts',
      mockProvider(),
    );
    expect(result.localDefs).toHaveLength(0);
  });
});

// ─── §Pass 3: imports ──────────────────────────────────────────────────────

describe('Pass 3: raw imports', () => {
  it('collects imports via `provider.interpretImport`', () => {
    const named: ParsedImport = {
      kind: 'named',
      localName: 'User',
      importedName: 'User',
      targetRaw: './models',
    };
    const result = extract(
      [scopeMatch('module', 1, 0, 100, 0), importMatch(3, 0, 3, 30)],
      'a.ts',
      mockProvider({
        interpretImport: () => named,
      }),
    );
    expect(result.parsedImports).toEqual([named]);
  });

  it('drops imports when `interpretImport` returns null', () => {
    const result = extract(
      [scopeMatch('module', 1, 0, 100, 0), importMatch(3, 0, 3, 30)],
      'a.ts',
      mockProvider({
        interpretImport: () => null,
      }),
    );
    expect(result.parsedImports).toEqual([]);
  });

  it('emits no imports when the provider does not implement `interpretImport`', () => {
    const result = extract(
      [scopeMatch('module', 1, 0, 100, 0), importMatch(3, 0, 3, 30)],
      'a.ts',
      mockProvider(),
    );
    expect(result.parsedImports).toEqual([]);
  });
});

// ─── §Pass 4: type bindings ───────────────────────────────────────────────

describe('Pass 4: type bindings', () => {
  it('attaches a parameter-annotation TypeRef to the innermost scope', () => {
    const parsed: ParsedTypeBinding = {
      boundName: 'user',
      rawTypeName: 'User',
      source: 'parameter-annotation',
    };
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        scopeMatch('function', 5, 0, 20, 0),
        typeBindingMatch(6, 4, 6, 14),
      ],
      'a.ts',
      mockProvider({
        interpretTypeBinding: () => parsed,
      }),
    );
    const fn = result.scopes.find((s) => s.kind === 'Function')!;
    const tb = fn.typeBindings.get('user');
    expect(tb).toBeDefined();
    expect(tb!.rawName).toBe('User');
    expect(tb!.source).toBe('parameter-annotation');
    expect(tb!.declaredAtScope).toBe(fn.id);
  });

  it('skips type-binding matches when the provider returns null', () => {
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        scopeMatch('function', 5, 0, 20, 0),
        typeBindingMatch(6, 4, 6, 14),
      ],
      'a.ts',
      mockProvider({
        interpretTypeBinding: () => null,
      }),
    );
    const fn = result.scopes.find((s) => s.kind === 'Function')!;
    expect(fn.typeBindings.size).toBe(0);
  });
});

// ─── §Pass 5: reference sites ─────────────────────────────────────────────

describe('Pass 5: reference sites', () => {
  it('emits a call reference with the innermost scope anchor', () => {
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        scopeMatch('function', 5, 0, 20, 0),
        refMatch('call.free', 'print', 10, 4, 10, 9),
      ],
      'a.ts',
      mockProvider(),
    );
    const fn = result.scopes.find((s) => s.kind === 'Function')!;
    expect(result.referenceSites).toHaveLength(1);
    expect(result.referenceSites[0]!.name).toBe('print');
    expect(result.referenceSites[0]!.kind).toBe('call');
    expect(result.referenceSites[0]!.callForm).toBe('free');
    expect(result.referenceSites[0]!.inScope).toBe(fn.id);
  });

  it('classifies member calls via the `@reference.call.member` sub-tag', () => {
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        refMatch('call.member', 'save', 3, 4, 3, 8, {
          '@reference.receiver': cap('@reference.receiver', 3, 0, 3, 4, 'user'),
        }),
      ],
      'a.ts',
      mockProvider(),
    );
    expect(result.referenceSites[0]!.callForm).toBe('member');
    expect(result.referenceSites[0]!.explicitReceiver).toEqual({ name: 'user' });
  });

  it('falls back to `provider.classifyCallForm` when the anchor has no sub-tag', () => {
    const result = extract(
      [scopeMatch('module', 1, 0, 100, 0), refMatch('call', 'foo', 3, 0, 3, 3)],
      'a.ts',
      mockProvider({
        classifyCallForm: () => 'member',
      }),
    );
    expect(result.referenceSites[0]!.callForm).toBe('member');
  });

  it('recognizes all reference kinds (call, read, write, inherits, type, import_use)', () => {
    const kindsToEmit: Array<[string, ReferenceKind]> = [
      ['call.free', 'call'],
      ['read', 'read'],
      ['write', 'write'],
      ['inherits', 'inherits'],
      ['type', 'type-reference'],
      ['import_use', 'import-use'],
    ];
    const matches = [
      scopeMatch('module', 1, 0, 100, 0),
      ...kindsToEmit.map(([suffix], i) => refMatch(suffix, `ref${i}`, 10 + i, 0, 10 + i, 5)),
    ];
    const result = extract(matches, 'a.ts', mockProvider());
    expect(result.referenceSites.map((s) => s.kind)).toEqual(kindsToEmit.map(([, kind]) => kind));
  });

  it('picks the call anchor over a wider-ranged @reference.receiver (regression for KNOWN_SUB_TAGS exclusion)', () => {
    // Regression for the bug fixed before commit: a member call like
    // `user.save()` where the receiver capture (`user`) spans MORE source
    // than the call anchor (`save`). The broadest-range anchor heuristic
    // would have picked the receiver — `anchorCaptureFor` must exclude
    // known sub-tags (`@reference.receiver`, `@reference.name`, etc.) to
    // route the match as a `call` reference.
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        {
          // Receiver spans columns 0-10 (wider).
          '@reference.receiver': cap('@reference.receiver', 3, 0, 3, 10, 'longUserName'),
          // Call name spans columns 11-15 (narrower).
          '@reference.name': cap('@reference.name', 3, 11, 3, 15, 'save'),
          // The anchor — call.member — spans 0-17 (full expression). In the
          // buggy behavior the receiver would have tied-or-won. Even here,
          // the fix guarantees we pick the call anchor, never the sub-tag.
          '@reference.call.member': cap('@reference.call.member', 3, 0, 3, 17),
        },
      ],
      'a.ts',
      mockProvider(),
    );
    expect(result.referenceSites).toHaveLength(1);
    expect(result.referenceSites[0]!.name).toBe('save'); // NOT 'longUserName'
    expect(result.referenceSites[0]!.kind).toBe('call');
    expect(result.referenceSites[0]!.callForm).toBe('member');
    expect(result.referenceSites[0]!.explicitReceiver).toEqual({ name: 'longUserName' });
  });

  it('parses arity from @reference.arity when present', () => {
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        refMatch('call.free', 'foo', 3, 0, 3, 3, {
          '@reference.arity': cap('@reference.arity', 3, 0, 3, 0, '2'),
        }),
      ],
      'a.ts',
      mockProvider(),
    );
    expect(result.referenceSites[0]!.arity).toBe(2);
  });
});

// ─── §End-to-end fixture ──────────────────────────────────────────────────

describe('explicit exports after extraction', () => {
  it('classifies each local definition once and derives detached namespace exports by ID', () => {
    const calls: string[] = [];
    const providerExports = new Map<string, string>();
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        declMatch('variable', 'TypeOnly', 2, 0, 2, 8),
        declMatch('variable', 'ValueOnly', 3, 0, 3, 9),
        declMatch('class', 'Both', 4, 0, 4, 4),
      ],
      'a.ts',
      mockProvider({
        declarationNamespaceFor: ({ def }) => {
          calls.push(def.nodeId);
          return def.qualifiedName === 'TypeOnly'
            ? 'type'
            : def.qualifiedName === 'ValueOnly'
              ? 'value'
              : 'both';
        },
        interpretExports: (_matches, context) => {
          for (const def of context.localDefs)
            providerExports.set(`alias${def.qualifiedName}`, def.nodeId);
          return providerExports;
        },
      }),
    );
    const [type, value, both] = result.localDefs;
    expect(calls).toEqual(result.localDefs.map((def) => def.nodeId));
    expect([...result.scopes[0]!.bindings.values()].map((refs) => refs[0]!.namespace)).toEqual([
      'type',
      'value',
      'both',
    ]);
    expect(result.exportsByNamespace).toEqual({
      type: new Map([
        ['aliasTypeOnly', type!.nodeId],
        ['aliasBoth', both!.nodeId],
      ]),
      value: new Map([
        ['aliasValueOnly', value!.nodeId],
        ['aliasBoth', both!.nodeId],
      ]),
    });
    expect(result.exports).toEqual(providerExports);
    providerExports.clear();
    expect(result.exports).toHaveProperty('size', 3);
    expect(result.exportsByNamespace!.type.size).toBe(2);
    expect(result.exportsByNamespace!.value.size).toBe(2);
    expect(result.exportsByNamespace!.type).not.toBe(result.exportsByNamespace!.value);
    expect(result.exportsByNamespace!.type).not.toBe(result.exports);
  });

  it('retains the exact legacy shape without a namespace hook', () => {
    const matches = [
      scopeMatch('module', 1, 0, 100, 0),
      declMatch('variable', 'value', 2, 0, 2, 5),
    ];
    const legacy = extract(
      matches,
      'a.ts',
      mockProvider({
        interpretExports: (_matches, context) => new Map([['value', context.localDefs[0]!.nodeId]]),
      }),
    );
    const unclassified = extract(
      matches,
      'a.ts',
      mockProvider({
        declarationNamespaceFor: () => undefined,
      }),
    );
    const unclassifiedExport = extract(
      matches,
      'a.ts',
      mockProvider({
        declarationNamespaceFor: () => undefined,
        interpretExports: (_matches, context) => new Map([['value', context.localDefs[0]!.nodeId]]),
      }),
    );
    expect(legacy).not.toHaveProperty('exportsByNamespace');
    expect(legacy.scopes[0]!.bindings.get('value')![0]).toEqual({
      def: legacy.localDefs[0],
      origin: 'local',
    });
    expect(unclassified.scopes[0]!.bindings).toEqual(legacy.scopes[0]!.bindings);
    expect(unclassified).not.toHaveProperty('exportsByNamespace');
    expect(unclassifiedExport.exportsByNamespace).toEqual({
      type: legacy.exports,
      value: legacy.exports,
    });
  });

  it('classifies exported definitions even when binding selection discards them', () => {
    const result = extract(
      [
        scopeMatch('module', 1, 0, 100, 0),
        declMatch('variable', 'same', 2, 0, 2, 5),
        declMatch('variable', 'same', 3, 0, 3, 5),
      ],
      'a.ts',
      mockProvider({
        selectLocalBindings: (candidates) => [candidates[1]!],
        declarationNamespaceFor: ({ match }) =>
          match['@declaration.variable']!.range.startLine === 2 ? 'type' : 'value',
        interpretExports: (_matches, context) => new Map([['alias', context.localDefs[0]!.nodeId]]),
      }),
    );
    expect(result.scopes[0]!.bindings.get('same')![0]!.namespace).toBe('value');
    expect(result.exportsByNamespace).toEqual({
      type: new Map([['alias', result.localDefs[0]!.nodeId]]),
      value: new Map(),
    });
  });

  it.each([null, '', 'namespace', 0, {}, []])(
    'rejects invalid namespace classification %j',
    (invalid) => {
      const declarationNamespaceFor = (() => invalid) as NonNullable<
        ScopeExtractorHooks['declarationNamespaceFor']
      >;
      expect(() =>
        extract(
          [scopeMatch('module', 1, 0, 100, 0), declMatch('variable', 'value', 2, 0, 2, 5)],
          'a.ts',
          mockProvider({ declarationNamespaceFor }),
        ),
      ).toThrow(/declarationNamespaceFor/);
    },
  );

  it('omits exports without a hook and preserves an explicitly empty export map', () => {
    const matches = [scopeMatch('module', 1, 0, 100, 0)];
    const legacy = extract(matches, 'a.ts', mockProvider());
    const explicit = extract(matches, 'a.ts', mockProvider({ interpretExports: () => new Map() }));
    const namespaced = extract(
      matches,
      'a.ts',
      mockProvider({
        interpretExports: () => new Map(),
        declarationNamespaceFor: () => 'value',
      }),
    );

    expect(legacy).not.toHaveProperty('exports');
    expect(explicit).toHaveProperty('exports', new Map());
    expect(explicit).not.toHaveProperty('exportsByNamespace');
    expect(namespaced.exportsByNamespace).toEqual({ type: new Map(), value: new Map() });
  });

  it('receives original matches and completed context after all five passes', () => {
    const matches = [
      scopeMatch('module', 1, 0, 100, 0),
      declMatch('variable', 'value', 2, 0, 2, 5),
      importMatch(3, 0, 3, 20),
      typeBindingMatch(4, 0, 4, 10),
      refMatch('call', 'value', 5, 0, 5, 5),
    ];
    const calls: string[] = [];
    let seenContext: Parameters<NonNullable<ScopeExtractorHooks['interpretExports']>>[1];
    const result = extract(
      matches,
      'a.ts',
      mockProvider({
        interpretImport: () => {
          calls.push('imports');
          return { kind: 'named', localName: 'T', importedName: 'T', targetRaw: './types' };
        },
        interpretTypeBinding: () => {
          calls.push('types');
          return { boundName: 'value', rawTypeName: 'T', source: 'parameter-annotation' };
        },
        classifyCallForm: () => {
          calls.push('references');
          return 'free';
        },
        interpretExports: (captures, context) => {
          calls.push('exports');
          expect(captures).toBe(matches);
          expect(context.filePath).toBe('a.ts');
          const module = context.scopes.find((scope) => scope.id === context.moduleScope)!;
          expect(module.bindings.get('value')?.[0]?.def).toBe(context.localDefs[0]);
          expect(module.ownedDefs).toEqual(context.localDefs);
          expect(module.typeBindings.get('value')?.rawName).toBe('T');
          seenContext = context;
          return new Map([['value', context.localDefs[0]!.nodeId]]);
        },
      }),
    );

    expect(calls).toEqual(['imports', 'types', 'references', 'exports']);
    expect(seenContext!).toMatchObject({
      filePath: result.filePath,
      moduleScope: result.moduleScope,
      scopes: result.scopes,
      localDefs: result.localDefs,
    });
    expect(result.parsedImports).toHaveLength(1);
    expect(result.referenceSites).toHaveLength(1);
  });

  it('exports aliases of the module binding without changing identities or private definitions', () => {
    const matches = [
      scopeMatch('module', 1, 0, 100, 0),
      scopeMatch('function', 10, 0, 30, 0),
      declMatch('variable', 'value', 12, 0, 12, 5),
      declMatch('variable', 'value', 2, 0, 2, 5),
      declMatch('variable', 'privateValue', 4, 0, 4, 12),
    ];
    const baseline = extract(matches, 'a.ts', mockProvider());
    const providerExports = new Map<string, string>();
    const result = extract(
      matches,
      'a.ts',
      mockProvider({
        interpretExports: (_captures, context) => {
          const module = context.scopes.find((scope) => scope.id === context.moduleScope)!;
          const id = module.bindings.get('value')![0]!.def.nodeId;
          for (const name of ['renamed', 'default', '']) providerExports.set(name, id);
          return providerExports;
        },
      }),
    );
    const moduleId = baseline.scopes
      .find((scope) => scope.id === baseline.moduleScope)!
      .bindings.get('value')![0]!.def.nodeId;
    expect(moduleId).not.toBe(baseline.localDefs[0]!.nodeId);
    expect(result.exports).toEqual(
      new Map([
        ['renamed', moduleId],
        ['default', moduleId],
        ['', moduleId],
      ]),
    );
    expect(result.localDefs).toEqual(baseline.localDefs);
    expect(result.scopes).toEqual(baseline.scopes);
    expect(result.exports).not.toBe(providerExports);

    providerExports.clear();
    providerExports.set('later', moduleId);
    expect([...result.exports!]).toEqual([
      ['renamed', moduleId],
      ['default', moduleId],
      ['', moduleId],
    ]);
  });

  it.each([
    ['unknown local ID', () => new Map([['value', 'foreign-definition']])],
    ['nonstring name', (id: string) => new Map([[42, id]])],
    ['nonstring ID', () => new Map([['value', 42]])],
    ['plain object', (id: string) => ({ value: id })],
    ['entry array', (id: string) => [['value', id]]],
    ['undefined', () => undefined],
    ['null', () => null],
  ])('rejects %s returned by an implemented hook', (_name, invalid) => {
    const interpretExports = ((_captures, context) =>
      invalid(context.localDefs[0]!.nodeId)) as NonNullable<
      ScopeExtractorHooks['interpretExports']
    >;

    expect(() =>
      extract(
        [scopeMatch('module', 1, 0, 100, 0), declMatch('variable', 'value', 2, 0, 2, 5)],
        'a.ts',
        mockProvider({ interpretExports }),
      ),
    ).toThrow();
  });
});

describe('end-to-end fixture (all 5 passes together)', () => {
  it('produces a well-formed ParsedFile from a representative multi-pass input', () => {
    const matches: CaptureMatch[] = [
      // Pass 1: nested scopes
      scopeMatch('module', 1, 0, 100, 0),
      scopeMatch('class', 5, 0, 50, 0),
      scopeMatch('function', 10, 2, 40, 2),
      // Pass 2: declarations
      declMatch('class', 'User', 5, 6, 5, 10),
      declMatch('method', 'save', 10, 2, 10, 6),
      declMatch('field', 'count', 7, 2, 7, 7),
      // Pass 3: import
      importMatch(3, 0, 3, 30),
      // Pass 4: type binding
      typeBindingMatch(10, 14, 10, 18),
      // Pass 5: references
      refMatch('call.member', 'log', 20, 4, 20, 7, {
        '@reference.receiver': cap('@reference.receiver', 20, 0, 20, 4, 'self'),
      }),
      refMatch('read', 'count', 25, 4, 25, 9),
    ];

    const parsedImport: ParsedImport = {
      kind: 'named',
      localName: 'Logger',
      importedName: 'Logger',
      targetRaw: './logger',
    };
    const parsedTypeBinding: ParsedTypeBinding = {
      boundName: 'name',
      rawTypeName: 'string',
      source: 'parameter-annotation',
    };

    const result = extract(
      matches,
      'user.ts',
      mockProvider({
        interpretImport: () => parsedImport,
        interpretTypeBinding: () => parsedTypeBinding,
      }),
    );

    // Three scopes, properly nested.
    expect(result.scopes).toHaveLength(3);
    const kinds = result.scopes.map((s: Scope) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(['Module', 'Class', 'Function']));

    // Declarations landed on the correct scopes.
    const cls = result.scopes.find((s) => s.kind === 'Class')!;
    const fn = result.scopes.find((s) => s.kind === 'Function')!;
    expect(cls.ownedDefs.map((d) => d.qualifiedName).sort()).toEqual(['User', 'count'].sort());
    expect(fn.ownedDefs.map((d) => d.qualifiedName)).toEqual(['save']);

    // Local bindings present.
    expect(cls.bindings.get('User')).toBeDefined();
    expect(cls.bindings.get('count')).toBeDefined();
    expect(fn.bindings.get('save')).toBeDefined();

    // Import collected.
    expect(result.parsedImports).toEqual([parsedImport]);

    // Type binding attached to function scope.
    expect(fn.typeBindings.get('name')?.rawName).toBe('string');

    // References emitted.
    expect(result.referenceSites).toHaveLength(2);
    expect(result.referenceSites.map((r) => r.kind)).toEqual(['call', 'read']);

    // `localDefs` is the union across scopes.
    expect(result.localDefs).toHaveLength(3);
    expect(result.localDefs.map((d) => d.type).sort()).toEqual(
      ['Class', 'Method', 'Property'].sort(),
    );

    // Module scope id matches the ParsedFile header.
    const mod = result.scopes.find((s) => s.kind === 'Module')!;
    expect(result.moduleScope).toBe(mod.id);
  });
});
