import lbug from '@ladybugdb/core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

withTestLbugDB('result-close', (handle) => {
  describe('native query-result cleanup', () => {
    it('opens a database alias without replacing it or losing stored rows', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.executeQuery(
        "CREATE (n:File {id: 'alias-regression', name: 'alias-regression', filePath: 'alias.ts', content: ''})",
      );
      await adapter.closeLbug({ strict: true });
      const alias = path.join(path.dirname(handle.dbPath), 'alias.lbug');
      await fs.symlink(path.basename(handle.dbPath), alias);
      try {
        await adapter.initLbug(alias);
        expect(
          await adapter.executeQuery("MATCH (n:File {id: 'alias-regression'}) RETURN n.id AS id"),
        ).toEqual([{ id: 'alias-regression' }]);
        expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
        await adapter.initLbug(handle.dbPath);
        await adapter.closeLbugForPath(alias);
        expect(adapter.isLbugReady()).toBe(false);
      } finally {
        await adapter.closeLbug({ strict: true });
        await fs.unlink(alias);
        await adapter.initLbug(handle.dbPath);
      }
    });

    it('rejects dangling and escaping database aliases without deleting them', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const storage = path.dirname(handle.dbPath);
      const nested = path.join(storage, 'alias-storage');
      await fs.mkdir(nested);
      const dangling = path.join(storage, 'dangling.lbug');
      const escaping = path.join(nested, 'escaping.lbug');
      await fs.symlink('missing.lbug', dangling);
      await fs.symlink(handle.dbPath, escaping);
      try {
        await expect(adapter.initLbug(dangling)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(adapter.initLbug(escaping)).rejects.toThrow('outside its storage directory');
        expect((await fs.lstat(dangling)).isSymbolicLink()).toBe(true);
        expect((await fs.lstat(escaping)).isSymbolicLink()).toBe(true);
        expect(await adapter.executeQuery('RETURN 1 AS value')).toEqual([{ value: 1 }]);
      } finally {
        await fs.unlink(dangling);
        await fs.unlink(escaping);
        await fs.rmdir(nested);
      }
    });

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
