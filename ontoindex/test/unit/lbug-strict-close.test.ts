import lbug from '@ladybugdb/core';
import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

withTestLbugDB('strict-close', (handle) => {
  describe('closeLbug strict mode', () => {
    // Order matters: each close ends the shared session, and the helper opens it only once.
    it('resets failed sessions but blocks strict closure and reopening until restart', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      expect(adapter.isLbugReady()).toBe(true);
      const fail = vi
        .spyOn(lbug.Connection.prototype, 'close')
        .mockRejectedValueOnce(new Error('injected close failure'));
      const alias = path.join(path.dirname(handle.dbPath), 'strict-close-alias');
      await fs.symlink(handle.dbPath, alias);
      try {
        await expect(adapter.closeLbug({ strict: true })).rejects.toThrow('injected close failure');
        expect(adapter.isLbugReady()).toBe(false);
        await adapter.closeLbug();
        await expect(adapter.closeLbugForPath(handle.dbPath, { strict: true })).rejects.toThrow(
          'restart the server',
        );
        await expect(adapter.closeLbugForPath(alias, { strict: true })).rejects.toThrow(
          'restart the server',
        );
        await expect(adapter.initLbug(handle.dbPath)).rejects.toThrow('restart the server');
        await expect(adapter.initLbug(alias)).rejects.toThrow('restart the server');
      } finally {
        fail.mockRestore();
      }
    });
  });
});
