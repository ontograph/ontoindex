import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  identity: 'A',
  dbClose: vi.fn(async () => {}),
  connClose: vi.fn(async () => {}),
  query: vi.fn(),
  opens: vi.fn(),
  releasePin: vi.fn(async () => {}),
  construct: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  acquireIndexGenerationPin: async (dbPath: string) => ({ dbPath, release: mocks.releasePin }),
}));

vi.mock('fs/promises', () => ({
  default: {
    realpath: async () =>
      mocks.realpath.getMockImplementation() ? mocks.realpath() : mocks.identity,
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
      constructor() {
        mocks.construct();
      }
      query = mocks.query;
      close = mocks.connClose;
    },
  },
}));

import {
  closeLbug,
  executeQuery,
  initLbug,
  initLbugWithDb,
  isLbugDbPathReady,
} from '../../src/core/lbug/pool-adapter.js';

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
      mocks.connClose.mockResolvedValue(undefined);
      mocks.dbClose.mockResolvedValue(undefined);
      mocks.releasePin.mockResolvedValue(undefined);
      await closeLbug();
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

  it('awaits timeout retirement before database close and retains a stalled close', async () => {
    vi.useFakeTimers();
    mocks.query.mockImplementation(async () => result());
    await initLbug('lifecycle', '/db');
    const active = deferred();
    mocks.query.mockImplementationOnce(() => active.promise);
    const query = track(executeQuery('lifecycle', 'RETURN 1'));
    const timeout = expect(query).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await timeout;
    const nativeClose = deferred();
    mocks.connClose.mockImplementationOnce(async () => {
      await nativeClose.promise;
    });
    active.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const closing = track(closeLbug('lifecycle'));
    const stalled = expect(closing).rejects.toThrow('Timed out waiting');
    await vi.advanceTimersByTimeAsync(10_000);
    await stalled;
    expect(mocks.dbClose).not.toHaveBeenCalled();
    expect(isLbugDbPathReady('/db')).toBe(true);
    nativeClose.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await closeLbug('lifecycle');
    expect(mocks.connClose).toHaveBeenCalledTimes(2);
    expect(mocks.dbClose).toHaveBeenCalledTimes(1);
  });

  it('retains a rejected retirement handle and blocks aliases until explicit cleanup', async () => {
    vi.useFakeTimers();
    mocks.query.mockImplementation(async () => result());
    await initLbug('lifecycle', '/db');
    const active = deferred();
    mocks.query.mockImplementationOnce(() => active.promise);
    const query = track(executeQuery('lifecycle', 'RETURN 1'));
    const timeout = expect(query).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await timeout;
    mocks.connClose.mockRejectedValue(new Error('retired close failed'));
    active.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(initLbug('alias', '/db')).rejects.toThrow('database is closing');
    await expect(closeLbug('lifecycle')).rejects.toThrow('retired close failed');
    expect(mocks.dbClose).not.toHaveBeenCalled();
    mocks.connClose.mockResolvedValue(undefined);
    await closeLbug('lifecycle');
    expect(mocks.dbClose).toHaveBeenCalledTimes(1);
  });

  it('awaits partial-construction cleanup before initialization rejects', async () => {
    mocks.query.mockImplementation(async () => result());
    mocks.construct
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('construction failed');
      });
    const nativeClose = deferred();
    mocks.connClose.mockImplementation(async () => {
      await nativeClose.promise;
    });
    const opening = track(initLbug('lifecycle', '/db'));
    const rejected = expect(opening).rejects.toThrow('construction failed');
    await vi.waitFor(() => expect(mocks.connClose).toHaveBeenCalledTimes(1));
    expect(mocks.dbClose).not.toHaveBeenCalled();
    await expect(initLbug('alias', '/db')).rejects.toThrow('database is closing');
    nativeClose.resolve();
    await rejected;
    expect(mocks.dbClose).toHaveBeenCalledTimes(1);
    expect(isLbugDbPathReady('/db')).toBe(false);
  });

  it.each(['connection', 'database', 'pin'])(
    'retains failed initialization %s cleanup for retry',
    async (stage) => {
      mocks.query.mockImplementation(async () => result());
      mocks.construct
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error('construction failed');
        });
      const closer =
        stage === 'connection'
          ? mocks.connClose
          : stage === 'database'
            ? mocks.dbClose
            : mocks.releasePin;
      closer.mockRejectedValue(new Error(`${stage} failed`));
      await expect(initLbug('lifecycle', '/db')).rejects.toThrow(`${stage} failed`);
      expect(isLbugDbPathReady('/db')).toBe(true);
      const opens = mocks.opens.mock.calls.length;
      await expect(initLbug('lifecycle', '/db')).rejects.toThrow('database is closing');
      expect(mocks.opens).toHaveBeenCalledTimes(opens);
      closer.mockResolvedValue(undefined);
      await Promise.all([closeLbug('lifecycle'), closeLbug('lifecycle')]);
      expect(isLbugDbPathReady('/db')).toBe(false);
      expect(mocks.dbClose).toHaveBeenCalledTimes(stage === 'database' ? 2 : 1);
      expect(mocks.releasePin).toHaveBeenCalledTimes(stage === 'pin' ? 2 : 1);
    },
  );

  it('closes live aliases and failed initialization references together', async () => {
    mocks.query.mockImplementation(async () => result());
    await initLbug('lifecycle', '/db');
    mocks.construct
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('construction failed');
      });
    mocks.connClose.mockRejectedValue(new Error('connection failed'));
    await expect(initLbug('failed-alias', '/db')).rejects.toThrow('connection failed');
    mocks.connClose.mockResolvedValue(undefined);
    await closeLbug('failed-alias');
    expect(mocks.dbClose).toHaveBeenCalledTimes(1);
    expect(isLbugDbPathReady('/db')).toBe(false);
  });

  it('never closes an externally supplied database after partial construction fails', async () => {
    mocks.construct
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('construction failed');
      });
    mocks.connClose.mockRejectedValue(new Error('connection failed'));
    const db = { close: mocks.dbClose } as any;
    await expect(initLbugWithDb('external', db, '/external')).rejects.toThrow('connection failed');
    mocks.connClose.mockResolvedValue(undefined);
    await closeLbug();
    expect(mocks.dbClose).not.toHaveBeenCalled();
    expect(mocks.releasePin).not.toHaveBeenCalled();
    expect(isLbugDbPathReady('/external')).toBe(false);
  });

  it('blocks alias publication and drains its native reference before close returns', async () => {
    mocks.query.mockImplementation(async () => result());
    await initLbug('lifecycle', '/db');
    const publication = deferred();
    mocks.realpath.mockImplementationOnce(async () => {
      await publication.promise;
      return 'A';
    });
    const alias = track(initLbug('pending-alias', '/db'));
    const rejected = expect(alias).rejects.toThrow('database is closing');
    await vi.waitFor(() => expect(mocks.realpath).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = track(
      closeLbug('lifecycle').then(() => {
        closed = true;
      }),
    );
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(mocks.dbClose).not.toHaveBeenCalled();
    publication.resolve();
    await rejected;
    await closing;
    expect(mocks.connClose).toHaveBeenCalledTimes(4);
    expect(mocks.dbClose).toHaveBeenCalledTimes(1);
    expect(isLbugDbPathReady('/db')).toBe(false);
  });

  it('bounds initialization drain and retains handles until a later retry', async () => {
    vi.useFakeTimers();
    mocks.query.mockImplementation(async () => result());
    await initLbug('lifecycle', '/db');
    const publication = deferred();
    mocks.realpath.mockImplementationOnce(async () => {
      await publication.promise;
      return 'A';
    });
    const unrelated = track(initLbug('unrelated', '/other-db'));
    await vi.advanceTimersByTimeAsync(0);
    const closing = track(closeLbug('lifecycle'));
    const timeout = expect(closing).rejects.toThrow('Pool initialization drain timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await timeout;
    expect(isLbugDbPathReady('/db')).toBe(true);
    expect(mocks.dbClose).not.toHaveBeenCalled();
    publication.resolve();
    await unrelated;
    await closeLbug('lifecycle');
    expect(isLbugDbPathReady('/db')).toBe(false);
    expect(isLbugDbPathReady('/other-db')).toBe(true);
  });
});
