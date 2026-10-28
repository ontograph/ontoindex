import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalSetupContext } from 'vitest/node';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  database: vi.fn(),
  connection: vi.fn(),
  dbClose: vi.fn(),
  connClose: vi.fn(),
  resultClose: vi.fn(),
  query: vi.fn(),
  setQueryTimeout: vi.fn(),
  cleanup: vi.fn(),
  createTempDir: vi.fn(),
  resolveLocalLbugExtensionPath: vi.fn(),
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: class {
      constructor() {
        mocks.database();
      }
      close = mocks.dbClose;
    },
    Connection: class {
      constructor() {
        mocks.connection();
      }
      query = mocks.query;
      close = mocks.connClose;
      setQueryTimeout = mocks.setQueryTimeout;
    },
  },
}));
vi.mock('../helpers/test-db.js', () => ({ createTempDir: mocks.createTempDir }));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  resolveLocalLbugExtensionPath: mocks.resolveLocalLbugExtensionPath,
}));
vi.mock('../../src/core/lbug/schema.js', () => ({
  NODE_SCHEMA_QUERIES: ['node schema'],
  REL_SCHEMA_QUERIES: ['rel schema'],
  EMBEDDING_SCHEMA: 'embedding schema',
}));

import setup from '../global-setup.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('global setup lifecycle', () => {
  const provide = vi.fn();
  const context = { provide } as unknown as GlobalSetupContext;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.events.length = 0;
    vi.stubEnv('ONTOINDEX_TEST_FTS_SETUP_TIMEOUT_MS', '10');
    mocks.createTempDir.mockResolvedValue({ dbPath: '/tmp/shared-setup', cleanup: mocks.cleanup });
    mocks.resolveLocalLbugExtensionPath.mockResolvedValue(null);
    mocks.query.mockImplementation(async (query: string) => {
      mocks.events.push(`query:${query}`);
      return { close: mocks.resultClose };
    });
    mocks.resultClose.mockImplementation(async () => {
      mocks.events.push('result:closed');
    });
    mocks.connClose.mockImplementation(async () => {
      mocks.events.push('connection:closed');
    });
    mocks.dbClose.mockImplementation(async () => {
      mocks.events.push('database:closed');
    });
    mocks.cleanup.mockImplementation(async () => {
      mocks.events.push('directory:removed');
    });
    provide.mockImplementation(() => {
      mocks.events.push('provided');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('loads an escaped local FTS path offline, closes results and publishes only after close', async () => {
    mocks.resolveLocalLbugExtensionPath.mockResolvedValue("/tmp/onto'index/libfts.lbug_extension");
    const teardown = await setup(context);

    expect(mocks.resolveLocalLbugExtensionPath).toHaveBeenCalledExactlyOnceWith('fts');
    expect(mocks.setQueryTimeout).toHaveBeenCalledExactlyOnceWith(10);
    expect(mocks.query.mock.calls.map(([query]) => query)).toEqual([
      'node schema',
      'rel schema',
      'embedding schema',
      "LOAD EXTENSION '/tmp/onto\\'index/libfts.lbug_extension'",
    ]);
    expect(mocks.resultClose).toHaveBeenCalledTimes(4);
    expect(mocks.events.slice(-3)).toEqual(['connection:closed', 'database:closed', 'provided']);
    expect(provide).toHaveBeenCalledExactlyOnceWith('lbugDbPath', '/tmp/shared-setup/lbug');
    expect(mocks.cleanup).not.toHaveBeenCalled();
    await teardown();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it('falls back to the bare local load only when the resolved extension is absent', async () => {
    mocks.resolveLocalLbugExtensionPath.mockResolvedValue('/tmp/missing/libfts.lbug_extension');
    const query = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.startsWith("LOAD EXTENSION '")) throw new Error('extension fts not found');
      return query(statement);
    });
    await setup(context);
    expect(mocks.query.mock.calls.slice(-2).map(([statement]) => statement)).toEqual([
      "LOAD EXTENSION '/tmp/missing/libfts.lbug_extension'",
      'LOAD EXTENSION fts',
    ]);
  });

  it('classifies missing FTS as optional, with an explicit FTS-required acceptance diagnostic', async () => {
    const unavailable = new Error(
      'Extension: fts is an official extension and has not been installed.',
    );
    const query = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement === 'LOAD EXTENSION fts') throw unavailable;
      return query(statement);
    });
    await setup(context);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/optional FTS unavailable.*FTS-required acceptance/),
      unavailable,
    );
    expect(provide).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.some(([query]) => /INSTALL/i.test(query))).toBe(false);
  });

  it.each(['node schema', 'LOAD EXTENSION fts', "LOAD EXTENSION '/tmp/libfts.lbug_extension'"])(
    'preserves a fatal query error and cleans up: %s',
    async (failedStatement) => {
      if (failedStatement.includes("'/tmp/"))
        mocks.resolveLocalLbugExtensionPath.mockResolvedValue('/tmp/libfts.lbug_extension');
      const failure = new Error('Runtime exception: Interrupted.');
      const query = mocks.query.getMockImplementation()!;
      mocks.query.mockImplementation(async (statement: string) => {
        if (statement === failedStatement) throw failure;
        return query(statement);
      });
      await expect(setup(context)).rejects.toBe(failure);
      expect(provide).not.toHaveBeenCalled();
      expect(mocks.events.slice(-3)).toEqual([
        'connection:closed',
        'database:closed',
        'directory:removed',
      ]);
      if (failedStatement.includes("'/tmp/")) {
        expect(mocks.query).not.toHaveBeenCalledWith('LOAD EXTENSION fts');
      }
    },
  );

  it('waits for a delayed native query rejection before closing or publishing', async () => {
    vi.useFakeTimers();
    const pending = deferred<never>();
    const failure = new Error('Runtime exception: Interrupted.');
    const query = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation((statement: string) =>
      statement === 'LOAD EXTENSION fts' ? pending.promise : query(statement),
    );
    const setupPromise = setup(context);
    const assertion = expect(setupPromise).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.query).toHaveBeenCalledWith('LOAD EXTENSION fts');
    expect(mocks.connClose).not.toHaveBeenCalled();
    expect(mocks.dbClose).not.toHaveBeenCalled();
    expect(provide).not.toHaveBeenCalled();
    pending.reject(failure);
    await assertion;
    expect(mocks.events.slice(-3)).toEqual([
      'connection:closed',
      'database:closed',
      'directory:removed',
    ]);
  });

  it('waits for each close to settle before the next resource or path publication', async () => {
    const connectionClose = deferred<void>();
    const databaseClose = deferred<void>();
    mocks.connClose.mockReturnValue(connectionClose.promise);
    mocks.dbClose.mockReturnValue(databaseClose.promise);
    const setupPromise = setup(context);
    await vi.waitFor(() => expect(mocks.connClose).toHaveBeenCalledOnce());
    expect(mocks.dbClose).not.toHaveBeenCalled();
    expect(provide).not.toHaveBeenCalled();
    connectionClose.resolve();
    await vi.waitFor(() => expect(mocks.dbClose).toHaveBeenCalledOnce());
    expect(provide).not.toHaveBeenCalled();
    databaseClose.resolve();
    await setupPromise;
    expect(provide).toHaveBeenCalledOnce();
  });

  it('closes all query results even when one close fails', async () => {
    const failure = new Error('result close failed');
    const first = vi.fn().mockRejectedValue(failure);
    const second = vi.fn().mockResolvedValue(undefined);
    mocks.query.mockResolvedValueOnce([{ close: first }, { close: second }]);
    await expect(setup(context)).rejects.toBe(failure);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(mocks.connClose).toHaveBeenCalledOnce();
    expect(mocks.dbClose).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(provide).not.toHaveBeenCalled();
  });

  it('retains the primary query failure and all cleanup failures in order', async () => {
    const failures = ['query', 'connection', 'database', 'directory'].map(
      (name) => new Error(`${name} failed`),
    );
    mocks.query.mockRejectedValueOnce(failures[0]);
    mocks.connClose.mockRejectedValueOnce(failures[1]);
    mocks.dbClose.mockRejectedValueOnce(failures[2]);
    mocks.cleanup.mockRejectedValueOnce(failures[3]);
    const failure = await setup(context).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual(failures);
    expect(failure.cause).toBe(failures[0]);
    expect(provide).not.toHaveBeenCalled();
  });

  it('cleans the directory after construction or publication fails', async () => {
    const constructionFailure = new Error('connection construction failed');
    mocks.connection.mockImplementationOnce(() => {
      throw constructionFailure;
    });
    await expect(setup(context)).rejects.toBe(constructionFailure);
    expect(mocks.dbClose).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    const publicationFailure = new Error('provide failed');
    provide.mockImplementationOnce(() => {
      throw publicationFailure;
    });
    await expect(setup(context)).rejects.toBe(publicationFailure);
    expect(mocks.cleanup).toHaveBeenCalledTimes(2);
  });

  it.each(['', '0', '-1', 'NaN', 'Infinity', '1.5', '10ms'])(
    'rejects invalid native timeouts before allocation: %s',
    async (value) => {
      vi.stubEnv('ONTOINDEX_TEST_FTS_SETUP_TIMEOUT_MS', value);
      await expect(setup(context)).rejects.toThrow(
        /ONTOINDEX_TEST_FTS_SETUP_TIMEOUT_MS must be a positive integer/,
      );
      expect(mocks.createTempDir).not.toHaveBeenCalled();
      expect(mocks.database).not.toHaveBeenCalled();
      expect(provide).not.toHaveBeenCalled();
    },
  );
});

