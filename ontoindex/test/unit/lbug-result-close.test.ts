import lbug from '@ladybugdb/core';
import { describe, expect, it, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

withTestLbugDB('result-close', () => {
  describe('native query-result cleanup', () => {
    it('closes results from query, prepared, reused-statement, and discarded-row paths', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const close = vi.spyOn(lbug.QueryResult.prototype, 'close');

      try {
        await adapter.executeQuery('RETURN 1 AS value');
        expect(close).toHaveBeenCalledTimes(1);

        close.mockClear();
        await adapter.executePrepared('RETURN $value AS value', { value: 2 });
        expect(close).toHaveBeenCalledTimes(1);

        close.mockClear();
        await adapter.executeWithReusedStatement(
          'CREATE (n:File {id: $id, name: $id, filePath: $id, content: $id})',
          [{ id: 'result-close-reused' }],
        );
        expect(close).toHaveBeenCalledTimes(1);

        close.mockClear();
        await adapter.createFTSIndex('Function', 'result_close_test', ['name']);
        expect(close).toHaveBeenCalled();
      } finally {
        close.mockRestore();
      }
    });

    it('closes a result when getAll rejects', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const close = vi.spyOn(lbug.QueryResult.prototype, 'close');
      const getAll = vi
        .spyOn(lbug.QueryResult.prototype, 'getAll')
        .mockRejectedValueOnce(new Error('injected getAll failure'));

      try {
        await expect(adapter.executeQuery('RETURN 1 AS value')).rejects.toThrow(
          'injected getAll failure',
        );
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        getAll.mockRestore();
        close.mockRestore();
      }
    });
  });
});
