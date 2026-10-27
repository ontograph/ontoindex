import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LbugOpenError } from '../../src/core/lbug/open-error.js';
import { workspaceConfigurationIdentity } from '../../src/core/analyze-delta.js';
import {
  prepareWorkspaceRead,
  resetWorkspaceBuildFailures,
} from '../../src/mcp/local/local-backend-repo-runtime.js';
import {
  getOverlaySnapshot,
  resetOverlaySnapshotCache,
  withPinnedOverlay,
  type OverlayRepo,
  type OverlaySnapshot,
} from '../../src/mcp/local/backend-overlay.js';

vi.mock('../../src/storage/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/git.js')>()),
  getCurrentCommit: vi.fn(() => 'fixture-head'),
}));

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

describe('published overlay read failure quarantine', () => {
  let root: string;
  let repo: OverlayRepo;
  let snapshot: OverlaySnapshot;
  let dbPath: string;
  let markerPath: string;
  let basePath: string;
  let currentPath: string;
  let originalBase: string;
  const generation = 'fixture';

  const databaseIdentity = async () => {
    const { dev, ino, size, mtimeMs } = await fs.stat(dbPath);
    return { dev, ino, size, mtimeMs };
  };
  const failRead = (error: unknown) =>
    withPinnedOverlay(repo, snapshot, async () => {
      throw error;
    });

  beforeEach(async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
    resetOverlaySnapshotCache();
    resetWorkspaceBuildFailures();
    vi.mocked(workspaceConfigurationIdentity).mockResolvedValue({
      configurationDigest: 'config',
      parserIdentity: 'parser',
    });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-quarantine-'));
    repo = { id: root, repoPath: root, storagePath: path.join(root, '.ontoindex') };
    const generationPath = path.join(repo.storagePath, 'overlay', generation);
    await fs.mkdir(generationPath, { recursive: true });
    dbPath = path.join(generationPath, 'lbug');
    markerPath = path.join(generationPath, 'READ_FAILURE.json');
    basePath = path.join(generationPath, 'base.json');
    currentPath = path.join(repo.storagePath, 'overlay', 'CURRENT');
    const source = 'export const source = 1;\n';
    await fs.writeFile(path.join(root, 'source.ts'), source);
    await fs.writeFile(dbPath, 'database fixture');
    await fs.writeFile(currentPath, `${generation}\n`);
    originalBase = JSON.stringify({
      baseGenerationId: null,
      baseCommit: null,
      manifestDigest: 'f'.repeat(64),
      configurationDigest: 'config',
      parserIdentity: 'parser',
      includePaths: ['source.ts'],
      inputs: { 'source.ts': createHash('sha256').update(source).digest('hex') },
    });
    await fs.writeFile(basePath, originalBase);
    snapshot = await getOverlaySnapshot(repo);
    expect(snapshot.usable).toBe(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetOverlaySnapshotCache();
    resetWorkspaceBuildFailures();
    await fs.rm(root, { recursive: true, force: true });
  });

  const publishQuarantine = async (
    nextGeneration: string,
    metadata: Record<string, unknown> = {},
  ) => {
    const generationPath = path.join(repo.storagePath, 'overlay', nextGeneration);
    await fs.mkdir(generationPath, { recursive: true });
    dbPath = path.join(generationPath, 'lbug');
    markerPath = path.join(generationPath, 'READ_FAILURE.json');
    basePath = path.join(generationPath, 'base.json');
    await fs.writeFile(dbPath, 'database fixture');
    await fs.writeFile(
      basePath,
      JSON.stringify({
        ...JSON.parse(originalBase),
        head: 'fixture-head',
        inputs: {
          'source.ts': createHash('sha256')
            .update(await fs.readFile(path.join(root, 'source.ts')))
            .digest('hex'),
        },
        ...metadata,
      }),
    );
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        generation: nextGeneration,
        reason: 'native_open_corrupt',
        databaseIdentity: await databaseIdentity(),
      }),
    );
    await fs.writeFile(currentPath, `${nextGeneration}\n`);
    resetOverlaySnapshotCache();
    return getOverlaySnapshot(repo);
  };

  it('identifies validated source bytes independently of generation and manifest churn', async () => {
    const first = await publishQuarantine('first');
    expect(first.repairInputDigest).toMatch(/^[a-f0-9]{64}$/);
    const republished = await publishQuarantine('second', { manifestDigest: 'other-manifest' });
    expect(republished.repairInputDigest).toBe(first.repairInputDigest);
    await fs.writeFile(path.join(root, 'source.ts'), 'export const source = 2;\n');
    const changed = await publishQuarantine('third');
    expect(changed.repairInputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(changed.repairInputDigest).not.toBe(first.repairInputDigest);
  });

  it.each(['configurationDigest', 'parserIdentity'] as const)(
    'includes verified %s in repair content identity',
    async (field) => {
      const first = await publishQuarantine('first');
      vi.mocked(workspaceConfigurationIdentity).mockResolvedValue({
        configurationDigest: 'config',
        parserIdentity: 'parser',
        [field]: 'changed',
      });
      const changed = await publishQuarantine('second', { [field]: 'changed' });
      expect(changed.repairInputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(changed.repairInputDigest).not.toBe(first.repairInputDigest);
    },
  );

  it('does not expose repair content identity when source or configuration validation fails', async () => {
    await publishQuarantine('first');
    await fs.writeFile(path.join(root, 'source.ts'), 'export const source = 2;\n');
    resetOverlaySnapshotCache();
    const stale = await getOverlaySnapshot(repo);
    expect(stale.reason).toContain('overlay is stale');
    expect(stale.repairInputDigest).toBeUndefined();
    const invalid = await publishQuarantine('second', { configurationDigest: 'wrong' });
    expect(invalid.reason).toContain('configuration identity changed');
    expect(invalid.repairInputDigest).toBeUndefined();
  });

  it('allows one repair for unchanged quarantine and another after validated same-path bytes change', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const publishWorkspaceQuarantine = async (nextGeneration: string) => {
      const source = await fs.readFile(path.join(root, 'source.ts'));
      return publishQuarantine(nextGeneration, {
        capability: 'workspace-graph',
        coverage: 'complete',
        dirtyPaths: ['source.ts'],
        tombstones: [],
        inventory: {
          'source.ts': [
            source.length,
            null,
            null,
            createHash('sha256').update(source).digest('hex'),
          ],
        },
      });
    };
    await publishWorkspaceQuarantine('first');
    let builds = 0;
    const build = vi.fn(async () => {
      if (++builds === 1) await publishWorkspaceQuarantine('first-repair');
      else {
        await publishWorkspaceQuarantine('second-repair');
        await fs.unlink(markerPath);
      }
    });
    const prepare = () =>
      prepareWorkspaceRead({
        repo,
        needsRelationships: false,
        dependencies: {
          getSnapshot: getOverlaySnapshot,
          getInputIdentity: async () => ({
            configurationDigest: 'config',
            parserIdentity: 'parser',
            inputDigest: createHash('sha256')
              .update(await fs.readFile(path.join(root, 'source.ts')))
              .digest('hex'),
          }),
          evictSnapshot: resetOverlaySnapshotCache,
          acquireLock: async () => ({ release: async () => {} }),
          buildWorkspaceGraph: build,
          baseFileCount: async () => 1,
        },
      });
    await expect(prepare()).rejects.toMatchObject({
      code: 'workspace_build_failed',
      failure: { phase: 'verification', reason: 'capability_missing' },
    });
    expect(build).toHaveBeenCalledTimes(1);
    await expect(prepare()).rejects.toMatchObject({
      failure: { phase: 'verification', reason: 'capability_missing' },
    });
    expect(build).toHaveBeenCalledTimes(1);
    await fs.writeFile(path.join(root, 'source.ts'), 'export const source = 2;\n');
    // Preserve generation, paths and diagnostics so only validated bytes can reopen repair.
    await publishWorkspaceQuarantine('first-repair');
    await expect(prepare()).resolves.toMatchObject({ usable: true });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['corrupt database', 'native_open_corrupt'],
    ['incompatible storage version', 'native_open_incompatible'],
  ])('quarantines %s and rejects subsequent snapshots', async (message, reason) => {
    const error = new LbugOpenError(dbPath, new Error(message));
    const identity = await databaseIdentity();
    const rename = vi.spyOn(fs, 'rename');
    await expect(failRead(error)).rejects.toBe(error);
    expect(JSON.parse(await fs.readFile(markerPath, 'utf8'))).toEqual({
      version: 1,
      generation,
      databaseIdentity: identity,
      reason,
    });
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/READ_FAILURE\.json\..+\.tmp$/),
      markerPath,
    );
    expect(await fs.readFile(currentPath, 'utf8')).toBe(`${generation}\n`);
    expect(await fs.readFile(basePath, 'utf8')).toBe(originalBase);
    expect(await fs.readFile(dbPath, 'utf8')).toBe('database fixture');
    expect((await fs.readdir(path.dirname(dbPath))).sort()).toEqual([
      'READ_FAILURE.json',
      'base.json',
      'lbug',
    ]);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({
      usable: false,
      reason: `overlay generation unreadable (${reason}); rebuild required`,
    });
  });

  it.each([
    'Could not set lock on database',
    'unknown native failure',
    'EACCES permission denied',
    'ENOMEM allocation failure',
  ])('does not quarantine %s', async (message) => {
    const error = new LbugOpenError(dbPath, new Error(message));
    await expect(failRead(error)).rejects.toBe(error);
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });
  });

  it('ignores an error for a different database and an untyped corrupt error', async () => {
    for (const error of [
      new LbugOpenError(path.join(root, 'another-db'), new Error('corrupt database')),
      new Error('corrupt database'),
    ]) {
      await expect(failRead(error)).rejects.toBe(error);
      await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each([0, 1, 2, 3, 4])('bounds typed cause traversal at depth %i', async (depth) => {
    let error: Error = new LbugOpenError(dbPath, new Error('corrupt database'));
    for (let index = 0; index < depth; index++) error = new Error('wrapped', { cause: error });
    await expect(failRead(error)).rejects.toBe(error);
    if (depth <= 3) expect(await fs.stat(markerPath)).toBeDefined();
    else await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['dev', 'ino', 'size', 'mtimeMs'] as const)(
    'ignores a marker with a mismatched %s identity',
    async (field) => {
      const identity = await databaseIdentity();
      await fs.writeFile(
        markerPath,
        JSON.stringify({
          version: 1,
          generation,
          reason: 'native_open_corrupt',
          databaseIdentity: { ...identity, [field]: identity[field] + 1 },
        }),
      );
      await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });
    },
  );

  it.each([
    '{',
    'null',
    JSON.stringify({ version: 2, generation }),
    JSON.stringify({ version: 1, generation: 'other' }),
  ])('ignores malformed or unrelated marker %s', async (contents) => {
    await fs.writeFile(markerPath, contents);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });
  });

  it('writes the marker while the generation pin is held', async () => {
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === markerPath) {
        expect(
          (await fs.readdir(path.dirname(dbPath))).some((name) => name.startsWith('.reader-')),
        ).toBe(true);
      }
      return rename(from, to);
    });
    const error = new LbugOpenError(dbPath, new Error('corrupt database'));
    await expect(failRead(error)).rejects.toBe(error);
    expect(await fs.stat(markerPath)).toBeDefined();
  });

  it('preserves the original error and removes temporary files when marker publication fails', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('marker publication denied'));
    const error = new LbugOpenError(dbPath, new Error('corrupt database'));
    await expect(failRead(error)).rejects.toBe(error);
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(path.dirname(dbPath))).sort()).toEqual(['base.json', 'lbug']);
    expect(await fs.readFile(currentPath, 'utf8')).toBe(`${generation}\n`);
    expect(await fs.readFile(basePath, 'utf8')).toBe(originalBase);
  });
});
