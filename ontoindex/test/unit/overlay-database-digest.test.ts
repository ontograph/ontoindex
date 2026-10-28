import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digestDatabaseFile } from '../../src/core/lbug/database-digest.js';
import {
  getOverlaySnapshot,
  resetOverlaySnapshotCache,
  type OverlayRepo,
} from '../../src/mcp/local/backend-overlay.js';

vi.mock('../../src/core/lbug/database-digest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/database-digest.js')>();
  return { ...actual, digestDatabaseFile: vi.fn(actual.digestDatabaseFile) };
});

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  closeLbug: vi.fn(),
  executeParameterized: vi.fn(),
  initLbug: vi.fn(),
  withPinnedGeneration: vi.fn(
    async (_id: string, _path: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

vi.mock('../../src/core/analyze-delta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/analyze-delta.js')>()),
  planDirtyOverlay: vi.fn(async () => ({
    includePaths: ['source.ts'],
    allDirtyPaths: ['source.ts'],
    uncoveredPaths: [],
    tombstones: [],
    skipped: [],
    configPaths: [],
    tooMany: false,
  })),
  workspaceConfigurationIdentity: vi.fn(async () => ({
    configurationDigest: 'config',
    parserIdentity: 'parser',
  })),
}));

describe('published overlay database integrity', () => {
  let root: string;
  let repo: OverlayRepo;
  let dbPath: string;
  let basePath: string;
  let base: Record<string, unknown>;
  const database = Buffer.from('database fixture');
  const databaseDigest = {
    sha256: createHash('sha256').update(database).digest('hex'),
    size: database.length,
  };
  const integrityFailure = {
    usable: false,
    reason: 'overlay database failed integrity check; rebuild: ontoindex analyze --dirty-overlay',
  };

  const recordDigest = async (digest: unknown) => {
    await fs.writeFile(basePath, JSON.stringify({ ...base, databaseDigest: digest }));
  };

  beforeEach(async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
    resetOverlaySnapshotCache();
    vi.mocked(digestDatabaseFile).mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-digest-'));
    repo = { id: root, repoPath: root, storagePath: path.join(root, '.ontoindex') };
    const generationPath = path.join(repo.storagePath, 'overlay', 'fixture');
    await fs.mkdir(generationPath, { recursive: true });
    dbPath = path.join(generationPath, 'lbug');
    basePath = path.join(generationPath, 'base.json');
    const source = 'export const source = 1;\n';
    await fs.writeFile(path.join(root, 'source.ts'), source);
    await fs.writeFile(dbPath, database);
    await fs.writeFile(path.join(repo.storagePath, 'overlay', 'CURRENT'), 'fixture\n');
    base = {
      baseGenerationId: null,
      baseCommit: null,
      manifestDigest: 'f'.repeat(64),
      configurationDigest: 'config',
      parserIdentity: 'parser',
      includePaths: ['source.ts'],
      inputs: { 'source.ts': createHash('sha256').update(source).digest('hex') },
    };
    await fs.writeFile(basePath, JSON.stringify(base));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetOverlaySnapshotCache();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('accepts a legacy generation without a database digest', async () => {
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });
    expect(digestDatabaseFile).not.toHaveBeenCalled();
  });

  it('accepts a correct database digest', async () => {
    await recordDigest(databaseDigest);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });
    expect(digestDatabaseFile).toHaveBeenCalledExactlyOnceWith(dbPath);
  });

  it('rejects one flipped byte without changing the database size', async () => {
    await recordDigest(databaseDigest);
    const damaged = Buffer.from(database);
    damaged[0] ^= 1;
    await fs.writeFile(dbPath, damaged);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject(integrityFailure);
  });

  it('rejects a truncated database before hashing it', async () => {
    await recordDigest(databaseDigest);
    await fs.truncate(dbPath, database.length - 1);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject(integrityFailure);
    expect(digestDatabaseFile).not.toHaveBeenCalled();
  });

  it.each([
    { ...databaseDigest, sha256: 'g'.repeat(64) },
    { ...databaseDigest, sha256: 'A'.repeat(64) },
    { ...databaseDigest, size: -1 },
    { ...databaseDigest, size: 1.5 },
    { sha256: databaseDigest.sha256 },
    null,
    'digest',
    [],
  ])('rejects malformed database digest %j', async (digest) => {
    await recordDigest(digest);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject(integrityFailure);
    expect(digestDatabaseFile).not.toHaveBeenCalled();
  });

  it('hashes an unchanged database once across repeated snapshots', async () => {
    await recordDigest(databaseDigest);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });
    expect(digestDatabaseFile).toHaveBeenCalledTimes(1);
  });

  it('checks the recorded hash even when the database identity is memoized', async () => {
    await recordDigest(databaseDigest);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });
    await recordDigest({ ...databaseDigest, sha256: '0'.repeat(64) });
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject(integrityFailure);
    expect(digestDatabaseFile).toHaveBeenCalledTimes(1);
  });

  it('rechecks a database whose file identity changed after successful verification', async () => {
    await recordDigest(databaseDigest);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });
    const damaged = Buffer.from(database);
    damaged[0] ^= 1;
    await fs.writeFile(dbPath, damaged);
    const modified = new Date(Date.now() + 10_000);
    await fs.utimes(dbPath, modified, modified);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject(integrityFailure);
    expect(digestDatabaseFile).toHaveBeenCalledTimes(2);
  });

  it('clears successful digest verification when snapshots are reset', async () => {
    await recordDigest(databaseDigest);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });
    resetOverlaySnapshotCache();
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });
    expect(digestDatabaseFile).toHaveBeenCalledTimes(2);
  });

  it('rejects a filesystem error while hashing the database', async () => {
    await recordDigest(databaseDigest);
    vi.mocked(digestDatabaseFile).mockRejectedValueOnce(new Error('read denied'));
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject(integrityFailure);
  });

  it('rejects a filesystem error while checking the database size', async () => {
    await recordDigest(databaseDigest);
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(new Error('stat denied'));
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject(integrityFailure);
    expect(digestDatabaseFile).not.toHaveBeenCalled();
  });
});