it.skipIf(process.platform !== 'linux')(
  'installed native timeout settles, closes in order and exits naturally',
  () => {
    const require = createRequire(import.meta.url);
    const driverPath = require.resolve('@ladybugdb/core');
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const lbug = require(${JSON.stringify(driverPath)});
    const db = new lbug.Database(':memory:', 64 * 1024 * 1024);
    const conn = new lbug.Connection(db, 1);
    try {
      const result = await conn.query('RETURN 1');
      for (const item of Array.isArray(result) ? result : [result]) item.close();
      conn.setQueryTimeout(10);
      let interrupted = false;
      try {
        const result = await conn.query('UNWIND range(1, 100000) AS x UNWIND range(1, 100000) AS y RETURN sum(x * y)');
        for (const item of Array.isArray(result) ? result : [result]) item.close();
      } catch (error) {
        assert.match(error.message, /interrupt|query.*timed? ?out|timeout/i);
        interrupted = true;
        console.log('query:rejected');
      }
      assert.ok(interrupted, 'native query must reject after its timeout');
    } finally {
      try {
        await conn.close();
        console.log('connection:closed');
      } finally {
        await db.close();
        console.log('database:closed');
      }
    }
    console.log('probe:complete');
  `,
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        encoding: 'utf8',
        timeout: 20_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      },
    );

    expect(probe.error, probe.stderr).toBeUndefined();
    expect(probe.signal, probe.stderr).toBeNull();
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim().split(/\r?\n/)).toEqual([
      'query:rejected',
      'connection:closed',
      'database:closed',
      'probe:complete',
    ]);
  },
);
