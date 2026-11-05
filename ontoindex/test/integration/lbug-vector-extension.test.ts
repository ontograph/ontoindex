/**
 * Integration Tests: Vector extension loading and state reset
 *
 * Tests: loadVectorExtension idempotency, vectorExtensionLoaded reset
 * on closeLbug and busy-retry cleanup paths.
 *
 * Follows existing lbug integration test patterns (lbug-core-adapter,
 * lbug-lock-retry).
 */
import { describe, it, expect } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import {
  CREATE_VECTOR_INDEX_QUERY,
  EMBEDDING_DIMS,
  EMBEDDING_INDEX_NAME,
  EMBEDDING_TABLE_NAME,
} from '../../src/core/lbug/schema.js';

withTestLbugDB('vector-extension', (handle) => {
  describe('loadVectorExtension', () => {
    it('loads the VECTOR extension without error', async () => {
      const { loadVectorExtension } = await import('../../src/core/lbug/lbug-adapter.js');

      // Should resolve without throwing -- idempotent if already loaded by doInitLbug
      await expect(loadVectorExtension()).resolves.toBeUndefined();
    });

    it('is idempotent -- calling twice does not throw', async () => {
      const { loadVectorExtension } = await import('../../src/core/lbug/lbug-adapter.js');

      await loadVectorExtension();
      await expect(loadVectorExtension()).resolves.toBeUndefined();
    });
  });

  describe('vectorExtensionLoaded reset on closeLbug', () => {
    it('re-initializes vector extension after close + re-init cycle', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      // Ensure vector extension is loaded
      await adapter.loadVectorExtension();

      // Close the adapter -- should reset vectorExtensionLoaded
      await adapter.closeLbug();
      expect(adapter.isLbugReady()).toBe(false);

      // Re-initialize -- doInitLbug calls loadVectorExtension internally
      await adapter.initLbug(handle.dbPath);
      expect(adapter.isLbugReady()).toBe(true);

      // loadVectorExtension should succeed (not skip due to stale flag)
      await expect(adapter.loadVectorExtension()).resolves.toBeUndefined();
    });
  });

  describe('vectorExtensionLoaded reset on busy-retry cleanup', () => {
    it('withLbugDb resets vectorExtensionLoaded on BUSY retry', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      // Ensure vector extension is loaded
      await adapter.loadVectorExtension();

      // Simulate a BUSY error on first attempt, success on second.
      // The retry path should reset vectorExtensionLoaded so the
      // re-initialized DB gets a fresh extension load.
      let callCount = 0;
      const result = await adapter.withLbugDb(handle.dbPath, async () => {
        callCount++;
        if (callCount === 1) throw new Error('database is BUSY');
        return 'recovered';
      });

      expect(result).toBe('recovered');
      expect(callCount).toBe(2);

      // After recovery, vector extension should still be loadable
      // (the flag was reset and re-loaded during re-init)
      await expect(adapter.loadVectorExtension()).resolves.toBeUndefined();
    });
  });

  it('queries a real vector index through the production read-only pool', async (context) => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const localVectorPath = await adapter.resolveLocalLbugExtensionPath('vector');
    if (!localVectorPath) {
      const reason =
        'Optional VECTOR unavailable; network installation is disabled. ' +
        'Pool VECTOR acceptance needs a local libvector.lbug_extension via ONTOINDEX_LADYBUG_EXTENSION_DIR.';
      console.warn(reason);
      context.skip(reason);
      return;
    }

    // Pool queries are read-only: persist the fixture with the writable adapter,
    // then reopen through initLbug so the pool must load VECTOR itself.
    const vector = Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i === 0 ? 1 : 0));
    const vectorLiteral = `CAST([${vector.join(',')}] AS FLOAT[${EMBEDDING_DIMS}])`;
    try {
      await adapter.executeQuery(
        `CREATE (e:${EMBEDDING_TABLE_NAME} {id: 'pool-vector', nodeId: 'function:pool-vector', embedding: ${vectorLiteral}})`,
      );
      await adapter.executeQuery(CREATE_VECTOR_INDEX_QUERY);
      await adapter.closeLbug();

      const pool = await import('../../src/core/lbug/pool-adapter.js');
      try {
        await pool.initLbug(handle.repoId, handle.dbPath);
        const rows = await pool.executeQuery<{ nodeId: string; distance: number }>(
          handle.repoId,
          `CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}', ${vectorLiteral}, 1)
           YIELD node AS emb, distance RETURN emb.nodeId AS nodeId, distance`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].nodeId).toBe('function:pool-vector');
        expect(rows[0].distance).toBeCloseTo(0);
      } finally {
        await pool.closeLbug(handle.repoId);
      }
    } finally {
      // Restore the writable adapter the rest of this file and its cleanup expect.
      await adapter.closeLbug();
      await adapter.initLbug(handle.dbPath);
    }
  });
});
