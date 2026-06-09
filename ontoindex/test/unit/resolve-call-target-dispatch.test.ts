import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resolveCallTargetForTesting,
  resolveMemberCall,
} from '../../src/core/ingestion/call-processor.js';
import {
  createResolutionContext,
  type ResolutionContext,
} from '../../src/core/ingestion/model/resolution-context.js';
import { buildHeritageMap } from '../../src/core/ingestion/model/heritage-map.js';
import type { ExtractedHeritage } from '../../src/core/ingestion/model/heritage-map.js';

describe('resolveCallTarget dispatch branches', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it("primary === 'free': routes to resolveFreeCall and returns the function", () => {
    ctx.model.symbols.add('src/utils.ts', 'compute', 'func:compute', 'Function');
    ctx.importMap.set('src/app.ts', new Set(['src/utils.ts']));

    const result = _resolveCallTargetForTesting(
      { calledName: 'compute', callForm: 'free' },
      'src/app.ts',
      ctx,
    );

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('func:compute');
  });

  it("primary === 'constructor': routes to resolveStaticCall and returns the class node", () => {
    ctx.model.symbols.add('src/order.ts', 'Order', 'class:Order', 'Class');
    ctx.importMap.set('src/app.ts', new Set(['src/order.ts']));

    const result = _resolveCallTargetForTesting(
      { calledName: 'Order', callForm: 'constructor' },
      'src/app.ts',
      ctx,
    );

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('class:Order');
  });

  it("primary === 'owner-scoped' with receiverTypeName: resolves via resolveMemberCall", () => {
    ctx.model.symbols.add('src/user.ts', 'User', 'class:User', 'Class');
    ctx.model.symbols.add('src/user.ts', 'save', 'method:User:save', 'Method', {
      returnType: 'void',
      ownerId: 'class:User',
    });
    ctx.importMap.set('src/app.ts', new Set(['src/user.ts']));

    const result = _resolveCallTargetForTesting(
      { calledName: 'save', callForm: 'member', receiverTypeName: 'User' },
      'src/app.ts',
      ctx,
    );

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('method:User:save');
  });

  it("primary === 'owner-scoped' without receiverTypeName: falls through to singleCandidate", () => {
    ctx.model.symbols.add('src/utils.ts', 'process', 'func:process', 'Function');
    ctx.importMap.set('src/app.ts', new Set(['src/utils.ts']));

    const result = _resolveCallTargetForTesting(
      { calledName: 'process', callForm: 'member' },
      'src/app.ts',
      ctx,
    );

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('func:process');
  });

  it('singleton ancestryView: resolveMemberCall returns null for instance-only method (no extend parents)', () => {
    // Account.log is a Ruby class-method call. `log` is an instance method on
    // Account (ownerId present), but Account has only an `include` parent —
    // no `extend` parents — so singleton ancestry is empty.
    //
    // With ruby-mixin strategy, the ancestryOverride is the pre-computed
    // singleton ancestry (empty here). The loop over an empty ancestry finds
    // nothing and returns undefined — proving that a singleton-dispatch miss
    // does NOT silently fall through to find the instance method.
    ctx.model.symbols.add('src/account.rb', 'Account', 'class:Account', 'Class');
    ctx.model.symbols.add('src/account.rb', 'log', 'method:Account:log', 'Method', {
      returnType: 'nil',
      ownerId: 'class:Account',
    });
    ctx.model.symbols.add('src/logger.rb', 'Loggable', 'module:Loggable', 'Module');
    ctx.importMap.set('src/app.rb', new Set(['src/account.rb', 'src/logger.rb']));

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/account.rb', className: 'Account', parentName: 'Loggable', kind: 'include' },
    ];
    const heritageMap = buildHeritageMap(heritage, ctx);

    const result = resolveMemberCall(
      'Account',
      'log',
      'src/app.rb',
      ctx,
      heritageMap,
      undefined,
      'singleton',
    );

    expect(result).toBeNull();
  });

  it('alias-narrowing guard (SM-10 R3): alias target file does not hold receiver type — null-routes', () => {
    // `User` is defined in `models.py`. Receiver variable `h` is aliased to
    // `helpers.py`, which is NOT a defining file for `User`. There is also no
    // `save` method in `models.py`, so both resolveMemberCall and
    // resolveMemberCallByFile return null. The type-file guard then checks
    // whether the alias target (`helpers.py`) is among User's defining files
    // — it is not — so alias narrowing is skipped. Since typeResolves has
    // candidates (User exists), the SM-10 R3 null-route fires rather than
    // falling through to singleCandidate.
    ctx.model.symbols.add('src/models.py', 'User', 'class:py:User', 'Class');
    ctx.model.symbols.add('src/helpers.py', 'save', 'func:py:helpers:save', 'Function');
    ctx.importMap.set('src/app.py', new Set(['src/models.py', 'src/helpers.py']));
    ctx.moduleAliasMap.set('src/app.py', new Map([['h', 'src/helpers.py']]));

    const result = _resolveCallTargetForTesting(
      {
        calledName: 'save',
        callForm: 'member',
        receiverTypeName: 'User',
        receiverName: 'h',
      },
      'src/app.py',
      ctx,
    );

    expect(result).toBeNull();
  });
});
