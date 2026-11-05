import lbug from '@ladybugdb/core';
import { afterAll, expect, it, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

const previousPoolSize = vi.hoisted(() => {
  const previous = process.env.ONTOINDEX_LBUG_POOL_SIZE;
  process.env.ONTOINDEX_LBUG_POOL_SIZE = '1';
  return previous;
});

afterAll(() => {
  if (previousPoolSize === undefined) delete process.env.ONTOINDEX_LBUG_POOL_SIZE;
  else process.env.ONTOINDEX_LBUG_POOL_SIZE = previousPoolSize;
});

withTestLbugDB(
  'native-checkout-recovery',
  (handle) => {
    it('reuses the native connection after a checkout waiter times out', async () => {
      const adapter = await import('../../src/core/lbug/pool-adapter.js');
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const materializing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let firstResult: lbug.QueryResult | undefined;
      const started: Promise<unknown>[] = [];
      const originalGetAll = lbug.QueryResult.prototype.getAll;
      const close = vi.spyOn(lbug.QueryResult.prototype, 'close');
      const getAll = vi
        .spyOn(lbug.QueryResult.prototype, 'getAll')
        .mockImplementationOnce(async function (this: lbug.QueryResult) {
          // Keep the real native connection checked out with a controlled
          // JavaScript materialization delay after the native rows arrive.
          const rows = await originalGetAll.call(this);
          firstResult = this;
          entered();
          await held;
          return rows;
        });

      try {
        const first = adapter.executeQuery(handle.repoId, 'RETURN 101 AS value');
        started.push(first);
        void first.catch(() => {});
        await Promise.race([
          materializing,
          first.then(() => {
            throw new Error('First query finished before entering the materialization barrier');
          }),
        ]);

        const second = adapter.executeQuery(handle.repoId, 'RETURN 102 AS value');
        started.push(second);
        await expect(second).rejects.toMatchObject({ name: 'CheckoutTimeoutError' });

        const parameterizedQuery = 'RETURN $value AS value';
        const third = adapter.executeParameterized(handle.repoId, parameterizedQuery, {
          value: 202,
        });
        started.push(third);
        void third.catch(() => {});
        // Checkout queues synchronously, before releasing the only connection.
        release();
        await expect(first).resolves.toEqual([{ value: 101 }]);
        await expect(third).resolves.toEqual([{ value: 202 }]);

        const later = adapter.executeParameterized(handle.repoId, parameterizedQuery, {
          value: 303,
        });
        started.push(later);
        await expect(later).resolves.toEqual([{ value: 303 }]);
        expect(firstResult).toBeDefined();
        expect(close.mock.contexts.filter((result) => result === firstResult)).toHaveLength(1);
      } finally {
        release();
        await Promise.allSettled(started);
        getAll.mockRestore();
        close.mockRestore();
      }
    }, 45_000);
  },
  { poolAdapter: true },
);
