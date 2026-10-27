import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { digestDatabaseFile } from '../../src/core/lbug/database-digest.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'database-digest-'));
  tempDirectories.push(directory);
  return path.join(directory, 'lbug');
}

describe('digestDatabaseFile', () => {
  it('hashes an empty file', async () => {
    const dbPath = databasePath();
    writeFileSync(dbPath, Buffer.alloc(0));

    expect(await digestDatabaseFile(dbPath)).toEqual({
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      size: 0,
    });
  });

  it('hashes a multi-chunk random file and counts its bytes', async () => {
    const dbPath = databasePath();
    writeFileSync(dbPath, randomBytes(3 * 1024 * 1024));

    expect(await digestDatabaseFile(dbPath)).toEqual({
      sha256: createHash('sha256').update(readFileSync(dbPath)).digest('hex'),
      size: statSync(dbPath).size,
    });
  });

  it('preserves the native error when the file is missing', async () => {
    const dbPath = databasePath();

    await expect(digestDatabaseFile(dbPath)).rejects.toMatchObject({
      code: 'ENOENT',
      path: dbPath,
    });
  });

  it('changes the digest after a one-byte flip', async () => {
    const dbPath = databasePath();
    const bytes = randomBytes(1024);
    writeFileSync(dbPath, bytes);
    const before = await digestDatabaseFile(dbPath);

    bytes[0] ^= 1;
    writeFileSync(dbPath, bytes);
    const after = await digestDatabaseFile(dbPath);

    expect(after.sha256).not.toBe(before.sha256);
    expect(after.size).toBe(before.size);
  });
});
