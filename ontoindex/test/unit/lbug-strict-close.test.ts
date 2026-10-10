import lbug from '@ladybugdb/core';
import { describe, expect, it, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

withTestLbugDB('strict-close', () => {
  describe('closeLbug strict mode', () => {
    // Order matters: each close ends the shared session, and the helper opens it only once.
    it('rethrows a failed native close in strict mode, still resetting the session', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      expect(adapter.isLbugReady()).toBe(true);
      const fail = vi
        .spyOn(lbug.Connection.prototype, 'close')
        .mockRejectedValueOnce(new Error('injected close failure'));
      try {
        await expect(adapter.closeLbug({ strict: true })).rejects.toThrow('injected close failure');
        expect(adapter.isLbugReady()).toBe(false);
      } finally {
        fail.mockRestore();
      }
    });
  });
});
