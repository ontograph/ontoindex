import { describe, expect, it } from 'vitest';
import {
  createResolutionContext,
  restoreImportResolutionState,
  snapshotImportResolutionState,
} from '../../../src/core/ingestion/model/resolution-context.js';
import { restoreSemanticModelRegistrations } from '../../../src/core/ingestion/model/semantic-model.js';

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
  it('preserves explicit namespace export authority across V1 replay', () => {
    const ctx = createResolutionContext({ captureRegistrations: true });
    ctx.model.symbols.add('base.ts', 'Local', 'class:local', 'Class');
    ctx.model.symbols.add('base.ts', 'Private', 'class:private', 'Class');
    ctx.moduleAliasMap.set('app.ts', new Map([['models', 'barrel.ts']]));
    ctx.namedImportMap.set(
      'barrel.ts',
      new Map([
        ['#export:Public', { sourcePath: 'base.ts', exportedName: 'Alias' }],
        ['Private', { sourcePath: 'base.ts', exportedName: 'Private' }],
      ]),
    );
    ctx.namedImportMap.set(
      'base.ts',
      new Map([['#local-export:Alias', { sourcePath: 'base.ts', exportedName: 'Local' }]]),
    );
    const replay = createResolutionContext({
      model: restoreSemanticModelRegistrations(
        JSON.parse(JSON.stringify(ctx.model.snapshotRegistrations())),
      ),
      importState: JSON.parse(JSON.stringify(snapshotImportResolutionState(ctx))),
    });
    for (const context of [ctx, replay]) {
      expect(
        context.resolve('models.Public', 'app.ts')?.candidates.map((def) => def.nodeId),
      ).toEqual(['class:local']);
      expect(context.resolve('models.Private', 'app.ts')).toBeNull();
      expect(context.resolve('models.Local', 'app.ts')).toBeNull();
      context.clear();
    }
  });

  describe('bounded capture', () => {
    const generousLimits = { maxBytes: 1_000_000, maxEntries: 1_000 };

    it('keeps the V1 shape, empty file rows, insertion order, and detached bindings', () => {
      const ctx = populatedContext();
      const expected = snapshotImportResolutionState(ctx);
      const bounded = snapshotImportResolutionState(ctx, generousLimits);
      expect(bounded).toEqual(expected);
      ctx.importMap.get('src/z.ts')!.clear();
      ctx.packageMap.get('src/z.ts')!.clear();
      ctx.namedImportMap.get('src/z.ts')!.get('Alias')!.sourcePath = 'changed.ts';
      ctx.moduleAliasMap.get('src/z.py')!.clear();
      expect(bounded).toEqual(expected);
      bounded.namedImportMap[0]![1][0]![1].exportedName = 'SnapshotOnly';
      expect(ctx.namedImportMap.get('src/z.ts')!.get('Alias')!.exportedName).toBe('Public');
    });

    it.each([
      ['ASCII', 'ordinary/path.ts'],
      ['escaped characters', 'quote" backslash\\ newline\n tab\t nul\0'],
      ['Unicode', 'src/é/漢字/😀.ts'],
      ['lone surrogates', 'src/\ud800/\udfff.ts'],
    ])('uses exact serialized UTF-8 bytes for %s', (_label, value) => {
      const ctx = createResolutionContext();
      ctx.importMap.set(value, new Set([value]));
      ctx.packageMap.set(value, new Set([value]));
      ctx.namedImportMap.set(value, new Map([[value, { sourcePath: value, exportedName: value }]]));
      ctx.moduleAliasMap.set(value, new Map([[value, value]]));
      const expected = snapshotImportResolutionState(ctx);
      const bytes = Buffer.byteLength(JSON.stringify(expected), 'utf8');
      expect(snapshotImportResolutionState(ctx, { ...generousLimits, maxBytes: bytes })).toEqual(
        expected,
      );
      expect(() =>
        snapshotImportResolutionState(ctx, { ...generousLimits, maxBytes: bytes - 1 }),
      ).toThrowError(expect.objectContaining({ code: 'IMPORT_STATE_LIMIT' }));
    });

    it('counts outer file rows and inner members across all four map families', () => {
      const ctx = populatedContext();
      // Nine outer file rows plus nine set members or named/alias bindings.
      expect(snapshotImportResolutionState(ctx, { ...generousLimits, maxEntries: 18 })).toEqual(
        snapshotImportResolutionState(ctx),
      );
      expect(() =>
        snapshotImportResolutionState(ctx, { ...generousLimits, maxEntries: 17 }),
      ).toThrowError(expect.objectContaining({ code: 'IMPORT_STATE_LIMIT' }));
    });

    it('charges empty file rows even when there are no inner members', () => {
      const ctx = createResolutionContext();
      for (let i = 0; i < 64; i++) {
        ctx.importMap.set(`import-${i}`, new Set());
        ctx.packageMap.set(`package-${i}`, new Set());
        ctx.namedImportMap.set(`named-${i}`, new Map());
        ctx.moduleAliasMap.set(`alias-${i}`, new Map());
      }
      expect(snapshotImportResolutionState(ctx, { ...generousLimits, maxEntries: 256 })).toEqual(
        snapshotImportResolutionState(ctx),
      );
      expect(() =>
        snapshotImportResolutionState(ctx, { ...generousLimits, maxEntries: 255 }),
      ).toThrowError(expect.objectContaining({ code: 'IMPORT_STATE_LIMIT' }));
    });

    it('allows zero entries for empty state but refuses a zero byte budget', () => {
      const ctx = createResolutionContext();
      expect(snapshotImportResolutionState(ctx, { ...generousLimits, maxEntries: 0 })).toEqual(
        snapshotImportResolutionState(ctx),
      );
      expect(() =>
        snapshotImportResolutionState(ctx, { ...generousLimits, maxBytes: 0 }),
      ).toThrowError(expect.objectContaining({ code: 'IMPORT_STATE_LIMIT' }));
    });

    it.each(['maxBytes', 'maxEntries'] as const)(
      'rejects invalid %s limits with a stable code',
      (limit) => {
        for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
          expect(() =>
            snapshotImportResolutionState(createResolutionContext(), {
              ...generousLimits,
              [limit]: value,
            }),
          ).toThrowError(expect.objectContaining({ code: 'IMPORT_STATE_LIMIT' }));
        }
      },
    );

    it('refuses a huge string without invoking user serialization hooks', () => {
      const ctx = createResolutionContext();
      let serialized = 0;
      const binding = {
        sourcePath: 'x'.repeat(1_000_000),
        exportedName: 'Export',
        toJSON() {
          serialized++;
          throw new Error('User serialization must not run');
        },
      };
      ctx.namedImportMap.set('a.ts', new Map([['Alias', binding]]));
      expect(() =>
        snapshotImportResolutionState(ctx, { ...generousLimits, maxBytes: 256 }),
      ).toThrowError(expect.objectContaining({ code: 'IMPORT_STATE_LIMIT' }));
      expect(serialized).toBe(0);
    });

    it.each(['sourcePath', 'exportedName'] as const)(
      'refuses a %s getter without invoking it',
      (field) => {
        const ctx = createResolutionContext();
        let reads = 0;
        const binding = { sourcePath: 'a.ts', exportedName: 'Export' };
        Object.defineProperty(binding, field, {
          enumerable: true,
          get() {
            reads++;
            return 'unsafe';
          },
        });
        ctx.namedImportMap.set('a.ts', new Map([['Alias', binding]]));
        expect(() => snapshotImportResolutionState(ctx, generousLimits)).toThrow();
        expect(reads).toBe(0);
      },
    );

    it('requires own binding fields and fails closed when descriptor inspection throws', () => {
      const ctx = createResolutionContext();
      let reads = 0;
      const inherited = Object.create({
        get sourcePath() {
          reads++;
          return 'a.ts';
        },
        exportedName: 'Export',
      });
      ctx.namedImportMap.set('a.ts', new Map([['Alias', inherited]]));
      expect(() => snapshotImportResolutionState(ctx, generousLimits)).toThrow();
      expect(reads).toBe(0);
      const proxy = new Proxy(
        { sourcePath: 'a.ts', exportedName: 'Export' },
        {
          getOwnPropertyDescriptor() {
            throw new Error('Descriptor unavailable');
          },
        },
      );
      ctx.namedImportMap.get('a.ts')!.set('Alias', proxy);
      expect(() => snapshotImportResolutionState(ctx, generousLimits)).toThrow();
    });
  });

  it('rebuilds aliased resolution from existing model and import snapshots with fresh caches', () => {
    const original = createResolutionContext({ captureRegistrations: true });
    original.model.symbols.add('src/model.ts', 'User', 'Class:src/model.ts:User', 'Class');
    original.importMap.set('src/app.ts', new Set(['src/model.ts']));
    original.namedImportMap.set(
      'src/app.ts',
      new Map([['Alias', { sourcePath: 'src/model.ts', exportedName: 'User' }]]),
    );
    original.enableCache('src/app.ts');
    const expected = original.resolve('Alias', 'src/app.ts');
    expect(expected?.candidates.map((candidate) => candidate.nodeId)).toEqual([
      'Class:src/model.ts:User',
    ]);
    const registrations = original.model.snapshotRegistrations()!;
    const imports = snapshotImportResolutionState(original);
    const model = restoreSemanticModelRegistrations(JSON.parse(JSON.stringify(registrations)));
    const restored = createResolutionContext({ model, importState: imports });
    expect(restored.model).toBe(model);
    expect(restored.model.snapshotRegistrations()).toBeUndefined();
    expect(restored.getStats().cacheHits).toBe(0);
    expect(restored.getStats().cacheMisses).toBe(0);
    original.clear();
    imports.importMap[0]![1].length = 0;
    imports.namedImportMap[0]![1][0]![1].sourcePath = 'changed.ts';
    expect(restored.resolve('Alias', 'src/app.ts')).toEqual(expected);
    restored.clear();
    expect(model.symbols.getStats().fileCount).toBe(0);
    expect(restored.resolve('Alias', 'src/app.ts')).toBeNull();
  });

  it('keeps capture opt-in and refuses ambiguous ownership or malformed import state', () => {
    const plain = createResolutionContext();
    plain.model.symbols.add('a.ts', 'f', 'Function:a.ts:f', 'Function');
    expect(plain.model.snapshotRegistrations()).toBeUndefined();
    expect(() =>
      createResolutionContext({ model: plain.model, captureRegistrations: true }),
    ).toThrow('Cannot capture registrations');
    expect(() =>
      createResolutionContext({ model: plain.model, importState: { version: 2 } as never }),
    ).toThrow();
    expect(plain.model.symbols.lookupExactAll('a.ts', 'f')).toHaveLength(1);
  });

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
