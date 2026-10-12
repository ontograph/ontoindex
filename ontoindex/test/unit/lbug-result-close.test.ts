import lbug from '@ladybugdb/core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import {
  createIndexGeneration,
  publishIndexGenerationTransaction,
} from '../../src/storage/repo-manager.js';

withTestLbugDB('result-close', (handle) => {
  describe('native query-result cleanup', () => {
    it('reuses a published lifetime pin without reader writes or retention scans', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.closeLbug({ strict: true });
      const storage = path.join(path.dirname(handle.dbPath), 'published');
      const generation = await createIndexGeneration(storage, 'warm');
      await fs.copyFile(handle.dbPath, generation.lbugPath);
      await fs.writeFile(generation.metaPath, JSON.stringify({ generationId: 'warm' }));
      await fs.writeFile(generation.snapshotPath, '{}');
      await publishIndexGenerationTransaction(storage, generation, async () => {});
      const alias = path.join(storage, 'alias.lbug');
      await fs.symlink('lbug', alias);
      try {
        await adapter.initLbug(alias);
        const write = vi.spyOn(fs, 'writeFile');
        const scan = vi.spyOn(fs, 'readdir');
        try {
          await adapter.withLbugDb(alias, () => adapter.executeQuery('RETURN 1 AS value'));
          await adapter.initLbug(alias);
          expect(write).not.toHaveBeenCalled();
          expect(scan).not.toHaveBeenCalled();
        } finally {
          write.mockRestore();
          scan.mockRestore();
        }
        const next = await createIndexGeneration(storage, 'next');
        await fs.copyFile(handle.dbPath, next.lbugPath);
        await fs.writeFile(next.metaPath, JSON.stringify({ generationId: 'next' }));
        await fs.writeFile(next.snapshotPath, '{}');
        await publishIndexGenerationTransaction(storage, next, async () => {});
        await adapter.initLbug(alias);
        expect(
          (await fs.readdir(path.join(storage, 'generations', 'warm'))).filter((name) =>
            name.startsWith('.reader-'),
          ),
        ).toEqual([]);
        expect(
          (await fs.readdir(path.join(storage, 'generations', 'next'))).filter((name) =>
            name.startsWith('.reader-'),
          ),
        ).toHaveLength(1);
        expect(await adapter.executeQuery('RETURN 2 AS value')).toEqual([{ value: 2 }]);
      } finally {
        await adapter.closeLbug({ strict: true });
        await fs.rm(storage, { recursive: true, force: true });
        await adapter.initLbug(handle.dbPath);
      }
    });
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
