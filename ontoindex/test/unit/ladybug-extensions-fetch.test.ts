import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM build helper without type declarations
import { ensureLadybugExtensions } from '../../scripts/ladybug-extensions.mjs';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const body = { fts: Buffer.from('fts-bytes'), vector: Buffer.from('vector-bytes') };
const pins = { v1: { p: { fts: sha(body.fts), vector: sha(body.vector) } } };
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lbext-'));
const base = { version: 'v1', platformDir: 'p', pins, log: () => {}, retries: 2 };
const fetchOk = async (url: string) => {
  const name = url.includes('/fts/') ? 'fts' : 'vector';
  return new Response(body[name as 'fts']);
};

describe('ensureLadybugExtensions', () => {
  it('downloads missing files and verifies checksums', async () => {
    const dir = mk();
    const r = await ensureLadybugExtensions({ ...base, dir, fetchImpl: fetchOk });
    expect(r).toEqual({ ok: true, missing: [] });
    expect(fs.readFileSync(path.join(dir, 'libvector.lbug_extension'))).toEqual(body.vector);
  });

  it('skips files already present with a matching checksum', async () => {
    const dir = mk();
    fs.writeFileSync(path.join(dir, 'libfts.lbug_extension'), body.fts);
    fs.writeFileSync(path.join(dir, 'libvector.lbug_extension'), body.vector);
    let calls = 0;
    const r = await ensureLadybugExtensions({
      ...base,
      dir,
      fetchImpl: async () => {
        calls++;
        return new Response('x');
      },
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it('rejects a checksum mismatch and leaves no file behind', async () => {
    const dir = mk();
    const r = await ensureLadybugExtensions({
      ...base,
      dir,
      fetchImpl: async () => new Response('tampered'),
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['fts', 'vector']);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('reports network failure without throwing', async () => {
    const r = await ensureLadybugExtensions({
      ...base,
      dir: mk(),
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(r.ok).toBe(false);
  });

  it('does not fetch when no pins exist for the platform', async () => {
    const r = await ensureLadybugExtensions({
      ...base,
      dir: mk(),
      platformDir: 'zz',
      fetchImpl: fetchOk,
    });
    expect(r.ok).toBe(false);
  });
});
