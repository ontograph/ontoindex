import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import type { ExtractedCall } from '../../src/core/ingestion/workers/parse-worker.js';

const filePath = 'src/temporary-receiver.cpp';
const sourceId = `Function:${filePath}:caller`;

async function captureCalls(content: string) {
  const graph = createKnowledgeGraph();
  const ctx = createResolutionContext();
  const cache = createASTCache();
  const calls: ExtractedCall[] = [];
  const onIncomplete = vi.fn();
  ctx.model.symbols.add(filePath, 'caller', sourceId, 'Function');
  try {
    await processCalls(
      graph,
      [{ path: filePath, content }],
      cache,
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (call) => calls.push(call),
      undefined,
      undefined,
      onIncomplete,
    );
    return { calls, onIncomplete };
  } finally {
    cache.clear();
  }
}

describe('C++ temporary receiver call retention', () => {
  it('retains Foo().bar() as a typed outer member call and intentionally omits inner Foo()', async () => {
    const { calls, onIncomplete } = await captureCalls(`
class Foo { public: void bar(); };
void caller() { Foo().bar(); }
`);

    expect(calls).toEqual([
      {
        filePath,
        sourceId,
        calledName: 'bar',
        callForm: 'member',
        receiverName: 'Foo',
        receiverTypeName: 'Foo',
        argCount: 0,
        atRange: { startLine: 3, startCol: 16, endLine: 3, endCol: 27 },
      },
    ]);
    expect(onIncomplete).not.toHaveBeenCalled();
  });

  it('retains make().run() with the inner make() represented by the outer mixed chain', async () => {
    const { calls, onIncomplete } = await captureCalls(`
class Foo { public: void run(); };
Foo make();
void caller() { make().run(); }
`);

    // The inner call has no standalone record; its name survives in the chain.
    // Retaining this chain does not itself prove a resolved CALLS edge.
    expect(calls).toEqual([
      {
        filePath,
        sourceId,
        calledName: 'run',
        callForm: 'member',
        receiverMixedChain: [
          {
            kind: 'call',
            name: 'make',
            atRange: { startLine: 4, startCol: 16, endLine: 4, endCol: 22 },
          },
        ],
        argCount: 0,
        atRange: { startLine: 4, startCol: 16, endLine: 4, endCol: 28 },
      },
    ]);
    expect(onIncomplete).not.toHaveBeenCalled();
  });

  it('retains both plain foo() and obj.bar() control calls without reporting incomplete capture', async () => {
    const { calls, onIncomplete } = await captureCalls(`
class Foo { public: void bar(); };
void foo();
void caller(Foo obj) { foo(); obj.bar(); }
`);

    expect(calls).toEqual([
      {
        filePath,
        sourceId,
        calledName: 'foo',
        callForm: 'free',
        argCount: 0,
        atRange: { startLine: 4, startCol: 23, endLine: 4, endCol: 28 },
      },
      {
        filePath,
        sourceId,
        calledName: 'bar',
        callForm: 'member',
        receiverName: 'obj',
        receiverTypeName: 'Foo',
        argCount: 0,
        atRange: { startLine: 4, startCol: 30, endLine: 4, endCol: 39 },
      },
    ]);
    expect(onIncomplete).not.toHaveBeenCalled();
  });
});
