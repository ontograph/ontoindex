import path from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({
  connections: [] as { query: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[],
  databases: [] as { close: ReturnType<typeof vi.fn> }[],
  pins: [] as ReturnType<typeof vi.fn>[],
}));
const physical = path.resolve('/tmp/retirement/generation.lbug');
const alias = path.resolve('/tmp/retirement/lbug');
const other = path.resolve('/tmp/retirement/other.lbug');

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(function () {
      const database = { close: vi.fn().mockResolvedValue(undefined) };
      state.databases.push(database);
      return database;
    }),
    Connection: vi.fn(function () {
      const connection = {
        query: vi.fn().mockResolvedValue({ getAll: async () => [], close: vi.fn() }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      state.connections.push(connection);
      return connection;
    }),
  },
}));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      lstat: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      mkdir: vi.fn().mockResolvedValue(undefined),
      access: vi.fn().mockRejectedValue(new Error('missing extension')),
      realpath: vi.fn(async (value: string) => (value === alias ? physical : value)),
    },
  };
});
vi.mock('../../src/storage/repo-manager.js', () => ({
  acquireIndexGenerationPin: vi.fn(async (value: string) => {
    const release = vi.fn().mockResolvedValue(undefined);
    state.pins.push(release);
    return { dbPath: value === alias ? physical : value, release };
  }),
}));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const never = () => new Promise<never>(() => {});

describe('retired native ownership', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    state.connections.length = 0;
    state.databases.length = 0;
    state.pins.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it.each(['query', 'getAll'])(
    'blocks pending %s retirement paths, retains the pin, and recovers',
    async (stage) => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.initLbug(alias);
      const connectionClose = deferred();
      const databaseClose = deferred();
      state.connections[0].close.mockReturnValue(connectionClose.promise);
      state.databases[0].close.mockReturnValue(databaseClose.promise);
      state.connections[0].query.mockImplementationOnce(() =>
        stage === 'query' ? never() : { getAll: never, close: vi.fn() },
      );
      const assertion = expect(adapter.executeQuery('RETURN 1')).rejects.toThrow(
        'timed out after 30000ms',
      );
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
      for (const value of [physical, alias]) {
        await expect(adapter.closeLbugForPath(value, { strict: true })).rejects.toThrow(
          'native close',
        );
        await expect(adapter.initLbug(value)).rejects.toThrow('native close');
      }
      await adapter.closeLbugForPath(other, { strict: true });
      await adapter.initLbug(other);
      connectionClose.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.databases[0].close).toHaveBeenCalledOnce();
      expect(state.pins[0]).not.toHaveBeenCalled();
      await expect(adapter.closeLbugForPath(alias, { strict: true })).rejects.toThrow(
        'native close',
      );
      databaseClose.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.pins[0]).toHaveBeenCalledOnce();
      expect(state.pins[1]).not.toHaveBeenCalled();
      expect(state.connections[1].close).not.toHaveBeenCalled();
      await adapter.closeLbugForPath(alias, { strict: true });
      expect(adapter.isLbugReady()).toBe(true);
      await adapter.initLbug(alias);
      expect(state.databases).toHaveLength(3);
      await adapter.closeLbug({ strict: true });
    },
  );

  it.each(['connection', 'database', 'pin'])(
    'retains quarantine after %s teardown fails',
    async (failure) => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.initLbug(alias);
      const error = new Error('injected teardown failure');
      if (failure === 'connection') state.connections[0].close.mockRejectedValue(error);
      if (failure === 'database') state.databases[0].close.mockRejectedValue(error);
      if (failure === 'pin') state.pins[0].mockRejectedValue(error);
      state.connections[0].query.mockReturnValueOnce(never());
      const assertion = expect(adapter.executeQuery('RETURN 1')).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
      expect(state.databases[0].close).toHaveBeenCalledOnce();
      expect(state.pins[0]).toHaveBeenCalledTimes(failure === 'pin' ? 1 : 0);
      for (const value of [physical, alias]) {
        await expect(adapter.closeLbugForPath(value, { strict: true })).rejects.toThrow(
          'native close',
        );
        await expect(adapter.initLbug(value)).rejects.toThrow('native close');
      }
      await adapter.initLbug(other);
      await adapter.closeLbug({ strict: true });
      await expect(adapter.closeLbugForPath(alias, { strict: true })).rejects.toThrow(
        'native close',
      );
    },
  );

  it('an older concurrent timeout leaves the replacement session intact', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(alias);
    const oldClose = deferred();
    state.connections[0].close.mockReturnValue(oldClose.promise);
    state.connections[0].query.mockImplementation(never);
    const first = expect(adapter.executeQuery('RETURN 1')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1_000);
    const second = expect(adapter.executeQuery('RETURN 2')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(29_001);
    await first;
    await adapter.initLbug(other);
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
    expect(adapter.isLbugReady()).toBe(true);
    expect(state.connections[1].close).not.toHaveBeenCalled();
    expect(state.pins[1]).not.toHaveBeenCalled();
    oldClose.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await adapter.closeLbug({ strict: true });
  });

  it('successful retirement removes only its captured record', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const closes = [deferred(), deferred()];
    for (const [index, value] of [alias, other].entries()) {
      await adapter.initLbug(value);
      state.connections[index].close.mockReturnValue(closes[index].promise);
      state.connections[index].query.mockReturnValueOnce(never());
      const assertion = expect(adapter.executeQuery('RETURN 1')).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    }
    closes[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    await adapter.closeLbugForPath(alias, { strict: true });
    await expect(adapter.closeLbugForPath(other, { strict: true })).rejects.toThrow('native close');
    expect(state.pins[1]).not.toHaveBeenCalled();
    closes[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    await adapter.closeLbugForPath(other, { strict: true });
  });
});
