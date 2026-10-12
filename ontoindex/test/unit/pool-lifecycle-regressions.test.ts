import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  identity: 'A',
  dbClose: vi.fn(async () => {}),
  connClose: vi.fn(async () => {}),
  query: vi.fn(),
  opens: vi.fn(),
  releasePin: vi.fn(async () => {}),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  acquireIndexGenerationPin: async (dbPath: string) => ({ dbPath, release: mocks.releasePin }),
}));

vi.mock('fs/promises', () => ({
  default: {
    realpath: async () => mocks.identity,
    stat: async () => ({ ino: 1, size: 1, mtimeMs: 1 }),
  },
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  resolveLocalLbugExtensionPath: async () => null,
}));
vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: class {
      constructor() {
        mocks.opens();
      }
      close = mocks.dbClose;
    },
    Connection: class {
      query = mocks.query;
      close = mocks.connClose;
    },
  },
}));

import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/pool-adapter.js';

const result = () => ({ getAll: async () => [], close: async () => {} });
const releases: Array<() => void> = [];
const pendingTasks: Promise<unknown>[] = [];

function track<T>(promise: Promise<T>): Promise<T> {
  pendingTasks.push(promise);
  // Observe rejection immediately even if an assertion interrupts the test.
  void promise.catch(() => {});
  return promise;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<ReturnType<typeof result>>((done) => {
    resolve = () => done(result());
  });
  releases.push(resolve);
  return { promise, resolve };
}

describe('pool lifecycle drain', () => {
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    vi.useRealTimers();
    try {
      await Promise.allSettled(pendingTasks.splice(0));
      await closeLbug('lifecycle');
    } finally {
      vi.resetAllMocks();
      mocks.dbClose.mockResolvedValue(undefined);
      mocks.connClose.mockResolvedValue(undefined);
      mocks.releasePin.mockResolvedValue(undefined);
      mocks.identity = 'A';
    }
  });

  it('awaits native connection, database and pin closure and deduplicates concurrent closes', async () => {
    mocks.query.mockImplementation(async () => result());
    await initLbug('lifecycle', '/db');
    const connection = deferred();
    const database = deferred();
    const pin = deferred();
    mocks.connClose.mockImplementation(async () => {
      await connection.promise;
    });
    mocks.dbClose.mockImplementation(async () => {
      await database.promise;
    });
    mocks.releasePin.mockImplementation(async () => {
      await pin.promise;
    });
    let done = false;
    const closing = track(
      closeLbug('lifecycle').then(() => {
        done = true;
      }),
    );
    const duplicate = track(closeLbug('lifecycle'));
    await vi.waitFor(() => expect(mocks.connClose).toHaveBeenCalledTimes(2));
    expect(mocks.dbClose).not.toHaveBeenCalled();
    connection.resolve();
    await vi.waitFor(() => expect(mocks.dbClose).toHaveBeenCalledTimes(1));
    expect(mocks.releasePin).not.toHaveBeenCalled();
    mocks.releasePin.mockImplementationOnce(async () => {});
    await expect(initLbug('lifecycle-new-alias', '/db')).rejects.toThrow('database is closing');
    expect(mocks.opens).toHaveBeenCalledTimes(1);
    database.resolve();
    await vi.waitFor(() => expect(mocks.releasePin).toHaveBeenCalledTimes(2));
    expect(done).toBe(false);
    pin.resolve();
    await Promise.all([closing, duplicate]);
    expect(done).toBe(true);
    expect(mocks.dbClose).toHaveBeenCalledTimes(1);
  });

  it.each(['connection', 'database', 'pin'])(
    'propagates %s close failures and permits retry',
    async (stage) => {
      mocks.query.mockImplementation(async () => result());
      await initLbug('lifecycle', '/db');
      const failure = new Error(`${stage} close failed`);
      const close =
        stage === 'connection'
          ? mocks.connClose
          : stage === 'database'
            ? mocks.dbClose
            : mocks.releasePin;
      close.mockRejectedValueOnce(failure);
      await expect(closeLbug('lifecycle')).rejects.toThrow(failure);
      if (stage === 'connection') expect(mocks.dbClose).not.toHaveBeenCalled();
      if (stage !== 'pin') expect(mocks.releasePin).not.toHaveBeenCalled();
      await closeLbug('lifecycle');
      expect(mocks.releasePin).toHaveBeenCalledTimes(stage === 'pin' ? 2 : 1);
    },
  );

  it('closes all aliases of the same native database before resolving', async () => {
    mocks.query.mockImplementation(async () => result());
    await initLbug('lifecycle', '/db');
    await initLbug('lifecycle-alias', '/db');
    expect(mocks.opens).toHaveBeenCalledTimes(1);
    await closeLbug('lifecycle');
    expect(mocks.connClose).toHaveBeenCalledTimes(4);
    expect(mocks.dbClose).toHaveBeenCalledTimes(1);
  });

  it('deduplicates generation replacement and drains the active query before destruction', async () => {
    mocks.query.mockImplementation(async () => result());
    await initLbug('lifecycle', '/db');
    const active = deferred();
    mocks.query.mockImplementation((text: string) =>
      text === 'RETURN 1' ? active.promise : Promise.resolve(result()),
    );
    const query = track(executeQuery('lifecycle', 'RETURN 1'));
    await Promise.resolve();
    mocks.identity = 'B';
    const replacement = track(initLbug('lifecycle', '/db'));
    const duplicate = track(initLbug('lifecycle', '/db'));
    await vi.waitFor(() => expect(mocks.opens).toHaveBeenCalledTimes(1));
    expect(mocks.dbClose).not.toHaveBeenCalled();
    active.resolve();
    await Promise.all([query, replacement, duplicate]);
    expect(mocks.opens).toHaveBeenCalledTimes(2);
    expect(mocks.dbClose).toHaveBeenCalledTimes(1);
  });

  it('retains returned connections when close times out and permits a later close', async () => {
    vi.useFakeTimers();
    mocks.query.mockImplementation(async () => result());
    await initLbug('lifecycle', '/db');
    const first = deferred();
    const second = deferred();
    mocks.query
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const queries = [
      track(executeQuery('lifecycle', 'RETURN 1')),
      track(executeQuery('lifecycle', 'RETURN 2')),
    ];
    await Promise.resolve();
    const closing = track(closeLbug('lifecycle'));
    const rejected = track(expect(closing).rejects.toThrow('Timed out waiting'));
    first.resolve();
    await queries[0];
    expect(mocks.connClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    second.resolve();
    await queries[1];
    mocks.query.mockImplementation(async () => result());
    await Promise.all([
      executeQuery('lifecycle', 'RETURN 3'),
      executeQuery('lifecycle', 'RETURN 4'),
    ]);
    expect(mocks.dbClose).not.toHaveBeenCalled();
    await closeLbug('lifecycle');
    expect(mocks.connClose).toHaveBeenCalledTimes(2);
    expect(mocks.dbClose).toHaveBeenCalledTimes(1);
  });
});
