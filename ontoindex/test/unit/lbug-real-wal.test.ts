import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Real @ladybugdb/core, no driver mocks. Gated because it opens native databases.
const enabled = process.env.ONTOINDEX_REAL_WAL_TEST === '1';

vi.mock('../../src/storage/repo-manager.js', () => ({
  acquireIndexGenerationPin: async (dbPath: string) => ({ dbPath, release: async () => {} }),
}));

describe.skipIf(!enabled)('pool-adapter against a corrupt WAL (real driver)', () => {
  let dir = '';
  afterEach(async () => {
    vi.resetModules();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it.each([
    ['checksum failure', Buffer.alloc(4096, 255)],
    ['truncated tail', Buffer.alloc(1)],
  ])(
    'recovers rows after a %s in init()',
    async (_name, wal) => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-real-wal-'));
      const dbPath = path.join(dir, 'lbug');
      // Seed in a child process. A Database seeded in this process finishes tearing down
      // asynchronously after close() resolves and would checkpoint (consume) the corrupt WAL
      // written below; waiting for the child to exit makes the fixture deterministic.
      const driverPath = createRequire(import.meta.url).resolve('@ladybugdb/core');
      const seedScript = `
      const lbug = require(${JSON.stringify(driverPath)});
      (async () => {
        const db = new lbug.Database(${JSON.stringify(dbPath)}, 0, false, false);
        await db.init();
        const conn = new lbug.Connection(db);
        await conn.query('CREATE NODE TABLE Row(id INT64, PRIMARY KEY(id))');
        await conn.query('UNWIND range(1, 3) AS id CREATE (:Row {id: id})');
        await conn.query('CHECKPOINT');
        await conn.close();
        await db.close();
        process.exit(0);
      })().catch((error) => { console.error(error); process.exit(1); });
    `;
      execFileSync(process.execPath, ['-e', seedScript], { stdio: 'pipe', timeout: 30_000 });
      await fs.writeFile(`${dbPath}.wal`, wal);

      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const pool = await import('../../src/core/lbug/pool-adapter.js');
      try {
        await pool.initLbug('real-wal', dbPath);
        const rows = await pool.executeQuery('real-wal', 'MATCH (r:Row) RETURN count(r) AS count');
        expect(Number((rows as Array<{ count: unknown }>)[0].count)).toBe(3);
        expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain(
          'WAL corruption detected',
        );
      } finally {
        stderr.mockRestore();
        await pool.closeLbug();
      }
    },
    60_000,
  );
});
