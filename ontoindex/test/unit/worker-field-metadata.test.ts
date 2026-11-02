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
  it('publishes real constructor properties and direct fields without constructor lookalikes', async () => {
    const properties = await parseFile(
      'src/constructor-publication.ts',
      `class Store {
      direct: Service;
      public /* static async get set * */ constructor(public value: Service, readonly optional?: Service) {}
      static constructor(public fakeStatic: Service) {}
      async constructor(public fakeAsync: Service) {}
      get constructor(public fakeGet: Service) {}
      set constructor(public fakeSet: Service) {}
      *constructor(public fakeGenerator: Service) {}
      update(public fakeOrdinary: Service) {}
    }
    const store = { constructor(public fakeObject: Service) {} };`,
    );
    expect(properties.map(({ name }) => name).sort()).toEqual(['direct', 'optional', 'value']);
  });

  it('publishes readonly-only, optional and default-valued constructor properties', async () => {
    const filePath = 'src/constructor-modifiers.ts';
    const properties = await parseFile(
      filePath,
      `class Store {
      constructor(
        public service: Service,
        private readonly secret: Secret,
        readonly id: string,
        protected fallback: Service = new Service(),
        readonly nickname?: string,
        public optional?: Service,
        ordinary?: Ignored
      ) {}
    }`,
    );
    expect(
      properties.map(({ name, ownerId, declaredType }) => ({ name, ownerId, declaredType })),
    ).toEqual(
      expect.arrayContaining([
        { name: 'service', ownerId: `Class:${filePath}:Store`, declaredType: 'Service' },
        { name: 'secret', ownerId: `Class:${filePath}:Store`, declaredType: 'Secret' },
        { name: 'id', ownerId: `Class:${filePath}:Store`, declaredType: 'string' },
        { name: 'fallback', ownerId: `Class:${filePath}:Store`, declaredType: 'Service' },
        {
          name: 'nickname',
          ownerId: `Class:${filePath}:Store`,
          declaredType: 'string | undefined',
        },
        {
          name: 'optional',
          ownerId: `Class:${filePath}:Store`,
          declaredType: 'Service | undefined',
        },
      ]),
    );
    expect(properties).toHaveLength(6);
  });

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
