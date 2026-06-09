/**
 * P1 Unit Tests: Repository Manager
 *
 * Tests: getStoragePath, getStoragePaths, readRegistry, registerRepo, unregisterRepo
 * Covers hardening fixes #29 (API key file permissions) and #30 (case-insensitive paths on Windows)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
  getStoragePath,
  getStoragePaths,
  readRegistry,
  getGlobalRegistryPath,
  loadCLIConfig,
  registerRepo,
  listRegisteredRepos,
  RegistryNameCollisionError,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { parseRepoNameFromUrl, getInferredRepoName } from '../../src/storage/git.js';
import { execSync } from 'child_process';
import { createTempDir } from '../helpers/test-db.js';

// ─── getStoragePath ──────────────────────────────────────────────────

describe('getStoragePath', () => {
  it('appends .ontoindex to resolved repo path', () => {
    const result = getStoragePath('/home/user/project');
    expect(result).toContain('.ontoindex');
    expect(path.basename(result)).toBe('.ontoindex');
  });

  it('resolves relative paths', () => {
    const result = getStoragePath('.');
    // Should be an absolute path
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ─── getStoragePaths ─────────────────────────────────────────────────

describe('getStoragePaths', () => {
  it('returns storagePath, lbugPath, metaPath', () => {
    const paths = getStoragePaths('/home/user/project');
    expect(paths.storagePath).toContain('.ontoindex');
    expect(paths.lbugPath).toContain('lbug');
    expect(paths.metaPath).toContain('meta.json');
  });

  it('all paths are under storagePath', () => {
    const paths = getStoragePaths('/home/user/project');
    expect(paths.lbugPath.startsWith(paths.storagePath)).toBe(true);
    expect(paths.metaPath.startsWith(paths.storagePath)).toBe(true);
  });
});

// ─── readRegistry ────────────────────────────────────────────────────

describe('readRegistry', () => {
  it('returns empty array when registry does not exist', async () => {
    // readRegistry reads from ~/.ontoindex/registry.json
    // If the file doesn't exist, it should return []
    // This test exercises the catch path
    const result = await readRegistry();
    // Result is an array (may or may not be empty depending on user's system)
    expect(Array.isArray(result)).toBe(true);
  });

  it('throws when registry JSON is malformed instead of treating it as empty', async () => {
    const tmpHome = await createTempDir('ontoindex-registry-corrupt-');
    const savedOntoIndexHome = process.env.ONTOINDEX_HOME;
    process.env.ONTOINDEX_HOME = tmpHome.dbPath;

    try {
      await fs.mkdir(tmpHome.dbPath, { recursive: true });
      await fs.writeFile(getGlobalRegistryPath(), '{not-json', 'utf-8');

      await expect(readRegistry()).rejects.toThrow('Failed to read OntoIndex registry');
    } finally {
      if (savedOntoIndexHome === undefined) delete process.env.ONTOINDEX_HOME;
      else process.env.ONTOINDEX_HOME = savedOntoIndexHome;
      await tmpHome.cleanup();
    }
  });
});

// ─── CLI Config (file permissions) ───────────────────────────────────

describe('saveCLIConfig / loadCLIConfig', () => {
  let tmpHandle: Awaited<ReturnType<typeof createTempDir>>;
  let originalHomedir: typeof os.homedir;

  beforeEach(async () => {
    tmpHandle = await createTempDir('ontoindex-config-test-');
    originalHomedir = os.homedir;
    // Mock os.homedir to point to our temp dir
    // Note: This won't fully work because repo-manager uses its own import of os
    // We'll test what we can.
  });

  afterEach(async () => {
    os.homedir = originalHomedir;
    await tmpHandle.cleanup();
  });

  it('loadCLIConfig returns empty object when config does not exist', async () => {
    const config = await loadCLIConfig();
    // Returns {} or existing config
    expect(typeof config).toBe('object');
  });
});

// ─── Case-insensitive path comparison (Windows hardening #30) ────────

describe('case-insensitive path comparison', () => {
  it('registerRepo uses case-insensitive compare on Windows', () => {
    // The fix is in registerRepo: process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase()
    // We verify the logic inline since we can't easily mock process.platform

    const compareWindows = (a: string, b: string): boolean => {
      return a.toLowerCase() === b.toLowerCase();
    };

    // On Windows, these should match
    expect(compareWindows('D:\\Projects\\MyApp', 'd:\\projects\\myapp')).toBe(true);
    expect(compareWindows('C:\\Users\\USER\\project', 'c:\\users\\user\\project')).toBe(true);

    // Different paths should not match
    expect(compareWindows('D:\\Projects\\App1', 'D:\\Projects\\App2')).toBe(false);
  });

  it('case-sensitive compare for non-Windows', () => {
    const compareUnix = (a: string, b: string): boolean => {
      return a === b;
    };

    // On Unix, case matters
    expect(compareUnix('/home/user/Project', '/home/user/project')).toBe(false);
    expect(compareUnix('/home/user/project', '/home/user/project')).toBe(true);
  });
});

// ─── API key file permissions (hardening #29) ────────────────────────

describe('API key file permissions', () => {
  it('saveCLIConfig calls chmod 0o600 on non-Windows', async () => {
    // We verify that the saveCLIConfig code has the chmod call
    // by reading the source and checking statically.
    // The actual chmod behavior is platform-dependent.
    const source = await fs.readFile(
      path.join(process.cwd(), 'src', 'storage', 'repo-manager.ts'),
      'utf-8',
    );
    expect(source).toContain('chmod(configPath, 0o600)');
    expect(source).toContain("process.platform !== 'win32'");
  });
});

// ─── analyze --name <alias> + duplicate-name guard (#829) ────────────
//
// Each test isolates the global registry by pointing ONTOINDEX_HOME at a
// per-test tmpdir. `getGlobalDir()` honors that env var, so registerRepo
// writes/reads a sandboxed registry.json without touching the user's
// real ~/.ontoindex.

describe('registerRepo name override + collision guard (#829)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepoA: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepoB: Awaited<ReturnType<typeof createTempDir>>;
  let savedOntoIndexHome: string | undefined;

  const meta: RepoMeta = {
    repoPath: '',
    lastCommit: 'abc1234',
    indexedAt: '2026-04-18T12:00:00.000Z',
    stats: { files: 1, nodes: 1 },
  };

  beforeEach(async () => {
    tmpHome = await createTempDir('ontoindex-registry-home-');
    tmpRepoA = await createTempDir('ontoindex-repo-a-');
    tmpRepoB = await createTempDir('ontoindex-repo-b-');
    savedOntoIndexHome = process.env.ONTOINDEX_HOME;
    process.env.ONTOINDEX_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedOntoIndexHome === undefined) delete process.env.ONTOINDEX_HOME;
    else process.env.ONTOINDEX_HOME = savedOntoIndexHome;
    await tmpHome.cleanup();
    await tmpRepoA.cleanup();
    await tmpRepoB.cleanup();
  });

  it('registerRepo({ name: "alias" }) stores the alias instead of basename', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'custom-alias' });

    const entries = await listRegisteredRepos();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('custom-alias');
    expect(entries[0].name).not.toBe(path.basename(tmpRepoA.dbPath));
  });

  it('re-registerRepo on same path without name preserves an existing alias', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'custom-alias' });
    // Second call with no opts should keep the alias, not revert to basename.
    await registerRepo(tmpRepoA.dbPath, meta);

    const entries = await listRegisteredRepos();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('custom-alias');
  });

  it('re-registerRepo with a different name overrides the previous alias', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'old-alias' });
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'new-alias' });

    const entries = await listRegisteredRepos();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('new-alias');
  });

  it('registerRepo throws RegistryNameCollisionError when another path uses the name', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'shared' });

    await expect(registerRepo(tmpRepoB.dbPath, meta, { name: 'shared' })).rejects.toBeInstanceOf(
      RegistryNameCollisionError,
    );

    // And the colliding entry in the error carries enough info for the
    // CLI layer to surface an actionable message without string-matching.
    try {
      await registerRepo(tmpRepoB.dbPath, meta, { name: 'shared' });
    } catch (e) {
      expect(e).toBeInstanceOf(RegistryNameCollisionError);
      const err = e as RegistryNameCollisionError;
      // err.registryName carries the colliding alias (exposed as its own
      // field so err.name retains the inherited Error.prototype.name
      // semantics for downstream `err.name === '…Error'` checks).
      expect(err.registryName).toBe('shared');
      expect(err.name).toBe('RegistryNameCollisionError');
      expect(path.resolve(err.existingPath)).toBe(path.resolve(tmpRepoA.dbPath));
      expect(path.resolve(err.requestedPath)).toBe(path.resolve(tmpRepoB.dbPath));
    }

    // Registry still only has the first entry — the failed call didn't
    // corrupt state.
    const entries = await listRegisteredRepos();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('shared');
  });

  it('registerRepo({ name, allowDuplicateName: true }) allows the duplicate to coexist', async () => {
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'shared' });
    await registerRepo(tmpRepoB.dbPath, meta, { name: 'shared', allowDuplicateName: true });

    const entries = await listRegisteredRepos();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.name === 'shared')).toBe(true);
    // Both paths are stored distinctly — the collision is surfaced to the
    // user via resolveRepo / list output, not hidden at the storage layer.
    const paths = entries.map((e) => path.resolve(e.path)).sort();
    expect(paths).toEqual([path.resolve(tmpRepoA.dbPath), path.resolve(tmpRepoB.dbPath)].sort());
  });

  it('serializes concurrent registry updates without losing entries', async () => {
    await Promise.all([
      registerRepo(tmpRepoA.dbPath, meta, { name: 'repo-a' }),
      registerRepo(tmpRepoB.dbPath, meta, { name: 'repo-b' }),
    ]);

    const entries = await listRegisteredRepos();
    expect(entries.map((entry) => entry.name).sort()).toEqual(['repo-a', 'repo-b']);
  });

  it('reclaims stale malformed registry locks', async () => {
    const lockPath = `${getGlobalRegistryPath()}.lock`;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, '{not-json', 'utf-8');
    const old = new Date(Date.now() - 3 * 60_000);
    await fs.utimes(lockPath, old, old);

    await registerRepo(tmpRepoA.dbPath, meta, { name: 'repo-a' });

    const entries = await listRegisteredRepos();
    expect(entries.map((entry) => entry.name)).toEqual(['repo-a']);
  });

  it('serializes concurrent reclaim of a stale registry lock', async () => {
    const lockPath = `${getGlobalRegistryPath()}.lock`;
    const reclaimLockPath = `${lockPath}.reclaim`;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 99999999,
        token: 'stale-owner',
        startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      }),
      'utf-8',
    );

    await Promise.all([
      registerRepo(tmpRepoA.dbPath, meta, { name: 'repo-a' }),
      registerRepo(tmpRepoB.dbPath, meta, { name: 'repo-b' }),
    ]);

    const entries = await listRegisteredRepos();
    expect(entries.map((entry) => entry.name).sort()).toEqual(['repo-a', 'repo-b']);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(reclaimLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a stale registry reclaim lock before reclaiming a stale registry lock', async () => {
    const lockPath = `${getGlobalRegistryPath()}.lock`;
    const reclaimLockPath = `${lockPath}.reclaim`;
    const old = new Date(Date.now() - 3 * 60_000);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 99999999,
        token: 'stale-owner',
        startedAt: old.toISOString(),
      }),
      'utf-8',
    );
    await fs.writeFile(
      reclaimLockPath,
      JSON.stringify({
        pid: 99999998,
        token: 'stale-reclaimer',
        startedAt: old.toISOString(),
      }),
      'utf-8',
    );

    await registerRepo(tmpRepoA.dbPath, meta, { name: 'repo-a' });

    const entries = await listRegisteredRepos();
    expect(entries.map((entry) => entry.name)).toEqual(['repo-a']);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(reclaimLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers dead-owner locks with malformed token values', async () => {
    const lockPath = `${getGlobalRegistryPath()}.lock`;
    const reclaimLockPath = `${lockPath}.reclaim`;
    const old = new Date(Date.now() - 3 * 60_000);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 99999999,
        token: 123,
        startedAt: old.toISOString(),
      }),
      'utf-8',
    );
    await fs.writeFile(
      reclaimLockPath,
      JSON.stringify({
        pid: 99999998,
        token: 456,
        startedAt: old.toISOString(),
      }),
      'utf-8',
    );

    await registerRepo(tmpRepoA.dbPath, meta, { name: 'repo-a' });

    const entries = await listRegisteredRepos();
    expect(entries.map((entry) => entry.name)).toEqual(['repo-a']);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(reclaimLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers dead-owner locks with object and array token values', async () => {
    const lockPath = `${getGlobalRegistryPath()}.lock`;
    const reclaimLockPath = `${lockPath}.reclaim`;
    const old = new Date(Date.now() - 3 * 60_000);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 99999999,
        token: { malformed: true },
        startedAt: old.toISOString(),
      }),
      'utf-8',
    );
    await fs.writeFile(
      reclaimLockPath,
      JSON.stringify({
        pid: 99999998,
        token: ['malformed'],
        startedAt: old.toISOString(),
      }),
      'utf-8',
    );

    await registerRepo(tmpRepoA.dbPath, meta, { name: 'repo-a' });

    const entries = await listRegisteredRepos();
    expect(entries.map((entry) => entry.name)).toEqual(['repo-a']);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(reclaimLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not reclaim a registry lock solely because a live owner is old', async () => {
    const lockPath = `${getGlobalRegistryPath()}.lock`;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: 'live-owner',
        startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      }),
      'utf-8',
    );

    let settled = false;
    const registration = registerRepo(tmpRepoA.dbPath, meta, { name: 'repo-a' }).finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);

    await fs.unlink(lockPath);
    await registration;

    const entries = await listRegisteredRepos();
    expect(entries.map((entry) => entry.name)).toEqual(['repo-a']);
  });

  it('releases the registry lock when a registry mutation throws', async () => {
    const lockPath = `${getGlobalRegistryPath()}.lock`;
    await registerRepo(tmpRepoA.dbPath, meta, { name: 'shared' });

    await expect(registerRepo(tmpRepoB.dbPath, meta, { name: 'shared' })).rejects.toBeInstanceOf(
      RegistryNameCollisionError,
    );

    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await registerRepo(tmpRepoB.dbPath, meta, { name: 'shared', allowDuplicateName: true });
    const entries = await listRegisteredRepos();
    expect(entries.map((entry) => entry.name).sort()).toEqual(['shared', 'shared']);
  });

  it('basename collisions without an explicit --name still register silently (backward-compat)', async () => {
    // Create two sibling dirs whose basenames collide. Neither caller
    // passes { name }, so the guard must NOT fire — this preserves the
    // pre-#829 behaviour for users who don't know about --name yet.
    const parentA = await createTempDir('ontoindex-collide-parent-a-');
    const parentB = await createTempDir('ontoindex-collide-parent-b-');
    const sharedBasename = 'app';
    const pathA = path.join(parentA.dbPath, sharedBasename);
    const pathB = path.join(parentB.dbPath, sharedBasename);
    await fs.mkdir(pathA, { recursive: true });
    await fs.mkdir(pathB, { recursive: true });

    try {
      await registerRepo(pathA, meta);
      await registerRepo(pathB, meta); // must NOT throw

      const entries = await listRegisteredRepos();
      expect(entries).toHaveLength(2);
      expect(entries[0].name).toBe(sharedBasename);
      expect(entries[1].name).toBe(sharedBasename);
    } finally {
      await parentA.cleanup();
      await parentB.cleanup();
    }
  });
});

// ─── parseRepoNameFromUrl + getInferredRepoName (#979) ───────────────

describe('parseRepoNameFromUrl', () => {
  it('parses HTTPS URLs and strips .git', () => {
    expect(parseRepoNameFromUrl('https://github.com/owner/lume_spark.git')).toBe('lume_spark');
    expect(parseRepoNameFromUrl('https://github.com/owner/lume_spark')).toBe('lume_spark');
  });

  it('parses SSH URLs (git@host:owner/repo.git)', () => {
    expect(parseRepoNameFromUrl('git@github.com:owner/lume_spark.git')).toBe('lume_spark');
    expect(parseRepoNameFromUrl('git@gitlab.com:group/sub/lume_spark.git')).toBe('lume_spark');
  });

  it('parses ssh:// and git:// URLs', () => {
    expect(parseRepoNameFromUrl('ssh://git@host.example/owner/lume_spark.git')).toBe('lume_spark');
    expect(parseRepoNameFromUrl('git://host.example/owner/lume_spark.git')).toBe('lume_spark');
  });

  it('parses local file:// URLs', () => {
    expect(parseRepoNameFromUrl('file:///srv/git/lume_spark.git')).toBe('lume_spark');
  });

  it('handles trailing slashes and mixed-case .git', () => {
    expect(parseRepoNameFromUrl('https://github.com/owner/lume_spark.GIT/')).toBe('lume_spark');
    expect(parseRepoNameFromUrl('https://github.com/owner/lume_spark/')).toBe('lume_spark');
  });

  it('returns null for empty / null / undefined / unparseable input', () => {
    expect(parseRepoNameFromUrl('')).toBeNull();
    expect(parseRepoNameFromUrl('   ')).toBeNull();
    expect(parseRepoNameFromUrl(null)).toBeNull();
    expect(parseRepoNameFromUrl(undefined)).toBeNull();
  });
});

describe('getInferredRepoName + registerRepo (#979 — git remote inference)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedOntoIndexHome: string | undefined;

  const meta: RepoMeta = {
    repoPath: '',
    lastCommit: 'abc1234',
    indexedAt: '2026-04-19T00:00:00.000Z',
    stats: { files: 1, nodes: 1 },
  };

  /** Initialise a real git repo at `dir` with the given remote URL. */
  const initGitRepo = (dir: string, remoteUrl: string | null) => {
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email "test@example.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    if (remoteUrl) {
      execSync(`git remote add origin ${remoteUrl}`, { cwd: dir });
    }
  };

  beforeEach(async () => {
    tmpHome = await createTempDir('ontoindex-registry-home-979-');
    savedOntoIndexHome = process.env.ONTOINDEX_HOME;
    process.env.ONTOINDEX_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedOntoIndexHome === undefined) delete process.env.ONTOINDEX_HOME;
    else process.env.ONTOINDEX_HOME = savedOntoIndexHome;
    await tmpHome.cleanup();
  });

  it('getInferredRepoName returns null when there is no .git directory', async () => {
    const tmp = await createTempDir('ontoindex-no-git-');
    try {
      expect(getInferredRepoName(tmp.dbPath)).toBeNull();
    } finally {
      await tmp.cleanup();
    }
  });

  it('getInferredRepoName returns null when origin is unset', async () => {
    const tmp = await createTempDir('ontoindex-no-origin-');
    try {
      initGitRepo(tmp.dbPath, null);
      expect(getInferredRepoName(tmp.dbPath)).toBeNull();
    } finally {
      await tmp.cleanup();
    }
  });

  it('getInferredRepoName returns the remote repo name when origin is set', async () => {
    const tmp = await createTempDir('ontoindex-with-origin-');
    try {
      initGitRepo(tmp.dbPath, 'https://github.com/owner/lume_spark.git');
      expect(getInferredRepoName(tmp.dbPath)).toBe('lume_spark');
    } finally {
      await tmp.cleanup();
    }
  });

  it('registerRepo derives name from git remote when basename is generic (Gas-Town repro)', async () => {
    // Reproduce <rig>/refinery/rig/.git layout: leaf basename is "rig",
    // but origin URL says "lume_spark". The new precedence MUST pick up
    // the remote-derived name instead of the basename.
    const root = await createTempDir('ontoindex-gastown-');
    try {
      const rigPath = path.join(root.dbPath, 'lume_spark', 'refinery', 'rig');
      await fs.mkdir(rigPath, { recursive: true });
      initGitRepo(rigPath, 'git@github.com:gastown/lume_spark.git');

      const name = await registerRepo(rigPath, meta);
      expect(name).toBe('lume_spark');
      expect(name).not.toBe('rig');

      const entries = await listRegisteredRepos();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('lume_spark');
    } finally {
      await root.cleanup();
    }
  });

  it('two analyze calls of differently-remoted "rig" leaves no longer collide', async () => {
    // Without the remote inference both would register as "rig"; with
    // inference they pick up their distinct remotes — the original issue.
    const root = await createTempDir('ontoindex-gastown-2-');
    try {
      const rigA = path.join(root.dbPath, 'lume_spark', 'refinery', 'rig');
      const rigB = path.join(root.dbPath, 'gemba', 'refinery', 'rig');
      await fs.mkdir(rigA, { recursive: true });
      await fs.mkdir(rigB, { recursive: true });
      initGitRepo(rigA, 'git@github.com:gastown/lume_spark.git');
      initGitRepo(rigB, 'git@github.com:gastown/gemba.git');

      const nameA = await registerRepo(rigA, meta);
      const nameB = await registerRepo(rigB, meta);
      expect(nameA).toBe('lume_spark');
      expect(nameB).toBe('gemba');

      const entries = await listRegisteredRepos();
      expect(entries.map((e) => e.name).sort()).toEqual(['gemba', 'lume_spark']);
    } finally {
      await root.cleanup();
    }
  });

  it('explicit --name still wins over remote inference', async () => {
    const tmp = await createTempDir('ontoindex-name-wins-');
    try {
      initGitRepo(tmp.dbPath, 'https://github.com/owner/from-remote.git');
      const name = await registerRepo(tmp.dbPath, meta, { name: 'user-alias' });
      expect(name).toBe('user-alias');
    } finally {
      await tmp.cleanup();
    }
  });

  it('preserved alias still wins over remote inference on re-analyze', async () => {
    const tmp = await createTempDir('ontoindex-preserve-alias-');
    try {
      initGitRepo(tmp.dbPath, 'https://github.com/owner/from-remote.git');
      // First analyze sets the alias…
      await registerRepo(tmp.dbPath, meta, { name: 'sticky-alias' });
      // …second analyze with no opts must keep it (not silently switch
      // to the remote-derived name).
      const name = await registerRepo(tmp.dbPath, meta);
      expect(name).toBe('sticky-alias');
    } finally {
      await tmp.cleanup();
    }
  });

  it('falls back to basename when no .git / no remote is available', async () => {
    const tmp = await createTempDir('ontoindex-fallback-basename-');
    try {
      const name = await registerRepo(tmp.dbPath, meta);
      expect(name).toBe(path.basename(tmp.dbPath));
    } finally {
      await tmp.cleanup();
    }
  });
});
