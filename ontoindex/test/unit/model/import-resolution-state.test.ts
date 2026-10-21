import { describe, expect, it } from 'vitest';
import {
  createResolutionContext,
  restoreImportResolutionState,
  snapshotImportResolutionState,
} from '../../../src/core/ingestion/model/resolution-context.js';

function populatedContext() {
  const ctx = createResolutionContext();
  ctx.importMap.set('src/z.ts', new Set(['src/barrel.ts', 'src/a.ts']));
  ctx.importMap.set('src/empty.ts', new Set());
  ctx.packageMap.set('src/z.ts', new Set(['/internal/z/', '/internal/a/']));
  ctx.packageMap.set('src/empty.ts', new Set());
  ctx.namedImportMap.set(
    'src/z.ts',
    new Map([
      ['Alias', { sourcePath: 'src/barrel.ts', exportedName: 'Public' }],
      ['Other', { sourcePath: 'src/a.ts', exportedName: 'Original' }],
    ]),
  );
  ctx.namedImportMap.set(
    'src/barrel.ts',
    new Map([['Public', { sourcePath: 'src/model.ts', exportedName: 'User' }]]),
  );
  ctx.namedImportMap.set('src/empty.ts', new Map());
  ctx.moduleAliasMap.set(
    'src/z.py',
    new Map([
      ['models', 'src/models.py'],
      ['helpers', 'src/helpers.py'],
    ]),
  );
  ctx.moduleAliasMap.set('src/empty.py', new Map());
  return ctx;
}

