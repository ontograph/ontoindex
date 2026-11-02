import { describe, expect, it, vi } from 'vitest';
import type {
  WorkerIncomingMessage,
  WorkerOutgoingMessage,
} from '../../src/core/ingestion/workers/parse-types.js';

const port = vi.hoisted(() => ({ on: vi.fn(), postMessage: vi.fn() }));

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  parentPort: port,
}));

async function parseFile(path: string, content: string) {
  port.postMessage.mockClear();
  await import('../../src/core/ingestion/workers/parse-worker.js');
  const handler = port.on.mock.calls.find(([event]) => event === 'message')?.[1] as
    | ((message: WorkerIncomingMessage) => Promise<void>)
    | undefined;
  expect(handler).toBeDefined();
  await handler!([{ path, content }]);
  const messages = port.postMessage.mock.calls.map(([message]) => message as WorkerOutgoingMessage);
  expect(messages.filter((message) => message.type === 'error')).toEqual([]);
  const result = messages.find((message) => message.type === 'result');
  if (result?.type !== 'result' || !result.data) {
    throw new Error('Worker did not return parsed field metadata');
  }
  return result.data.symbols.filter((symbol) => symbol.type === 'Property');
}

describe('source parse-worker field metadata', () => {
  it('preserves constructor property types separately for each TypeScript owner', async () => {
    const filePath = 'src/constructor-fields.ts';
    const properties = await parseFile(
      filePath,
      `
class Store {
  untyped;
  constructor(public service: Service, ordinary: Ignored) {}
}
class OtherStore {
  constructor(public service: OtherService) {}
}
`,
    );
    expect(
      properties.map(({ name, ownerId, declaredType }) => ({ name, ownerId, declaredType })),
    ).toEqual(
      expect.arrayContaining([
        { name: 'service', ownerId: `Class:${filePath}:Store`, declaredType: 'Service' },
        { name: 'service', ownerId: `Class:${filePath}:OtherStore`, declaredType: 'OtherService' },
        { name: 'untyped', ownerId: `Class:${filePath}:Store`, declaredType: undefined },
      ]),
    );
    expect(properties).toHaveLength(3);
    expect(properties.filter(({ name }) => name === 'service').map(({ nodeId }) => nodeId)).toEqual(
      expect.arrayContaining([
        `Property:${filePath}:Store.service`,
        `Property:${filePath}:OtherStore.service`,
      ]),
    );
    expect(properties.find(({ name }) => name === 'untyped')).not.toHaveProperty('declaredType');
  });

  it('preserves the declared type and struct owner of a Go field', async () => {
    const filePath = 'src/struct-fields.go';
    const properties = await parseFile(
      filePath,
      `
package example
type Store struct {
  Service *Service
}
`,
    );
    expect(properties).toEqual([
      expect.objectContaining({
        name: 'Service',
        ownerId: `Struct:${filePath}:Store`,
        declaredType: 'Service',
      }),
    ]);
  });

  it('preserves PHP promoted property types without promoting ordinary parameters', async () => {
    const filePath = 'src/promoted-fields.php';
    const properties = await parseFile(
      filePath,
      `<?php
class Store {
  public $untyped;
  public function __construct(public Service $service, Ignored $ordinary) {}
}
`,
    );
    expect(
      properties.map(({ name, ownerId, declaredType }) => ({ name, ownerId, declaredType })),
    ).toEqual(
      expect.arrayContaining([
        { name: 'service', ownerId: `Class:${filePath}:Store`, declaredType: 'Service' },
        { name: 'untyped', ownerId: `Class:${filePath}:Store`, declaredType: undefined },
      ]),
    );
    expect(properties).toHaveLength(2);
    expect(properties.find(({ name }) => name === 'untyped')).not.toHaveProperty('declaredType');
  });

  it('preserves Ruby YARD accessor types while leaving an unannotated accessor untyped', async () => {
    const filePath = 'src/accessor-fields.rb';
    const properties = await parseFile(
      filePath,
      `
class Store
  # @return [Service]
  attr_accessor :service
  attr_accessor :untyped
end
`,
    );
    expect(
      properties.map(({ name, ownerId, declaredType }) => ({ name, ownerId, declaredType })),
    ).toEqual(
      expect.arrayContaining([
        { name: 'service', ownerId: `Class:${filePath}:Store`, declaredType: 'Service' },
        { name: 'untyped', ownerId: `Class:${filePath}:Store`, declaredType: undefined },
      ]),
    );
    expect(properties).toHaveLength(2);
    expect(properties.find(({ name }) => name === 'untyped')).not.toHaveProperty('declaredType');
  });
});
