/**
 * Unit tests for `ResolutionContext.resolve()` — the tiered name
 * resolution that backs call-processor's Tier 1 / 2a-named / 2a / 2b / 3
 * pipeline. These tests pin invariants that TypeScript cannot prove at
 * build time: tier precedence, cross-index dedup, and the
 * walkBindingChain cycle/depth guards.
 */

import { describe, it, expect } from 'vitest';
import { createResolutionContext } from '../../../src/core/ingestion/model/resolution-context.js';
import { buildHeritageMap } from '../../../src/core/ingestion/model/heritage-map.js';

describe('ResolutionContext.resolve() — namespace imports', () => {
  it.each(['ts', 'js', 'tsx', 'jsx'])(
    'resolves only the mapped module in %s files',
    (extension) => {
      const ctx = createResolutionContext();
      const caller = `src/app.${extension}`;
      ctx.model.symbols.add('src/base.ts', 'Base', 'class:correct', 'Class');
      ctx.model.symbols.add('src/other.ts', 'Base', 'class:other', 'Class');
      ctx.model.symbols.add(caller, 'Base', 'class:local', 'Class');
      ctx.moduleAliasMap.set(caller, new Map([['models', 'src/base.ts']]));
      ctx.namedImportMap.set(
        'src/base.ts',
        new Map([['#local-export:Base', { sourcePath: 'src/base.ts', exportedName: 'Base' }]]),
      );
      ctx.importMap.set(caller, new Set(['src/base.ts', 'src/other.ts']));

      const result = ctx.resolve('models . Base', caller);
      expect(result?.tier).toBe('import-scoped');
      expect(result?.candidates.map((candidate) => candidate.nodeId)).toEqual(['class:correct']);
      expect(ctx.resolve('unknown.Base', caller)).toBeNull();
      expect(ctx.resolve('models.Missing', caller)).toBeNull();
      expect(ctx.resolve('models.nested.Base', caller)).toBeNull();
    },
  );

  it('follows named barrel reexports and supports Unicode identifiers', () => {
    const ctx = createResolutionContext();
    ctx.moduleAliasMap.set('app.ts', new Map([['模型', 'index.ts']]));
    ctx.namedImportMap.set(
      'index.ts',
      new Map([['#export:基类', { sourcePath: 'base.ts', exportedName: 'Original' }]]),
    );
    ctx.namedImportMap.set(
      'base.ts',
      new Map([['#local-export:Original', { sourcePath: 'base.ts', exportedName: 'Original' }]]),
    );
    ctx.model.symbols.add('base.ts', 'Original', 'class:original', 'Class');
    expect(
      ctx.resolve('模型.基类', 'app.ts')?.candidates.map((candidate) => candidate.nodeId),
    ).toEqual(['class:original']);
  });

  it('does not recover unresolved qualified parents from global heritage lookup', () => {
    const ctx = createResolutionContext();
    ctx.model.symbols.add('app.ts', 'Child', 'class:child', 'Class');
    ctx.model.symbols.add('other.ts', 'unknown.Base', 'class:wrong', 'Class');
    const heritage = buildHeritageMap(
      [{ filePath: 'app.ts', className: 'Child', parentName: 'unknown.Base', kind: 'extends' }],
      ctx,
    );
    expect(heritage.getParents('class:child')).toEqual([]);
  });

  it('preserves qualified-name resolution for other languages', () => {
    const ctx = createResolutionContext();
    ctx.model.symbols.add('app.cs', 'Models.Base', 'class:csharp', 'Class');
    expect(ctx.resolve('Models.Base', 'app.cs')?.candidates[0].nodeId).toBe('class:csharp');
  });

  it('preserves authoritative same-file full-name matches before namespace lookup', () => {
    const ctx = createResolutionContext();
    ctx.model.symbols.add('app.ts', 'Models.Base', 'class:local', 'Class');
    ctx.model.symbols.add('base.ts', 'Base', 'class:imported', 'Class');
    ctx.moduleAliasMap.set('app.ts', new Map([['Models', 'base.ts']]));
    const result = ctx.resolve('Models.Base', 'app.ts');
    expect(result?.tier).toBe('same-file');
    expect(result?.candidates.map((candidate) => candidate.nodeId)).toEqual(['class:local']);
  });
});

