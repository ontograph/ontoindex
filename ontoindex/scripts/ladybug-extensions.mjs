import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EXTENSION_BASE_URL = 'https://extension.ladybugdb.com';
export const EXTENSION_NAMES = ['fts', 'vector'];

const sha256File = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Verify a complete cache before bundling, including when fetching is disabled. */
export function verifyLadybugExtensions({ dir, version, platformDir, pins }) {
  const expected = pins?.[version]?.[platformDir];
  for (const name of EXTENSION_NAMES) {
    const want = expected?.[name];
    if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want)) {
      throw new Error(`Missing pinned LadybugDB ${name} checksum for ${version}/${platformDir}`);
    }
    const file = path.join(dir, `lib${name}.lbug_extension`);
    if (sha256File(file) !== want) {
      throw new Error(`LadybugDB extension checksum mismatch: ${file}`);
    }
  }
}

/**
 * Ensure libfts/libvector exist in `dir`, downloading any missing file and
 * verifying it against the pinned sha256 before it is moved into place.
 * Returns { ok, missing }. Never throws on network failure.
 */
export async function ensureLadybugExtensions({
  dir,
  version,
  platformDir,
  pins,
  fetchImpl = fetch,
  retries = 3,
  timeoutMs = 120_000,
  log = console.log,
}) {
  const expected = pins?.[version]?.[platformDir];
  if (!expected) {
    log(
      `[build] no pinned LadybugDB extension checksums for ${version}/${platformDir}; not fetching.`,
    );
    return { ok: false, missing: [...EXTENSION_NAMES] };
  }
  fs.mkdirSync(dir, { recursive: true });
  const missing = [];
  for (const name of EXTENSION_NAMES) {
    const file = path.join(dir, `lib${name}.lbug_extension`);
    const want = expected[name];
    if (fs.existsSync(file) && sha256File(file) === want) continue;
    fs.rmSync(file, { force: true });
    const url = `${EXTENSION_BASE_URL}/${version}/${platformDir}/${name}/lib${name}.lbug_extension`;
    let done = false;
    for (let attempt = 1; attempt <= retries && !done; attempt++) {
      const part = `${file}.part`;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
        if (sha256File(part) !== want) throw new Error('checksum mismatch');
        fs.renameSync(part, file);
        log(`[build] fetched ${name} extension (${platformDir}).`);
        done = true;
      } catch (err) {
        fs.rmSync(part, { force: true });
        log(`[build] ${name} extension fetch attempt ${attempt}/${retries} failed: ${err.message}`);
      }
    }
    if (!done) missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}
