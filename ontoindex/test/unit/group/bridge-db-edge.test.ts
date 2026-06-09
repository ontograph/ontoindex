import { describe, it } from 'vitest';
import { runNativeBridgeScenario } from '../../helpers/native-bridge-child.js';

const describeNativeBridge = process.platform === 'win32' ? describe.skip : describe;

describeNativeBridge('bridge-db edge cases', () => {
  it('rejects incompatible bridge schema versions', () => {
    runNativeBridgeScenario(`
    await fsp.writeFile(path.join(tmpDir, 'bridge.lbug'), 'dummy');
    await fsp.writeFile(
      path.join(tmpDir, 'meta.json'),
      JSON.stringify({ version: 999, generatedAt: '', missingRepos: [] }),
    );

    const handle = await openBridgeDbReadOnly(tmpDir);
    assert.equal(handle, null);
    `);
  });

  it('recovers bridge.lbug from a backup sidecar', () => {
    runNativeBridgeScenario(`
    await writeBridge(tmpDir, {
      contracts: [makeContract()],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: [],
    });
    const dbPath = path.join(tmpDir, 'bridge.lbug');
    const bakPath = path.join(tmpDir, 'bridge.lbug.bak');
    await fsp.rename(dbPath, bakPath);

    const handle = await openBridgeDbReadOnly(tmpDir);
    assert.ok(handle);
    const rows = await queryBridge(handle, 'MATCH (c:Contract) RETURN c.repo AS repo');
    assert.equal(rows.length, 1);
    await closeBridgeDb(handle);
    `);
  });

  it('skips cross-links with a missing destination node', () => {
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
        repo: 'nonexistent-repo',
        symbolUid: 'uid-missing',
        symbolRef: { filePath: 'src/missing.ts', name: 'missingFn' },
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
      'MATCH (a:Contract)-[l:ContractLink]->(b:Contract) RETURN l.matchType AS matchType',
    );
    assert.equal(rows.length, 0);
    const contractRows = await queryBridge(handle, 'MATCH (c:Contract) RETURN c.repo AS repo');
    assert.equal(contractRows.length, 2);
    await closeBridgeDb(handle);
    `);
  });

  it('persists manifest gRPC links with symbol UIDs', () => {
    runNativeBridgeScenario(`
    const provider = makeContract({
      contractId: 'grpc::auth.AuthService/Login',
      type: 'grpc',
      role: 'provider',
      repo: 'platform/auth',
      symbolUid: 'uid-auth-login',
      symbolRef: { filePath: 'src/auth.proto', name: 'Login' },
      symbolName: 'auth.AuthService/Login',
    });
    const consumer = makeContract({
      contractId: 'grpc::auth.AuthService/Login',
      type: 'grpc',
      role: 'consumer',
      repo: 'platform/orders',
      symbolUid: 'uid-orders-client',
      symbolRef: { filePath: 'src/client.ts', name: 'AuthServiceClient' },
      symbolName: 'auth.AuthService/Login',
    });
    const link = {
      from: {
        repo: 'platform/orders',
        symbolUid: 'uid-orders-client',
        symbolRef: { filePath: 'src/client.ts', name: 'AuthServiceClient' },
      },
      to: {
        repo: 'platform/auth',
        symbolUid: 'uid-auth-login',
        symbolRef: { filePath: 'src/auth.proto', name: 'Login' },
      },
      type: 'grpc',
      contractId: 'grpc::auth.AuthService/Login',
      matchType: 'manifest',
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
      \`MATCH (a:Contract)-[l:ContractLink]->(b:Contract)
       RETURN l.contractId AS contractId, l.matchType AS matchType, l.fromRepo AS fromRepo, l.toRepo AS toRepo\`,
    );
    assert.deepEqual(rows, [
      {
        contractId: 'grpc::auth.AuthService/Login',
        matchType: 'manifest',
        fromRepo: 'platform/orders',
        toRepo: 'platform/auth',
      },
    ]);
    await closeBridgeDb(handle);
    `);
  });
});
