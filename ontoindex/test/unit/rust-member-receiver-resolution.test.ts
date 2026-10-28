import { beforeEach, describe, expect, it } from 'vitest';
import { _resolveCallTargetForTesting } from '../../src/core/ingestion/call-processor.js';
import {
  createResolutionContext,
  type ResolutionContext,
} from '../../src/core/ingestion/model/resolution-context.js';

describe('Rust member receiver evidence', () => {
  let ctx: ResolutionContext;

  beforeEach(() => {
    ctx = createResolutionContext();
  });

  it('does not resolve external HashMap.keys to an unrelated trait implementation', () => {
    ctx.model.symbols.add('src/extractor.rs', 'keys', 'method:extractor:keys', 'Function', {
      ownerId: 'struct:HeaderMapExtractor',
      parameterCount: 0,
    });

    expect(
      _resolveCallTargetForTesting(
        {
          calledName: 'keys',
          callForm: 'member',
          receiverTypeName: 'HashMap',
          receiverName: 'tools',
          argCount: 0,
        },
        'src/tools.rs',
        ctx,
      ),
    ).toBeNull();
  });

  it.each(['Struct', 'Impl'] as const)(
    'preserves %s owner-matched methods for self and object receivers',
    (kind) => {
      const ownerId = `${kind}:User`;
      ctx.model.symbols.add('src/user.rs', 'User', ownerId, kind);
      ctx.model.symbols.add('src/user.rs', 'save', 'method:User:save', 'Function', {
        ownerId,
        parameterCount: 0,
      });

      for (const receiverName of ['self', 'user']) {
        expect(
          _resolveCallTargetForTesting(
            {
              calledName: 'save',
              callForm: 'member',
              receiverTypeName: 'User',
              receiverName,
              argCount: 0,
            },
            'src/main.rs',
            ctx,
          )?.nodeId,
        ).toBe('method:User:save');
      }
    },
  );

  it('preserves proven module-alias resolution without a receiver type', () => {
    ctx.model.symbols.add('src/helpers.rs', 'run', 'function:helpers:run', 'Function');
    ctx.moduleAliasMap.set('src/main.rs', new Map([['helpers', 'src/helpers.rs']]));

    expect(
      _resolveCallTargetForTesting(
        { calledName: 'run', callForm: 'member', receiverName: 'helpers' },
        'src/main.rs',
        ctx,
      )?.nodeId,
    ).toBe('function:helpers:run');
  });
});
