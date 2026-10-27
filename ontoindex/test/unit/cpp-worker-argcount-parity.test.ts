import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import type {
  ExtractedCall,
  WorkerIncomingMessage,
  WorkerOutgoingMessage,
} from '../../src/core/ingestion/workers/parse-types.js';

const port = vi.hoisted(() => ({ on: vi.fn(), postMessage: vi.fn() }));

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  parentPort: port,
}));

describe('C++ worker argument count parity', () => {
  it('retains arity for temporary receivers and ordinary call forms', async () => {
    port.postMessage.mockClear();
    const filePath = 'src/argcount.cpp';
    const content = `
class Foo { public: void bar(); void bar(int, int); };
class T { public: T(int); static T make(int); void method(int); };
void foo(int, int);
void caller(T obj) {
  foo(1, 2);
  obj.method(1);
  T::make(1);
  new T(1);
  Foo().bar();
  Foo().bar(1, 2);
}
`;
    const calls: ExtractedCall[] = [];
    const cache = createASTCache();
    const ctx = createResolutionContext();
    ctx.model.symbols.add(filePath, 'caller', `Function:${filePath}:caller`, 'Function');
    try {
      await processCalls(
        createKnowledgeGraph(),
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
      );
    } finally {
      cache.clear();
      ctx.clear();
    }

    // Exercise the source worker's real message handler without a dist build.
    await import('../../src/core/ingestion/workers/parse-worker.js');
    const handler = port.on.mock.calls.find(([event]) => event === 'message')?.[1] as
      | ((message: WorkerIncomingMessage) => Promise<void>)
      | undefined;
    expect(handler).toBeDefined();
    await handler!([{ path: filePath, content }]);
    const messages = port.postMessage.mock.calls.map(
      ([message]) => message as WorkerOutgoingMessage,
    );
    expect(messages.filter((message) => message.type === 'error')).toEqual([]);
    const result = messages.find((message) => message.type === 'result');
    expect(result?.type).toBe('result');
    if (result?.type !== 'result' || !result.data)
      throw new Error('Worker did not return parsed calls');

    const arities = (records: ExtractedCall[]) =>
      records
        .map(({ calledName, argCount }) => ({ calledName, argCount }))
        .sort(
          (left, right) =>
            left.calledName.localeCompare(right.calledName) ||
            (left.argCount ?? -1) - (right.argCount ?? -1),
        );
    expect(arities(calls)).toEqual(
      arities([
        { filePath, sourceId: '', calledName: 'foo', argCount: 2 },
        { filePath, sourceId: '', calledName: 'method', argCount: 1 },
        { filePath, sourceId: '', calledName: 'make', argCount: 1 },
        { filePath, sourceId: '', calledName: 'T', argCount: 1 },
        { filePath, sourceId: '', calledName: 'bar', argCount: 0 },
        { filePath, sourceId: '', calledName: 'bar', argCount: 2 },
      ]),
    );
    expect(arities(result.data.calls)).toEqual(arities(calls));
  });

  it.each(['ts', 'js'])(
    'retains exact expression ranges and reference parity in %s',
    async (extension) => {
      port.postMessage.mockClear();
      const filePath = `src/call-ranges.${extension}`;
      const content = `function caller(svc) {
  same(); same();
  outer(inner());
  svc.lookup().save();
  same(
    inner()
  );
}`;
      const calls: ExtractedCall[] = [];
      const cache = createASTCache();
      const ctx = createResolutionContext();
      ctx.model.symbols.add(filePath, 'caller', `Function:${filePath}:caller`, 'Function');
      try {
        await processCalls(
          createKnowledgeGraph(),
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
        );
      } finally {
        cache.clear();
        ctx.clear();
      }

      await import('../../src/core/ingestion/workers/parse-worker.js');
      const handler = port.on.mock.calls.find(([event]) => event === 'message')?.[1] as
        | ((message: WorkerIncomingMessage) => Promise<void>)
        | undefined;
      expect(handler).toBeDefined();
      await handler!([{ path: filePath, content }]);
      const messages = port.postMessage.mock.calls.map(
        ([message]) => message as WorkerOutgoingMessage,
      );
      expect(messages.filter((message) => message.type === 'error')).toEqual([]);
      const result = messages.find((message) => message.type === 'result');
      expect(result?.type).toBe('result');
      if (result?.type !== 'result' || !result.data)
        throw new Error('Worker did not return parsed calls');

      const identities = (records: ExtractedCall[]) =>
        records
          .map(({ calledName, atRange }) => ({ calledName, atRange }))
          .sort(
            (left, right) =>
              (left.atRange?.startLine ?? 0) - (right.atRange?.startLine ?? 0) ||
              (left.atRange?.startCol ?? 0) - (right.atRange?.startCol ?? 0) ||
              (left.atRange?.endLine ?? 0) - (right.atRange?.endLine ?? 0) ||
              (left.atRange?.endCol ?? 0) - (right.atRange?.endCol ?? 0),
          );
      const expected = [
        { calledName: 'same', atRange: { startLine: 2, startCol: 2, endLine: 2, endCol: 8 } },
        { calledName: 'same', atRange: { startLine: 2, startCol: 10, endLine: 2, endCol: 16 } },
        { calledName: 'outer', atRange: { startLine: 3, startCol: 2, endLine: 3, endCol: 16 } },
        { calledName: 'inner', atRange: { startLine: 3, startCol: 8, endLine: 3, endCol: 15 } },
        { calledName: 'lookup', atRange: { startLine: 4, startCol: 2, endLine: 4, endCol: 14 } },
        { calledName: 'save', atRange: { startLine: 4, startCol: 2, endLine: 4, endCol: 21 } },
        { calledName: 'same', atRange: { startLine: 5, startCol: 2, endLine: 7, endCol: 3 } },
        { calledName: 'inner', atRange: { startLine: 6, startCol: 4, endLine: 6, endCol: 11 } },
      ];
      expect(identities(result.data.calls)).toEqual(expected);
      expect(identities(calls)).toEqual(expected);
      const parsedFile = result.data.parsedFiles.find((file) => file.filePath === filePath);
      expect(parsedFile).toBeDefined();
      expect(
        identities(
          parsedFile!.referenceSites
            .filter((site) => site.kind === 'call')
            .map(({ name, atRange }) => ({ filePath, sourceId: '', calledName: name, atRange })),
        ),
      ).toEqual(expected);
      expect(
        result.data.calls.find((call) => call.calledName === 'save')?.receiverMixedChain,
      ).toEqual([{ kind: 'call', name: 'lookup', atRange: expected[4]!.atRange }]);
    },
  );
});