describe('import-resolution state snapshots', () => {
  it('round-trips empty state through JSON', () => {
    const snapshot = snapshotImportResolutionState(createResolutionContext());
    expect(snapshot).toEqual({
      version: 1,
      importMap: [],
      packageMap: [],
      namedImportMap: [],
      moduleAliasMap: [],
    });
    expect(
      snapshotImportResolutionState(
        restoreImportResolutionState(JSON.parse(JSON.stringify(snapshot))),
      ),
    ).toEqual(snapshot);
  });

  it('preserves all map families, empty entries, paths, and insertion order', () => {
    const snapshot = snapshotImportResolutionState(populatedContext());
    expect(snapshot).toEqual({
      version: 1,
      importMap: [
        ['src/z.ts', ['src/barrel.ts', 'src/a.ts']],
        ['src/empty.ts', []],
      ],
      packageMap: [
        ['src/z.ts', ['/internal/z/', '/internal/a/']],
        ['src/empty.ts', []],
      ],
      namedImportMap: [
        [
          'src/z.ts',
          [
            ['Alias', { sourcePath: 'src/barrel.ts', exportedName: 'Public' }],
            ['Other', { sourcePath: 'src/a.ts', exportedName: 'Original' }],
          ],
        ],
        ['src/barrel.ts', [['Public', { sourcePath: 'src/model.ts', exportedName: 'User' }]]],
        ['src/empty.ts', []],
      ],
      moduleAliasMap: [
        [
          'src/z.py',
          [
            ['models', 'src/models.py'],
            ['helpers', 'src/helpers.py'],
          ],
        ],
        ['src/empty.py', []],
      ],
    });
    const restored = restoreImportResolutionState(JSON.parse(JSON.stringify(snapshot)));
    expect(snapshotImportResolutionState(restored)).toEqual(snapshot);
    expect(restored.importMap).toBeInstanceOf(Map);
    expect(restored.importMap.get('src/z.ts')).toBeInstanceOf(Set);
    expect(restored.packageMap.get('src/z.ts')).toBeInstanceOf(Set);
    expect(restored.namedImportMap.get('src/z.ts')).toBeInstanceOf(Map);
    expect(restored.moduleAliasMap.get('src/z.py')).toBeInstanceOf(Map);
  });

  it('shares no mutable map, set, binding, or array state across the boundary', () => {
    const ctx = populatedContext();
    const snapshot = snapshotImportResolutionState(ctx);
    const originalSnapshot = JSON.parse(JSON.stringify(snapshot));
    const restored = restoreImportResolutionState(snapshot);
    ctx.importMap.get('src/z.ts')!.add('src/later.ts');
    ctx.packageMap.get('src/z.ts')!.clear();
    ctx.namedImportMap.get('src/z.ts')!.get('Alias')!.sourcePath = 'src/changed.ts';
    ctx.moduleAliasMap.get('src/z.py')!.set('models', 'src/changed.py');
    expect(snapshot).toEqual(originalSnapshot);
    expect(snapshotImportResolutionState(restored)).toEqual(originalSnapshot);
    restored.importMap.get('src/z.ts')!.clear();
    restored.packageMap.get('src/z.ts')!.add('/new/');
    restored.namedImportMap.get('src/z.ts')!.get('Alias')!.exportedName = 'Changed';
    restored.moduleAliasMap.get('src/z.py')!.clear();
    expect(snapshot).toEqual(originalSnapshot);
    expect(ctx.importMap.get('src/z.ts')!.has('src/later.ts')).toBe(true);
    expect(ctx.namedImportMap.get('src/z.ts')!.get('Alias')!.exportedName).toBe('Public');
    const restoredAgain = restoreImportResolutionState(snapshot);
    snapshot.importMap[0][1].push('src/snapshot-only.ts');
    snapshot.packageMap[0][1].length = 0;
    snapshot.namedImportMap[0][1][0][1].sourcePath = 'src/snapshot-only.ts';
    snapshot.moduleAliasMap[0][1][0][1] = 'src/snapshot-only.py';
    expect(snapshotImportResolutionState(restoredAgain)).toEqual(originalSnapshot);
  });

  it('preserves named re-export, import-scoped, and package-scoped resolution', () => {
    const original = populatedContext();
    const restored = restoreImportResolutionState(
      JSON.parse(JSON.stringify(snapshotImportResolutionState(original))),
    );
    const hydrated = createResolutionContext();
    // Resolution closes over its original maps; hydrate those maps in place.
    for (const [key, value] of restored.importMap) hydrated.importMap.set(key, value);
    for (const [key, value] of restored.packageMap) hydrated.packageMap.set(key, value);
    for (const [key, value] of restored.namedImportMap) hydrated.namedImportMap.set(key, value);
    for (const [key, value] of restored.moduleAliasMap) hydrated.moduleAliasMap.set(key, value);
    for (const ctx of [original, hydrated]) {
      ctx.model.symbols.add('src/model.ts', 'User', 'class:User', 'Class');
      ctx.model.symbols.add('src/barrel.ts', 'Alias', 'class:decoy', 'Class');
      ctx.model.symbols.add('src/a.ts', 'Imported', 'const:Imported', 'Const');
      ctx.model.symbols.add('internal/z/value.go', 'PackageValue', 'const:PackageValue', 'Const');
    }
    for (const [name, nodeId] of [
      ['Alias', 'class:User'],
      ['Imported', 'const:Imported'],
      ['PackageValue', 'const:PackageValue'],
    ]) {
      const expected = original.resolve(name, 'src/z.ts');
      expect(expected?.tier).toBe('import-scoped');
      expect(expected?.candidates.map((candidate) => candidate.nodeId)).toEqual([nodeId]);
      expect(hydrated.resolve(name, 'src/z.ts')).toEqual(expected);
    }
    expect(hydrated.resolve('Missing', 'src/z.ts')).toBeNull();
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing version', {}],
    ['unsupported version', { version: 2 }],
    ['string version', { version: '1' }],
  ])('rejects an invalid envelope: %s', (_label, value) => {
    expect(() => restoreImportResolutionState(value)).toThrow();
  });

  for (const family of ['importMap', 'packageMap', 'namedImportMap', 'moduleAliasMap'] as const) {
    it.each([
      ['missing family', undefined],
      ['non-array family', {}],
      ['non-tuple entry', ['src/a.ts']],
      ['short tuple', [['src/a.ts']]],
      ['long tuple', [['src/a.ts', [], 'extra']]],
      ['non-string key', [[7, []]]],
      ['non-array values', [['src/a.ts', {}]]],
      [
        'duplicate outer keys',
        [
          ['src/a.ts', []],
          ['src/a.ts', []],
        ],
      ],
    ])(`rejects invalid ${family}: %s`, (_label, value) => {
      expect(() =>
        restoreImportResolutionState({
          ...snapshotImportResolutionState(createResolutionContext()),
          [family]: value,
        }),
      ).toThrow();
    });
  }

  for (const family of ['importMap', 'packageMap'] as const) {
    it.each([
      ['non-string member', [3]],
      ['duplicate set member', ['src/a.ts', 'src/a.ts']],
    ])(`rejects invalid ${family} members: %s`, (_label, values) => {
      expect(() =>
        restoreImportResolutionState({
          ...snapshotImportResolutionState(createResolutionContext()),
          [family]: [['src/z.ts', values]],
        }),
      ).toThrow();
    });
  }

  for (const family of ['namedImportMap', 'moduleAliasMap'] as const) {
    it.each([
      ['short binding tuple', [['Alias']]],
      ['long binding tuple', [['Alias', 'src/a.ts', 'extra']]],
      ['non-string binding key', [[3, 'src/a.ts']]],
      [
        'duplicate binding keys',
        [
          ['Alias', 'src/a.ts'],
          ['Alias', 'src/b.ts'],
        ],
      ],
      ['null binding value', [['Alias', null]]],
      ['wrong binding type', [['Alias', 3]]],
    ])(`rejects invalid ${family} bindings: %s`, (_label, bindings) => {
      expect(() =>
        restoreImportResolutionState({
          ...snapshotImportResolutionState(createResolutionContext()),
          [family]: [['src/z.ts', bindings]],
        }),
      ).toThrow();
    });
  }

  it.each([
    {},
    { sourcePath: 'src/a.ts' },
    { exportedName: 'User' },
    { sourcePath: 3, exportedName: 'User' },
    { sourcePath: 'src/a.ts', exportedName: null },
    [],
  ])('rejects malformed named binding %j', (binding) => {
    expect(() =>
      restoreImportResolutionState({
        ...snapshotImportResolutionState(createResolutionContext()),
        namedImportMap: [['src/z.ts', [['Alias', binding]]]],
      }),
    ).toThrow();
  });

  it('rejects duplicate named binding keys even when both values are valid', () => {
    const binding = { sourcePath: 'src/a.ts', exportedName: 'User' };
    expect(() =>
      restoreImportResolutionState({
        ...snapshotImportResolutionState(createResolutionContext()),
        namedImportMap: [
          [
            'src/z.ts',
            [
              ['Alias', binding],
              ['Alias', binding],
            ],
          ],
        ],
      }),
    ).toThrow();
  });
});