describe('ResolutionContext registration observation', () => {
  it('retains publication authority across cache resets and releases it on clear', () => {
    const ctx = createResolutionContext();
    const authority = { owns: () => true, emit: () => {} };
    ctx.scopeCallPublication = authority;
    ctx.enableCache('app.ts');
    ctx.clearCache();
    expect(ctx.scopeCallPublication).toBe(authority);
    ctx.clear();
    expect(ctx.scopeCallPublication).toBeUndefined();
  });

  it('forwards bounded observation and failure notification without local journaling', () => {
    const events: string[] = [];
    let failures = 0;
    const ctx = createResolutionContext({
      onRegistration: (encoded) => {
        events.push(encoded);
        return false;
      },
      onRegistrationError: () => {
        failures++;
      },
    });
    ctx.model.symbols.add('a.ts', 'First', 'first', 'Class');
    ctx.model.symbols.add('a.ts', 'Second', 'second', 'Class');
    expect(events.map((event) => JSON.parse(event).name)).toEqual(['First']);
    expect(failures).toBe(1);
    expect(ctx.model.snapshotRegistrations()).toBeUndefined();
    expect(ctx.resolve('Second', 'a.ts')?.candidates[0]?.nodeId).toBe('second');
  });

  it('rejects observation options that cannot attach to a supplied model', () => {
    const model = createResolutionContext().model;
    expect(() => createResolutionContext({ model, onRegistration: () => true })).toThrow(
      'Cannot observe registrations',
    );
    expect(() => createResolutionContext({ model, onRegistrationError: () => {} })).toThrow(
      'Cannot observe registrations',
    );
  });
});

describe('ResolutionContext.resolve() — tier precedence', () => {
  it('Tier 2a-named binding chain takes precedence over Tier 2a import-scoped', () => {
    // Setup: A imports { User as U } from B. B defines both User (the
    // real one) and U (an unrelated same-name symbol). A resolve('U') in
    // file A must prefer the aliased binding chain (U → User in B),
    // NOT the raw Tier 2a lookup that would find B's own 'U'.
    const ctx = createResolutionContext();
    ctx.model.symbols.add('src/b.ts', 'User', 'class:User', 'Class');
    ctx.model.symbols.add('src/b.ts', 'U', 'class:U_decoy', 'Class');

    // Register the import A → B and the aliased binding A.U → B.User.
    ctx.importMap.set('src/a.ts', new Set(['src/b.ts']));
    const aliasBindings = new Map();
    aliasBindings.set('U', { sourcePath: 'src/b.ts', exportedName: 'User' });
    ctx.namedImportMap.set('src/a.ts', aliasBindings);

    const result = ctx.resolve('U', 'src/a.ts');
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('import-scoped');
    // The named-binding chain resolves U → User, not U → U_decoy.
    expect(result!.candidates.map((c) => c.nodeId)).toEqual(['class:User']);
  });

  it('Tier 1 (same-file) beats Tier 2a even when an aliased import exists', () => {
    // Belt-and-suspenders check: if the caller's own file has a matching
    // symbol, it wins — aliased bindings only fire when Tier 1 misses.
    const ctx = createResolutionContext();
    ctx.model.symbols.add('src/a.ts', 'U', 'fn:local:U', 'Function');
    ctx.model.symbols.add('src/b.ts', 'User', 'class:User', 'Class');

    const aliasBindings = new Map();
    aliasBindings.set('U', { sourcePath: 'src/b.ts', exportedName: 'User' });
    ctx.namedImportMap.set('src/a.ts', aliasBindings);

    const result = ctx.resolve('U', 'src/a.ts');
    expect(result!.tier).toBe('same-file');
    expect(result!.candidates[0].nodeId).toBe('fn:local:U');
  });
});

