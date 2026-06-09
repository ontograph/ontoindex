import { describe, it, expect, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import {
  contractNodeId,
  retryRename,
  createContractLookupIndex,
  indexContract,
  findContractNode,
} from '../../../src/core/group/bridge-db.js';
import { runNativeBridgeScenario } from '../../helpers/native-bridge-child.js';
import { makeContract } from './fixtures.js';

const describeNativeBridge = process.platform === 'win32' ? describe.skip : describe;

describeNativeBridge('bridge-db native child process coverage', () => {
  it('opens, initializes schema, and queries data', () => {
    runNativeBridgeScenario(`
    const dbPath = path.join(tmpDir, 'test.lbug');
    const handle = await openBridgeDb(dbPath);
    assert.ok(handle._db);
    assert.ok(handle._conn);
    assert.equal(handle.groupDir, tmpDir);

    await ensureBridgeSchema(handle);
    await ensureBridgeSchema(handle);
    const emptyRows = await queryBridge(handle, 'MATCH (c:Contract) RETURN count(c) AS cnt');
    assert.equal(emptyRows[0].cnt, 0);

    await queryBridge(handle, \`CREATE (c:Contract {
      id: 'abc123', contractId: 'http::GET::/api', type: 'http', role: 'provider',
      repo: 'backend', confidence: 0.9
    })\`);
    const rows = await queryBridge(
      handle,
      'MATCH (c:Contract) RETURN c.repo AS repo, c.confidence AS confidence',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].repo, 'backend');
    assert.equal(rows[0].confidence, 0.9);

    const parameterizedRows = await queryBridge(
      handle,
      'MATCH (c:Contract) WHERE c.repo = $r RETURN c.repo AS repo',
      { r: 'backend' },
    );
    assert.equal(parameterizedRows.length, 1);
    assert.equal(parameterizedRows[0].repo, 'backend');
    await closeBridgeDb(handle);
    `);
  });

  it('uses stable full SHA-256 contract node IDs', () => {
    const id = contractNodeId('backend', 'http::GET::/api', 'provider', 'src/routes.ts');
    expect(id).toHaveLength(64);
    expect(contractNodeId('backend', 'http::GET::/api', 'provider', 'src/routes.ts')).toBe(id);
    expect(contractNodeId('backend', 'http::GET::/api', 'provider', 'src/other.ts')).not.toBe(id);
  });

  it('writes bridge data and returns queryable persisted rows', () => {
    runNativeBridgeScenario(`
    await writeBridge(tmpDir, {
      contracts: [makeContract()],
      crossLinks: [],
      repoSnapshots: { backend: { indexedAt: '2026-01-01', lastCommit: 'abc' } },
      missingRepos: ['missing-repo'],
    });
    assert.equal(await bridgeExists(tmpDir), true);

    const report = await writeBridge(tmpDir, {
      contracts: [makeContract(), makeContract({ repo: 'frontend', role: 'consumer' })],
      crossLinks: [],
      repoSnapshots: { backend: { indexedAt: '2026-01-01', lastCommit: 'abc' } },
      missingRepos: [],
    });
    assert.equal(report.contractsInserted, 2);
    assert.equal(report.contractsFailed, 0);
    assert.equal(report.snapshotsInserted, 1);
    assert.equal(report.snapshotsFailed, 0);
    assert.equal(report.linksInserted, 0);
    assert.equal(report.linksFailed, 0);
    assert.equal(report.linksDroppedMissingNode, 0);
    assert.equal(report.sampleErrors.length, 0);

    const handle = await openBridgeDbReadOnly(tmpDir);
    assert.ok(handle);
    const rows = await queryBridge(handle, 'MATCH (c:Contract) RETURN c.repo AS repo');
    assert.equal(rows.length, 2);
    await closeBridgeDb(handle);
    `);
  });

  it('counts dropped links whose endpoints are missing', () => {
    runNativeBridgeScenario(`
    const provider = makeContract({ role: 'provider' });
    const report = await writeBridge(tmpDir, {
      contracts: [provider],
      crossLinks: [
        {
          from: {
            repo: 'ghost',
            symbolUid: '',
            symbolRef: { filePath: 'nowhere.ts', name: 'ghostFn' },
          },
          to: {
            repo: provider.repo,
            symbolUid: provider.symbolUid,
            symbolRef: provider.symbolRef,
          },
          type: 'http',
          contractId: provider.contractId,
          matchType: 'exact',
          confidence: 1.0,
        },
      ],
      repoSnapshots: {},
      missingRepos: [],
    });
    assert.equal(report.linksInserted, 0);
    assert.equal(report.linksDroppedMissingNode, 1);
    assert.equal(report.linksFailed, 0);
    assert.equal(report.contractsInserted, 1);
    `);
  });

  it('persists metadata and repo snapshots', () => {
    runNativeBridgeScenario(`
    await writeBridge(tmpDir, {
      contracts: [],
      crossLinks: [],
      repoSnapshots: { 'hr/backend': { indexedAt: '2026-01-01', lastCommit: 'abc' } },
      missingRepos: ['repo-a', 'repo-b'],
    });
    const meta = await readBridgeMeta(tmpDir);
    assert.deepEqual(meta.missingRepos, ['repo-a', 'repo-b']);
    assert.ok(meta.version > 0);
    assert.ok(meta.generatedAt);

    const handle = await openBridgeDbReadOnly(tmpDir);
    assert.ok(handle);
    const rows = await queryBridge(
      handle,
      'MATCH (s:RepoSnapshot) RETURN s.id AS id, s.indexedAt AS indexedAt',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'hr/backend');
    assert.equal(rows[0].indexedAt, '2026-01-01');
    await closeBridgeDb(handle);
    `);
  });

  it('persists cross-links and deduplicates contract/link rows', () => {
    runNativeBridgeScenario(`
    const provider = makeContract({ repo: 'backend', role: 'provider' });
    const consumer = makeContract({
      repo: 'frontend',
      role: 'consumer',
      symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' },
      symbolName: 'fetchUsers',
    });
    const link = {
      from: {
        repo: 'frontend',
        symbolUid: '',
        symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' },
      },
      to: {
        repo: 'backend',
        symbolUid: 'uid-1',
        symbolRef: { filePath: 'src/routes.ts', name: 'getUsers' },
      },
      type: 'http',
      contractId: 'http::GET::/api/users',
      matchType: 'exact',
      confidence: 1.0,
    };
    await writeBridge(tmpDir, {
      contracts: [provider, consumer],
      crossLinks: [link],
      repoSnapshots: {},
      missingRepos: [],
    });
    const handle = await openBridgeDbReadOnly(tmpDir);
    assert.ok(handle);
    const rows = await queryBridge(
      handle,
      'MATCH (a:Contract)-[l:ContractLink]->(b:Contract) RETURN l.fromRepo AS fromRepo, l.toRepo AS toRepo, l.matchType AS matchType',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fromRepo, 'frontend');
    assert.equal(rows[0].toRepo, 'backend');
    assert.equal(rows[0].matchType, 'exact');
    await closeBridgeDb(handle);

    const providerManifest = makeContract({
      repo: 'backend',
      role: 'provider',
      symbolUid: '',
      symbolName: 'auth.AuthService/Login',
      symbolRef: { filePath: 'src/auth.proto', name: 'Login' },
      contractId: 'grpc::auth.AuthService/Login',
      type: 'grpc',
      meta: { source: 'manifest' },
    });
    const concreteProvider = makeContract({
      ...providerManifest,
      symbolUid: 'uid-auth-login',
      symbolName: 'Login',
      confidence: 0.85,
      meta: { source: 'analyze' },
    });
    const grpcConsumer = makeContract({
      repo: 'frontend',
      role: 'consumer',
      symbolUid: '',
      symbolName: 'auth.AuthService/Login',
      symbolRef: { filePath: 'src/client.ts', name: 'AuthServiceClient' },
      contractId: 'grpc::auth.AuthService/Login',
      type: 'grpc',
      meta: { source: 'manifest' },
    });
    const grpcLink = {
      from: {
        repo: 'frontend',
        symbolUid: '',
        symbolRef: { filePath: 'src/client.ts', name: 'AuthServiceClient' },
      },
      to: {
        repo: 'backend',
        symbolUid: '',
        symbolRef: { filePath: 'src/auth.proto', name: 'Login' },
      },
      type: 'grpc',
      contractId: 'grpc::auth.AuthService/Login',
      matchType: 'manifest',
      confidence: 1,
    };

    const dedupeDir = await fsp.mkdtemp(path.join(tmpDir, 'dedupe-'));
    await writeBridge(dedupeDir, {
      contracts: [providerManifest, concreteProvider, grpcConsumer],
      crossLinks: [grpcLink, { ...grpcLink }],
      repoSnapshots: {},
      missingRepos: [],
    });
    const dedupeHandle = await openBridgeDbReadOnly(dedupeDir);
    assert.ok(dedupeHandle);
    const contracts = await queryBridge(
      dedupeHandle,
      'MATCH (c:Contract) RETURN c.repo AS repo, c.symbolUid AS symbolUid, c.symbolName AS symbolName ORDER BY c.repo',
    );
    const links = await queryBridge(
      dedupeHandle,
      'MATCH (a:Contract)-[l:ContractLink]->(b:Contract) RETURN l.fromRepo AS fromRepo, l.toRepo AS toRepo',
    );
    assert.equal(contracts.length, 2);
    assert.deepEqual(contracts[0], {
      repo: 'backend',
      symbolUid: 'uid-auth-login',
      symbolName: 'Login',
    });
    assert.equal(links.length, 1);
    await closeBridgeDb(dedupeHandle);
    `);
  });

  it('handles missing bridge, read-only defaults, and overwrite', () => {
    runNativeBridgeScenario(`
    const missingHandle = await openBridgeDbReadOnly(path.join(tmpDir, 'nonexistent'));
    assert.equal(missingHandle, null);
    assert.equal(await bridgeExists(path.join(tmpDir, 'nonexistent')), false);
    const missingMeta = await readBridgeMeta(path.join(tmpDir, 'nonexistent'));
    assert.equal(missingMeta.version, 0);
    assert.equal(missingMeta.generatedAt, '');
    assert.deepEqual(missingMeta.missingRepos, []);

    await writeBridge(tmpDir, {
      contracts: [makeContract()],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: [],
    });
    await writeBridge(tmpDir, {
      contracts: [makeContract({ repo: 'new-repo' })],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: [],
    });
    const handle = await openBridgeDbReadOnly(tmpDir);
    assert.ok(handle);
    const rows = await queryBridge(handle, 'MATCH (c:Contract) RETURN c.repo AS repo');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].repo, 'new-repo');
    await closeBridgeDb(handle);
    `);
  });
});

describe('retryRename', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries on EBUSY and eventually succeeds', async () => {
    const attempts: Array<[string, string]> = [];
    let calls = 0;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (src, dst) => {
      attempts.push([String(src), String(dst)]);
      calls++;
      if (calls < 3) {
        const err = new Error('resource busy or locked') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return undefined;
    });

    await retryRename('/src/a', '/dst/b', 3);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(attempts.every(([s, d]) => s === '/src/a' && d === '/dst/b')).toBe(true);
  });

  it('rethrows non-retryable errors immediately', async () => {
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async () => {
      calls++;
      const err = new Error('no such file') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    await expect(retryRename('/src/a', '/dst/b', 5)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toBe(1);
  });

  it('gives up after the configured number of attempts', async () => {
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async () => {
      calls++;
      const err = new Error('locked') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    await expect(retryRename('/src/a', '/dst/b', 3)).rejects.toMatchObject({ code: 'EPERM' });
    expect(calls).toBe(3);
  });

  it('retries on EACCES as well', async () => {
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async () => {
      calls++;
      if (calls < 2) {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return undefined;
    });

    await retryRename('/src/a', '/dst/b', 3);
    expect(calls).toBe(2);
  });
});

describe('findContractNode', () => {
  it('returns null on empty index', () => {
    const index = createContractLookupIndex();
    expect(findContractNode(index, 'backend', 'provider', 'uid-1', 'src/a.ts', 'foo')).toBeNull();
  });

  it('tier 1: returns contract matched by symbolUid', () => {
    const index = createContractLookupIndex();
    const c = makeContract({ symbolUid: 'uid-42', repo: 'backend', role: 'provider' });
    indexContract(index, c, 'node-A');
    expect(findContractNode(index, 'backend', 'provider', 'uid-42', 'anywhere.ts', 'anyName')).toBe(
      'node-A',
    );
  });

  it('tier 1 is repo-scoped: same uid in a different repo does not match', () => {
    const index = createContractLookupIndex();
    const c = makeContract({ symbolUid: 'uid-42', repo: 'backend' });
    indexContract(index, c, 'node-A');
    expect(
      findContractNode(index, 'frontend', 'provider', 'uid-42', 'src/routes.ts', 'getUsers'),
    ).toBeNull();
  });

  it('tier 1 is role-scoped: provider uid match does not resolve consumer query', () => {
    const index = createContractLookupIndex();
    const c = makeContract({ symbolUid: 'uid-42', role: 'provider', repo: 'backend' });
    indexContract(index, c, 'node-A');
    expect(
      findContractNode(index, 'backend', 'consumer', 'uid-42', 'src/routes.ts', 'getUsers'),
    ).toBeNull();
  });

  it('tier 2: falls through to filePath + symbolName when symbolUid is empty', () => {
    const index = createContractLookupIndex();
    const c = makeContract({
      symbolUid: '',
      symbolRef: { filePath: 'src/ctrl.ts', name: 'handler' },
      symbolName: 'handler',
    });
    indexContract(index, c, 'node-B');
    expect(findContractNode(index, 'backend', 'provider', '', 'src/ctrl.ts', 'handler')).toBe(
      'node-B',
    );
  });

  it('tier 2: falls through when the given symbolUid does not match anything', () => {
    const index = createContractLookupIndex();
    const c = makeContract({
      symbolUid: 'uid-real',
      symbolRef: { filePath: 'src/ctrl.ts', name: 'handler' },
    });
    indexContract(index, c, 'node-B');
    expect(
      findContractNode(index, 'backend', 'provider', 'uid-wrong', 'src/ctrl.ts', 'handler'),
    ).toBe('node-B');
  });

  it('tier 3: resolves by filePath alone when exactly one contract lives there', () => {
    const index = createContractLookupIndex();
    const c = makeContract({
      symbolUid: '',
      symbolRef: { filePath: 'src/solo.ts', name: 'actualName' },
    });
    indexContract(index, c, 'node-C');
    expect(findContractNode(index, 'backend', 'provider', '', 'src/solo.ts', 'wrongName')).toBe(
      'node-C',
    );
  });

  it('tier 3: does NOT resolve when multiple contracts live in the same file', () => {
    const index = createContractLookupIndex();
    const a = makeContract({
      symbolUid: '',
      symbolRef: { filePath: 'src/multi.ts', name: 'handlerA' },
    });
    const b = makeContract({
      symbolUid: '',
      symbolRef: { filePath: 'src/multi.ts', name: 'handlerB' },
      contractId: 'http::GET::/api/b',
    });
    indexContract(index, a, 'node-MA');
    indexContract(index, b, 'node-MB');
    expect(
      findContractNode(index, 'backend', 'provider', '', 'src/multi.ts', 'unknown'),
    ).toBeNull();
  });

  it('prefers tier 1 over tier 2 when both could resolve', () => {
    const index = createContractLookupIndex();
    const tier1Contract = makeContract({
      symbolUid: 'uid-1',
      symbolRef: { filePath: 'src/a.ts', name: 'first' },
    });
    const tier2Contract = makeContract({
      symbolUid: '',
      symbolRef: { filePath: 'src/a.ts', name: 'first' },
      contractId: 'http::POST::/api/x',
    });
    indexContract(index, tier1Contract, 'tier1-id');
    indexContract(index, tier2Contract, 'tier2-id');
    expect(findContractNode(index, 'backend', 'provider', 'uid-1', 'src/a.ts', 'first')).toBe(
      'tier1-id',
    );
  });
});
