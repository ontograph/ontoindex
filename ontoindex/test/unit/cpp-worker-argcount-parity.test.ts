import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages, type GraphNode } from 'ontoindex-shared';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import {
  processCalls,
  processCallsFromExtracted,
} from '../../src/core/ingestion/call-processor.js';
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
  it('retains proven Go indexed receiver types in source worker metadata', async () => {
    port.postMessage.mockClear();
    const content = `package main
type User struct {}
func (u User) Save() {}
func (u User) Greet() {}
func caller() {
  sl := make([]User, 1)
  m := make(map[string]User)
  sl[0].Save()
  m["key"].Greet()
  unknown[0].Save()
}
`;
    await import('../../src/core/ingestion/workers/parse-worker.js');
    const handler = port.on.mock.calls.find(([event]) => event === 'message')?.[1] as
      | ((message: WorkerIncomingMessage) => Promise<void>)
      | undefined;
    expect(handler).toBeDefined();
    await handler!([{ path: 'src/indexed.go', content }]);
    const messages = port.postMessage.mock.calls.map(
      ([message]) => message as WorkerOutgoingMessage,
    );
    expect(messages.filter((message) => message.type === 'error')).toEqual([]);
    const result = messages.find((message) => message.type === 'result');
    if (result?.type !== 'result' || !result.data) throw new Error('Missing worker result');
    expect(result.data.calls.filter((call) => ['Save', 'Greet'].includes(call.calledName))).toEqual(
      [
        expect.objectContaining({
          calledName: 'Save',
          callForm: 'member',
          receiverName: 'sl[0]',
          receiverTypeName: 'User',
        }),
        expect.objectContaining({
          calledName: 'Greet',
          callForm: 'member',
          receiverName: 'm["key"]',
          receiverTypeName: 'User',
        }),
        expect.objectContaining({
          calledName: 'Save',
          callForm: 'member',
          receiverName: 'unknown[0]',
        }),
      ],
    );
    expect(
      result.data.calls.find((call) => call.receiverName === 'unknown[0]')?.receiverTypeName,
    ).toBeUndefined();
  });

  it.skipIf(!isLanguageAvailable(SupportedLanguages.Swift)).each([
    {
      name: 'zero argument caller',
      declarations: ['  func caller() { self.save() }'],
      topLevel: false,
    },
    {
      name: 'one argument caller',
      declarations: ['  func caller(_ value: Int) { self.save() }'],
      topLevel: false,
    },
    {
      name: 'same arity caller overloads',
      declarations: [
        '  func caller(_ value: Int) { self.save() }',
        '  func caller(_ value: String) { self.save() }',
      ],
      topLevel: false,
    },
    {
      name: 'top level caller',
      declarations: ['func caller(_ svc: Service) { svc.save() }'],
      topLevel: true,
    },
  ])('retains Swift caller declaration endpoints for $name', async ({ declarations, topLevel }) => {
    port.postMessage.mockClear();
    const filePath = 'src/self.swift';
    const content = [
      'class Service {',
      '  func save() {}',
      ...(topLevel ? [] : declarations),
      '}',
      ...(topLevel ? declarations : []),
    ].join('\n');
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
    if (result?.type !== 'result' || !result.data) throw new Error('Missing worker result');
    const calls = result.data.calls.filter((call) => call.calledName === 'save');
    const callers = result.data.symbols.filter((symbol) => symbol.name === 'caller');
    expect(callers).toHaveLength(declarations.length);
    const callerNodes = callers
      .map((caller) => {
        const node = result.data!.nodes.find((node) => node.id === caller.nodeId);
        expect(node).toBeDefined();
        return node!;
      })
      .sort((left, right) => left.properties.startLine - right.properties.startLine);
    expect(calls).toEqual(
      callerNodes.map((caller) =>
        expect.objectContaining({
          sourceId: caller.id,
          calledName: 'save',
          callForm: 'member',
          receiverName: topLevel ? 'svc' : 'self',
          receiverTypeName: 'Service',
        }),
      ),
    );

    const graph = createKnowledgeGraph();
    const cache = createASTCache();
    const ctx = createResolutionContext();
    try {
      for (const node of result.data.nodes) graph.addNode(node as GraphNode);
      for (const symbol of result.data.symbols) {
        ctx.model.symbols.add(symbol.filePath, symbol.name, symbol.nodeId, symbol.type, {
          ownerId: symbol.ownerId,
          parameterCount: symbol.parameterCount,
          parameterTypes: symbol.parameterTypes,
        });
      }
      await processCalls(graph, [{ path: filePath, content }], cache, ctx);
      const edges = graph.relationships.filter((edge) => edge.type === 'CALLS');
      const target = result.data.symbols.find((symbol) => symbol.name === 'save');
      expect(target).toBeDefined();
      expect(edges.map(({ sourceId, targetId }) => ({ sourceId, targetId }))).toEqual(
        callerNodes.map((caller) => ({ sourceId: caller.id, targetId: target!.nodeId })),
      );
      for (const edge of edges) {
        expect(graph.getNode(edge.sourceId)).toBeDefined();
        expect(graph.getNode(edge.targetId)).toBeDefined();
      }
    } finally {
      cache.clear();
      ctx.clear();
    }
  });

  it.each(['ts', 'tsx'])(
    'preserves unknown generic receivers through worker dispatch in %s',
    async (extension) => {
      port.postMessage.mockClear();
      const filePath = `src/generic.${extension}`;
      const content = `
class Service { save() {} }
function unknown<TItem>(value: TItem) { value.save(); value.child.save(); }
function constrained<TItem extends Service>(value: TItem) { value.save(); }
`;
      await import('../../src/core/ingestion/workers/parse-worker.js');
      const handler = port.on.mock.calls.find(([event]) => event === 'message')?.[1];
      expect(handler).toBeDefined();
      await handler([{ path: filePath, content }]);
      const messages = port.postMessage.mock.calls.map(
        ([message]) => message as WorkerOutgoingMessage,
      );
      expect(messages.filter((message) => message.type === 'error')).toEqual([]);
      const result = messages.find((message) => message.type === 'result');
      if (result?.type !== 'result' || !result.data) throw new Error('Missing worker result');
      const calls = result.data.calls.filter((call) => call.calledName === 'save');
      expect(calls.map((call) => call.receiverTypeName)).toEqual(['unknown', 'unknown', 'Service']);
      const graph = createKnowledgeGraph();
      const ctx = createResolutionContext();
      const ownerId = `Class:${filePath}:Service`;
      const methodId = `Method:${filePath}:save`;
      ctx.model.symbols.add(filePath, 'Service', ownerId, 'Class');
      ctx.model.symbols.add(filePath, 'save', methodId, 'Method', { ownerId });
      try {
        await processCallsFromExtracted(graph, calls, ctx);
        expect(graph.relationships.filter((edge) => edge.type === 'CALLS')).toEqual([
          expect.objectContaining({
            sourceId: `Function:${filePath}:constrained`,
            targetId: methodId,
          }),
        ]);
      } finally {
        ctx.clear();
      }
    },
  );

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