describe('ResolutionContext.resolve() — Tier 3 dedup for Function+ownerId', () => {
  it('Python/Rust/Kotlin class methods emitted as Function+ownerId land in only one Tier 3 result', () => {
    // Simulate the Python worker path: a class method is emitted with
    // type='Function' and ownerId set. `rawSymbols.add` lands it in
    // callableByName (via the Function callable-index gate) AND
    // `wrappedAdd` normalizes the dispatch key to 'Method' so it also
    // lands in methodRegistry. The same SymbolDefinition reference is
    // reachable via two Tier 3 lookups.
    const ctx = createResolutionContext();
    ctx.model.symbols.add('src/user.py', 'User', 'class:User', 'Class');
    ctx.model.symbols.add('src/user.py', 'greet', 'fn:User.greet', 'Function', {
      ownerId: 'class:User',
      returnType: 'str',
    });

    // Sanity check the setup: the same def is in both indexes.
    expect(ctx.model.symbols.lookupCallableByName('greet')).toHaveLength(1);
    expect(ctx.model.methods.lookupMethodByName('greet')).toHaveLength(1);
    expect(ctx.model.methods.hasFunctionMethods).toBe(true);

    // Resolve a free 'greet' call from an unrelated file — Tier 1 / 2a /
    // 2b all miss, so Tier 3 fires. The dedup pass must collapse the
    // two index hits into a single candidate.
    const result = ctx.resolve('greet', 'src/caller.py');
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('global');
    expect(result!.candidates).toHaveLength(1);
    expect(result!.candidates[0].nodeId).toBe('fn:User.greet');
  });

  it('Tier 3 fast path fires when no Function+ownerId was ever registered', () => {
    // Pure TypeScript-style: methods are emitted as strict Method labels,
    // so callableByName and methodRegistry are disjoint and the dedup
    // fast path can concat without a Set allocation.
    const ctx = createResolutionContext();
    ctx.model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    ctx.model.symbols.add('src/user.ts', 'greet', 'method:User.greet', 'Method', {
      ownerId: 'class:User',
      returnType: 'string',
    });
    ctx.model.symbols.add('src/utils.ts', 'greet', 'fn:utils.greet', 'Function');

    expect(ctx.model.methods.hasFunctionMethods).toBe(false);

    // Tier 3 for 'greet' from an unrelated file returns both the free
    // function and the class method; neither overlaps so no dedup.
    const result = ctx.resolve('greet', 'src/caller.ts');
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('global');
    expect(result!.candidates.map((c) => c.nodeId).sort()).toEqual([
      'fn:utils.greet',
      'method:User.greet',
    ]);
  });
});

describe('ResolutionContext.resolve() — walkBindingChain guards', () => {
  it('circular re-export returns null (cycle detection fires)', () => {
    // A imports { X } from B, B re-exports { X } from A.
    // walkBindingChain must detect the cycle via the visited Set and
    // return null instead of looping until depth exceeded.
    const ctx = createResolutionContext();
    // Intentionally leave X undefined in both files — the walker only
    // follows re-export edges, not definitions.
    const aBindings = new Map();
    aBindings.set('X', { sourcePath: 'src/b.ts', exportedName: 'X' });
    ctx.namedImportMap.set('src/a.ts', aBindings);
    const bBindings = new Map();
    bBindings.set('X', { sourcePath: 'src/a.ts', exportedName: 'X' });
    ctx.namedImportMap.set('src/b.ts', bBindings);

    const result = ctx.resolve('X', 'src/a.ts');
    // No definition anywhere in the chain → Tier 2a-named returns null,
    // nothing else matches, overall result is null.
    expect(result).toBeNull();
  });

  it('chain deeper than MAX_BINDING_CHAIN_DEPTH drops the named-binding path', () => {
    // Build a six-hop re-export chain where every hop just forwards the
    // binding. walkBindingChain iterates 5 times and hits the depth cap
    // before the sixth hop, returning null. No other tier can resolve
    // 'X' either (no X is registered anywhere), so the overall
    // `ctx.resolve` call returns null.
    const ctx = createResolutionContext();
    const chain = [
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
      'src/e.ts',
      'src/f.ts',
      'src/g.ts',
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      const bindings = new Map();
      bindings.set('X', { sourcePath: chain[i + 1], exportedName: 'X' });
      ctx.namedImportMap.set(chain[i], bindings);
    }
    // No symbol registered in any file — the chain walk is the only
    // possible resolution path, and the depth cap silently kills it.
    const result = ctx.resolve('X', 'src/a.ts');
    expect(result).toBeNull();
  });

  it('chain of exactly five hops resolves successfully at the boundary', () => {
    // Five hops from A is exactly MAX_BINDING_CHAIN_DEPTH — the final
    // lookup on the fifth hop must succeed.
    const ctx = createResolutionContext();
    ctx.model.symbols.add('src/e.ts', 'X', 'class:X', 'Class');
    const chain = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
    for (let i = 0; i < chain.length - 1; i++) {
      const bindings = new Map();
      bindings.set('X', { sourcePath: chain[i + 1], exportedName: 'X' });
      ctx.namedImportMap.set(chain[i], bindings);
    }

    const result = ctx.resolve('X', 'src/a.ts');
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('import-scoped');
    expect(result!.candidates[0].nodeId).toBe('class:X');
  });
});
