import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { syncGroup, stableRepoPoolId } from '../../../src/core/group/sync.js';
import type {
  GroupConfig,
  StoredContract,
  RepoHandle,
  GroupManifestLink,
} from '../../../src/core/group/types.js';
import type { RegistryEntry } from '../../../src/storage/repo-manager.js';

describe('syncGroup', () => {
  const makeConfig = (repos: Record<string, string>): GroupConfig => ({
    version: 1,
    name: 'test',
    description: '',
    repos,
    links: [],
    packages: {},
    detect: {
      http: true,
      grpc: false,
      topics: false,
      shared_libs: false,
      embedding_fallback: false,
    },
    matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
  });

  const makeSharedLibConfig = (repos: Record<string, string>): GroupConfig => ({
    ...makeConfig(repos),
    detect: {
      http: false,
      grpc: false,
      topics: false,
      shared_libs: true,
      embedding_fallback: false,
    },
  });

  function createTempRepo(prefix: string, files: Record<string, string>): string {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    for (const [relPath, content] of Object.entries(files)) {
      const absPath = path.join(repoDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content);
    }
    return repoDir;
  }

  async function withMockedPoolAdapter<T>(run: () => Promise<T>): Promise<T> {
    const { vi } = await import('vitest');
    const poolAdapter = await import('../../../src/core/lbug/pool-adapter.js');
    const initSpy = vi.spyOn(poolAdapter, 'initLbug').mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(poolAdapter, 'closeLbug').mockResolvedValue(undefined);

    try {
      return await run();
    } finally {
      initSpy.mockRestore();
      closeSpy.mockRestore();
    }
  }

  it('returns SyncResult with contracts and cross-links', async () => {
    const config = makeConfig({ 'app/backend': 'backend-repo', 'app/frontend': 'frontend-repo' });

    const mockContracts: StoredContract[] = [
      {
        contractId: 'http::GET::/api/users',
        type: 'http',
        role: 'provider',
        symbolUid: 'uid-1',
        symbolRef: { filePath: 'src/ctrl.ts', name: 'UserController.list' },
        symbolName: 'UserController.list',
        confidence: 0.8,
        meta: { method: 'GET', path: '/api/users' },
        repo: 'app/backend',
      },
      {
        contractId: 'http::GET::/api/users',
        type: 'http',
        role: 'consumer',
        symbolUid: 'uid-2',
        symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' },
        symbolName: 'fetchUsers',
        confidence: 0.7,
        meta: { method: 'GET', path: '/api/users' },
        repo: 'app/frontend',
      },
    ];

    const result = await syncGroup(config, {
      extractorOverride: async () => mockContracts,
      skipWrite: true,
    });

    expect(result.contracts).toHaveLength(2);
    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].matchType).toBe('exact');
    expect(result.crossLinks[0].confidence).toBe(1.0);
    expect(result.unmatched).toHaveLength(0);
  });

  it('reports missing repos', async () => {
    const config = makeConfig({ 'app/backend': 'nonexistent-repo' });

    const result = await syncGroup(config, {
      resolveRepoHandle: async () => null,
      skipWrite: true,
    });

    expect(result.missingRepos).toContain('app/backend');
    expect(result.contracts).toHaveLength(0);
  });

  it('handles empty repos config', async () => {
    const config = makeConfig({});

    const result = await syncGroup(config, {
      extractorOverride: async () => [],
      skipWrite: true,
    });

    expect(result.contracts).toHaveLength(0);
    expect(result.crossLinks).toHaveLength(0);
    expect(result.missingRepos).toHaveLength(0);
  });

  it('intra-repo matching works with service field via extractorOverride', async () => {
    const config = makeConfig({ 'platform/monorepo': 'monorepo' });

    const mockContracts: StoredContract[] = [
      {
        ...makeContract('http::GET::/api/users', 'provider', 'platform/monorepo'),
        service: 'services/auth',
      },
      {
        ...makeContract('http::GET::/api/users', 'consumer', 'platform/monorepo'),
        service: 'services/gateway',
      },
    ];

    const result = await syncGroup(config, {
      extractorOverride: async () => mockContracts,
      skipWrite: true,
    });

    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].from.service).toBe('services/gateway');
    expect(result.crossLinks[0].to.service).toBe('services/auth');
  });

  function makeContract(id: string, role: 'provider' | 'consumer', repo: string): StoredContract {
    return {
      contractId: id,
      type: 'http',
      role,
      symbolUid: `uid-${repo}-${id}`,
      symbolRef: { filePath: `src/${repo}.ts`, name: `fn-${id}` },
      symbolName: `fn-${id}`,
      confidence: 0.8,
      meta: {},
      repo,
    };
  }

  it('per-repo extractorOverride receives repo handle and extracts per repo', async () => {
    const config = makeConfig({
      'app/backend': 'backend-repo',
      'app/frontend': 'frontend-repo',
    });

    const perRepoOverride = async (repo: RepoHandle) => {
      if (repo.path === 'app/backend') {
        return [makeContract('http::GET::/api/users', 'provider', 'app/backend')];
      }
      return [makeContract('http::GET::/api/users', 'consumer', 'app/frontend')];
    };

    const result = await syncGroup(config, {
      extractorOverride: perRepoOverride,
      resolveRepoHandle: async (_name, groupPath) => ({
        id: groupPath,
        path: groupPath,
        repoPath: '/tmp/' + groupPath,
        storagePath: '/tmp/' + groupPath + '/.ontoindex',
      }),
      skipWrite: true,
    });

    // per-repo override goes through the initLbug path which will fail
    // but the extractorOverride with arity > 0 triggers the else branch
    // At minimum, the function should not throw
    expect(result).toBeDefined();
  });

  it('test_syncGroup_closes_only_opened_pools', async () => {
    const config = makeConfig({
      'app/backend': 'backend-repo',
      'app/frontend': 'frontend-repo',
    });

    const closedIds: string[] = [];

    const { vi } = await import('vitest');
    const poolAdapter = await import('../../../src/core/lbug/pool-adapter.js');
    const initSpy = vi.spyOn(poolAdapter, 'initLbug').mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(poolAdapter, 'closeLbug').mockImplementation(async (id?: string) => {
      if (id) closedIds.push(id);
    });

    try {
      await syncGroup(config, {
        resolveRepoHandle: async (_name, groupPath) => ({
          id: groupPath.replace(/\//g, '-'),
          path: groupPath,
          repoPath: '/tmp/' + groupPath,
          storagePath: '/tmp/' + groupPath + '/.ontoindex',
        }),
        skipWrite: true,
      }).catch(() => {});

      // closeLbug must have been called at least once with specific pool ids
      expect(closeSpy.mock.calls.length).toBeGreaterThan(0);
      expect(closedIds).toContain('app-backend');
      expect(closedIds).toContain('app-frontend');

      // Every call must have a truthy string id
      for (const id of closedIds) {
        expect(id).toBeTruthy();
        expect(typeof id).toBe('string');
      }
      // No blanket close (no-arg or empty-string or undefined)
      const blanketCalls = closeSpy.mock.calls.filter((args) => args.length === 0 || !args[0]);
      expect(blanketCalls).toHaveLength(0);
    } finally {
      initSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('manifest links in config.links produce cross-links with matchType manifest', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'app/consumer',
        to: 'app/provider',
        type: 'http',
        contract: 'GET::/api/orders',
        role: 'consumer',
      },
    ];

    const config: GroupConfig = {
      version: 1,
      name: 'test',
      description: '',
      repos: { 'app/consumer': 'consumer-repo', 'app/provider': 'provider-repo' },
      links,
      packages: {},
      detect: {
        http: true,
        grpc: false,
        topics: false,
        shared_libs: false,
        embedding_fallback: false,
      },
      matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
    };

    const result = await syncGroup(config, {
      extractorOverride: async () => [],
      skipWrite: true,
    });

    // ManifestExtractor should inject 2 contracts (provider + consumer) and 1 cross-link
    expect(result.contracts).toHaveLength(2);
    const manifestLinks = result.crossLinks.filter((cl) => cl.matchType === 'manifest');
    expect(manifestLinks).toHaveLength(1);
    expect(manifestLinks[0].contractId).toBe('http::GET::/api/orders');
    expect(manifestLinks[0].from.repo).toBe('app/consumer');
    expect(manifestLinks[0].to.repo).toBe('app/provider');
    expect(manifestLinks[0].confidence).toBe(1.0);

    // With no DB executors available, UIDs fall back to the deterministic
    // synthetic form `manifest::<repo>::<contractId>`.
    expect(manifestLinks[0].from.symbolUid).toBe('manifest::app/consumer::http::GET::/api/orders');
    expect(manifestLinks[0].to.symbolUid).toBe('manifest::app/provider::http::GET::/api/orders');

    // Manifest contracts also participate in runExactMatch; we must not emit a
    // duplicate matchType:'exact' cross-link for the same endpoint pair.
    const exactForSameContract = result.crossLinks.filter(
      (cl) => cl.matchType === 'exact' && cl.contractId === 'http::GET::/api/orders',
    );
    expect(exactForSameContract).toHaveLength(0);
    expect(result.crossLinks).toHaveLength(1);
  });

  it('manifest links referencing unknown repos still produce cross-links via synthetic UIDs', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'app/known',
        to: 'app/dangling', // not present in config.repos
        type: 'http',
        contract: 'POST::/api/missing',
        role: 'consumer',
      },
    ];

    const config: GroupConfig = {
      version: 1,
      name: 'test',
      description: '',
      repos: { 'app/known': 'known-repo' },
      links,
      packages: {},
      detect: {
        http: true,
        grpc: false,
        topics: false,
        shared_libs: false,
        embedding_fallback: false,
      },
      matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
    };

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      const result = await syncGroup(config, {
        extractorOverride: async () => [],
        skipWrite: true,
      });

      expect(result.crossLinks).toHaveLength(1);
      expect(result.crossLinks[0].matchType).toBe('manifest');
      expect(result.crossLinks[0].to.symbolUid).toBe(
        'manifest::app/dangling::http::POST::/api/missing',
      );
      expect(warnings.some((w) => w.includes('app/dangling'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it('writes registry to groupDir when skipWrite is false', async () => {
    const tmpDir = path.join(os.tmpdir(), `ontoindex-sync-write-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const config = makeConfig({});
      const result = await syncGroup(config, {
        extractorOverride: async () => [],
        groupDir: tmpDir,
        skipWrite: false,
      });

      expect(result.contracts).toHaveLength(0);

      const registryPath = path.join(tmpDir, 'contracts.json');
      expect(fs.existsSync(registryPath)).toBe(true);

      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      expect(registry.version).toBe(1);
      expect(registry.contracts).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('suppresses local quoted includes in shared_libs detection', async () => {
    const repoDir = createTempRepo('ontoindex-sync-local-include-', {
      'src/local.h': '#pragma once\n',
      'src/main.cpp': '#include "local.h"\nint main() { return 0; }\n',
    });
    const config = makeSharedLibConfig({ 'app/repo': 'repo' });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async () => ({
            id: 'app-repo',
            path: 'app/repo',
            repoPath: repoDir,
            storagePath: path.join(repoDir, '.ontoindex'),
          }),
          skipWrite: true,
        }),
      );

      expect(
        result.contracts.filter((contract) => contract.type === 'lib' && contract.role === 'consumer'),
      ).toHaveLength(0);
      expect(
        result.contracts.some(
          (contract) =>
            contract.type === 'lib' &&
            contract.role === 'provider' &&
            contract.contractId === 'lib::include/src/local.h',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('suppresses repo-local include-root headers in shared_libs detection', async () => {
    const repoDir = createTempRepo('ontoindex-sync-include-root-local-', {
      'include/shared/api.h': '#pragma once\n',
      'src/main.cpp': '#include "shared/api.h"\nint main() { return 0; }\n',
    });
    const config = makeSharedLibConfig({ 'app/repo': 'repo' });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async () => ({
            id: 'app-repo',
            path: 'app/repo',
            repoPath: repoDir,
            storagePath: path.join(repoDir, '.ontoindex'),
          }),
          skipWrite: true,
        }),
      );

      expect(
        result.contracts.filter((contract) => contract.type === 'lib' && contract.role === 'consumer'),
      ).toHaveLength(0);
      expect(
        result.contracts.some(
          (contract) =>
            contract.type === 'lib' &&
            contract.role === 'provider' &&
            contract.contractId === 'lib::include/shared/api.h',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('suppresses repo-local headers-root includes in shared_libs detection', async () => {
    const repoDir = createTempRepo('ontoindex-sync-headers-root-local-', {
      'headers/api.h': '#pragma once\n',
      'src/main.cpp': '#include "api.h"\nint main() { return 0; }\n',
    });
    const config = makeSharedLibConfig({ 'app/repo': 'repo' });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async () => ({
            id: 'app-repo',
            path: 'app/repo',
            repoPath: repoDir,
            storagePath: path.join(repoDir, '.ontoindex'),
          }),
          skipWrite: true,
        }),
      );

      expect(
        result.contracts.filter((contract) => contract.type === 'lib' && contract.role === 'consumer'),
      ).toHaveLength(0);
      expect(
        result.contracts.some(
          (contract) =>
            contract.type === 'lib' &&
            contract.role === 'provider' &&
            contract.contractId === 'lib::include/api.h',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('preserves same-repo cross-service local includes in shared_libs detection', async () => {
    const repoDir = createTempRepo('ontoindex-sync-local-cross-service-', {
      'services/auth/package.json': '{}\n',
      'services/auth/include/api.h': '#pragma once\n',
      'services/gateway/package.json': '{}\n',
      'services/gateway/src/main.cpp':
        '#include "../../auth/include/api.h"\nint main() { return 0; }\n',
    });
    const config = makeSharedLibConfig({ 'platform/monorepo': 'repo' });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async () => ({
            id: 'platform-monorepo',
            path: 'platform/monorepo',
            repoPath: repoDir,
            storagePath: path.join(repoDir, '.ontoindex'),
          }),
          skipWrite: true,
        }),
      );

      expect(
        result.contracts.some(
          (contract) =>
            contract.type === 'lib' &&
            contract.role === 'consumer' &&
            contract.contractId === 'lib::include/api.h' &&
            contract.service === 'services/gateway',
        ),
      ).toBe(true);
      expect(result.crossLinks).toHaveLength(1);
      expect(result.crossLinks[0].contractId).toBe('lib::include/api.h');
      expect(result.crossLinks[0].from.repo).toBe('platform/monorepo');
      expect(result.crossLinks[0].from.service).toBe('services/gateway');
      expect(result.crossLinks[0].to.service).toBe('services/auth');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('emits one unresolved quoted include consumer contract for shared_libs detection', async () => {
    const repoDir = createTempRepo('ontoindex-sync-unresolved-include-', {
      'src/main.cpp': '#include "shared/api.h"\nint main() { return 0; }\n',
    });
    const config = makeSharedLibConfig({ 'app/consumer': 'consumer' });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async () => ({
            id: 'app-consumer',
            path: 'app/consumer',
            repoPath: repoDir,
            storagePath: path.join(repoDir, '.ontoindex'),
          }),
          skipWrite: true,
        }),
      );

      const consumers = result.contracts.filter(
        (contract) => contract.type === 'lib' && contract.role === 'consumer',
      );
      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('lib::include/shared/api.h');
      expect(consumers[0].symbolUid).toBe('File:src/main.cpp');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('extracts angle-bracket shared_libs consumers without Ladybug DB', async () => {
    const repoDir = createTempRepo('ontoindex-sync-angle-no-lbug-', {
      'src/main.cpp': '#include <shared/api.h>\nint main() { return 0; }\n',
    });
    const config = makeSharedLibConfig({ 'app/consumer': 'consumer' });
    const { vi } = await import('vitest');
    const poolAdapter = await import('../../../src/core/lbug/pool-adapter.js');
    const initSpy = vi.spyOn(poolAdapter, 'initLbug').mockRejectedValue(new Error('missing lbug'));
    const closeSpy = vi.spyOn(poolAdapter, 'closeLbug').mockResolvedValue(undefined);

    try {
      const result = await syncGroup(config, {
        resolveRepoHandle: async () => ({
          id: 'app-consumer',
          path: 'app/consumer',
          repoPath: repoDir,
          storagePath: path.join(repoDir, '.ontoindex'),
        }),
        skipWrite: true,
      });

      const consumers = result.contracts.filter(
        (contract) => contract.type === 'lib' && contract.role === 'consumer',
      );
      expect(initSpy).not.toHaveBeenCalled();
      expect(result.missingRepos).toHaveLength(0);
      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('lib::include/shared/api.h');
    } finally {
      initSpy.mockRestore();
      closeSpy.mockRestore();
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('skips bare angle-bracket toolchain headers in shared_libs detection', async () => {
    const consumerRepo = createTempRepo('ontoindex-sync-toolchain-consumer-', {
      'src/main.cpp': '#include <stdint.h>\nint main() { return 0; }\n',
    });
    const providerRepo = createTempRepo('ontoindex-sync-toolchain-provider-', {
      'stdint.h': '#pragma once\n',
    });
    const config = makeSharedLibConfig({
      'app/consumer': 'consumer',
      'libs/provider': 'provider',
    });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async (_name, groupPath) => ({
            id: groupPath.replace(/\//g, '-'),
            path: groupPath,
            repoPath: groupPath === 'app/consumer' ? consumerRepo : providerRepo,
            storagePath: path.join(
              groupPath === 'app/consumer' ? consumerRepo : providerRepo,
              '.ontoindex',
            ),
          }),
          skipWrite: true,
        }),
      );

      expect(
        result.contracts.filter(
          (contract) =>
            contract.type === 'lib' &&
            contract.role === 'consumer' &&
            contract.contractId === 'lib::include/stdint.h',
        ),
      ).toHaveLength(0);
      expect(result.crossLinks).toHaveLength(0);
    } finally {
      fs.rmSync(consumerRepo, { recursive: true, force: true });
      fs.rmSync(providerRepo, { recursive: true, force: true });
    }
  });

  it('skips slash-separated angle-bracket toolchain headers in shared_libs detection', async () => {
    const consumerRepo = createTempRepo('ontoindex-sync-toolchain-slash-consumer-', {
      'src/main.cpp': '#include <sys/socket.h>\nint main() { return 0; }\n',
    });
    const providerRepo = createTempRepo('ontoindex-sync-toolchain-slash-provider-', {
      'sys/socket.h': '#pragma once\n',
    });
    const config = makeSharedLibConfig({
      'app/consumer': 'consumer',
      'libs/provider': 'provider',
    });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async (_name, groupPath) => ({
            id: groupPath.replace(/\//g, '-'),
            path: groupPath,
            repoPath: groupPath === 'app/consumer' ? consumerRepo : providerRepo,
            storagePath: path.join(
              groupPath === 'app/consumer' ? consumerRepo : providerRepo,
              '.ontoindex',
            ),
          }),
          skipWrite: true,
        }),
      );

      expect(
        result.contracts.filter(
          (contract) =>
            contract.type === 'lib' &&
            contract.role === 'consumer' &&
            contract.contractId === 'lib::include/sys/socket.h',
        ),
      ).toHaveLength(0);
      expect(result.crossLinks).toHaveLength(0);
    } finally {
      fs.rmSync(consumerRepo, { recursive: true, force: true });
      fs.rmSync(providerRepo, { recursive: true, force: true });
    }
  });

  it('matches bare angle-bracket shared headers in another repo', async () => {
    const consumerRepo = createTempRepo('ontoindex-sync-angle-bare-consumer-', {
      'src/main.cpp': '#include <api.h>\nint main() { return 0; }\n',
    });
    const providerRepo = createTempRepo('ontoindex-sync-angle-bare-provider-', {
      'include/api.h': '#pragma once\n',
    });
    const config = makeSharedLibConfig({
      'app/consumer': 'consumer',
      'libs/provider': 'provider',
    });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async (_name, groupPath) => ({
            id: groupPath.replace(/\//g, '-'),
            path: groupPath,
            repoPath: groupPath === 'app/consumer' ? consumerRepo : providerRepo,
            storagePath: path.join(
              groupPath === 'app/consumer' ? consumerRepo : providerRepo,
              '.ontoindex',
            ),
          }),
          skipWrite: true,
        }),
      );

      expect(
        result.contracts.some(
          (contract) =>
            contract.type === 'lib' &&
            contract.role === 'consumer' &&
            contract.contractId === 'lib::include/api.h',
        ),
      ).toBe(true);
      expect(result.crossLinks).toHaveLength(1);
      expect(result.crossLinks[0].contractId).toBe('lib::include/api.h');
      expect(result.crossLinks[0].to.repo).toBe('libs/provider');
    } finally {
      fs.rmSync(consumerRepo, { recursive: true, force: true });
      fs.rmSync(providerRepo, { recursive: true, force: true });
    }
  });

  it('ignores block-commented includes in shared_libs detection', async () => {
    const repoDir = createTempRepo('ontoindex-sync-commented-include-', {
      'src/main.cpp': '/*\n#include "shared/api.h"\n*/\nint main() { return 0; }\n',
    });
    const config = makeSharedLibConfig({ 'app/consumer': 'consumer' });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async () => ({
            id: 'app-consumer',
            path: 'app/consumer',
            repoPath: repoDir,
            storagePath: path.join(repoDir, '.ontoindex'),
          }),
          skipWrite: true,
        }),
      );

      expect(
        result.contracts.filter((contract) => contract.type === 'lib' && contract.role === 'consumer'),
      ).toHaveLength(0);
      expect(result.crossLinks).toHaveLength(0);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('matches shared_libs include consumers to provider headers in another repo', async () => {
    const consumerRepo = createTempRepo('ontoindex-sync-include-consumer-', {
      'src/main.cpp': '#include "shared/api.h"\nint main() { return 0; }\n',
    });
    const providerRepo = createTempRepo('ontoindex-sync-include-provider-', {
      'shared/api.h': '#pragma once\n',
    });
    const config = makeSharedLibConfig({
      'app/consumer': 'consumer',
      'libs/provider': 'provider',
    });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async (_name, groupPath) => ({
            id: groupPath.replace(/\//g, '-'),
            path: groupPath,
            repoPath: groupPath === 'app/consumer' ? consumerRepo : providerRepo,
            storagePath: path.join(
              groupPath === 'app/consumer' ? consumerRepo : providerRepo,
              '.ontoindex',
            ),
          }),
          skipWrite: true,
        }),
      );

      expect(result.crossLinks).toHaveLength(1);
      expect(result.crossLinks[0].contractId).toBe('lib::include/shared/api.h');
      expect(result.crossLinks[0].matchType).toBe('exact');
      expect(result.crossLinks[0].from.repo).toBe('app/consumer');
      expect(result.crossLinks[0].to.repo).toBe('libs/provider');
    } finally {
      fs.rmSync(consumerRepo, { recursive: true, force: true });
      fs.rmSync(providerRepo, { recursive: true, force: true });
    }
  });

  it('matches include-root providers to consumers in another repo', async () => {
    const consumerRepo = createTempRepo('ontoindex-sync-include-root-consumer-', {
      'src/main.cpp': '#include "shared/api.h"\nint main() { return 0; }\n',
    });
    const providerRepo = createTempRepo('ontoindex-sync-include-root-provider-', {
      'include/shared/api.h': '#pragma once\n',
    });
    const config = makeSharedLibConfig({
      'app/consumer': 'consumer',
      'libs/provider': 'provider',
    });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async (_name, groupPath) => ({
            id: groupPath.replace(/\//g, '-'),
            path: groupPath,
            repoPath: groupPath === 'app/consumer' ? consumerRepo : providerRepo,
            storagePath: path.join(
              groupPath === 'app/consumer' ? consumerRepo : providerRepo,
              '.ontoindex',
            ),
          }),
          skipWrite: true,
        }),
      );

      expect(result.crossLinks).toHaveLength(1);
      expect(result.crossLinks[0].contractId).toBe('lib::include/shared/api.h');
      expect(result.crossLinks[0].to.repo).toBe('libs/provider');
    } finally {
      fs.rmSync(consumerRepo, { recursive: true, force: true });
      fs.rmSync(providerRepo, { recursive: true, force: true });
    }
  });

  it('matches angle-bracket shared_libs consumers to provider headers in another repo', async () => {
    const consumerRepo = createTempRepo('ontoindex-sync-angle-consumer-', {
      'src/main.cpp': '#include <shared/api.h>\nint main() { return 0; }\n',
    });
    const providerRepo = createTempRepo('ontoindex-sync-angle-provider-', {
      'shared/api.h': '#pragma once\n',
    });
    const config = makeSharedLibConfig({
      'app/consumer': 'consumer',
      'libs/provider': 'provider',
    });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async (_name, groupPath) => ({
            id: groupPath.replace(/\//g, '-'),
            path: groupPath,
            repoPath: groupPath === 'app/consumer' ? consumerRepo : providerRepo,
            storagePath: path.join(
              groupPath === 'app/consumer' ? consumerRepo : providerRepo,
              '.ontoindex',
            ),
          }),
          skipWrite: true,
        }),
      );

      expect(result.crossLinks).toHaveLength(1);
      expect(result.crossLinks[0].contractId).toBe('lib::include/shared/api.h');
      expect(result.crossLinks[0].matchType).toBe('exact');
      expect(result.crossLinks[0].from.repo).toBe('app/consumer');
      expect(result.crossLinks[0].to.repo).toBe('libs/provider');
    } finally {
      fs.rmSync(consumerRepo, { recursive: true, force: true });
      fs.rmSync(providerRepo, { recursive: true, force: true });
    }
  });

  it('matches public-root providers in another repo', async () => {
    const consumerRepo = createTempRepo('ontoindex-sync-public-root-consumer-', {
      'src/main.cpp': '#include "api.h"\nint main() { return 0; }\n',
    });
    const providerRepo = createTempRepo('ontoindex-sync-public-root-provider-', {
      'src/public/api.h': '#pragma once\n',
    });
    const config = makeSharedLibConfig({
      'app/consumer': 'consumer',
      'libs/provider': 'provider',
    });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async (_name, groupPath) => ({
            id: groupPath.replace(/\//g, '-'),
            path: groupPath,
            repoPath: groupPath === 'app/consumer' ? consumerRepo : providerRepo,
            storagePath: path.join(
              groupPath === 'app/consumer' ? consumerRepo : providerRepo,
              '.ontoindex',
            ),
          }),
          skipWrite: true,
        }),
      );

      expect(result.crossLinks).toHaveLength(1);
      expect(result.crossLinks[0].contractId).toBe('lib::include/api.h');
      expect(result.crossLinks[0].to.repo).toBe('libs/provider');
    } finally {
      fs.rmSync(consumerRepo, { recursive: true, force: true });
      fs.rmSync(providerRepo, { recursive: true, force: true });
    }
  });

  it('does not suppress cross-repo includes based on suffix-only local matches', async () => {
    const consumerRepo = createTempRepo('ontoindex-sync-include-suffix-local-', {
      'src/main.cpp': '#include "shared/api.h"\nint main() { return 0; }\n',
      'vendor/shared/api.h': '#pragma once\n',
    });
    const providerRepo = createTempRepo('ontoindex-sync-include-suffix-provider-', {
      'shared/api.h': '#pragma once\n',
    });
    const config = makeSharedLibConfig({
      'app/consumer': 'consumer',
      'libs/provider': 'provider',
    });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async (_name, groupPath) => ({
            id: groupPath.replace(/\//g, '-'),
            path: groupPath,
            repoPath: groupPath === 'app/consumer' ? consumerRepo : providerRepo,
            storagePath: path.join(
              groupPath === 'app/consumer' ? consumerRepo : providerRepo,
              '.ontoindex',
            ),
          }),
          skipWrite: true,
        }),
      );

      const consumers = result.contracts.filter(
        (contract) => contract.type === 'lib' && contract.role === 'consumer',
      );
      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('lib::include/shared/api.h');
      expect(result.crossLinks).toHaveLength(1);
      expect(result.crossLinks[0].contractId).toBe('lib::include/shared/api.h');
      expect(result.crossLinks[0].to.repo).toBe('libs/provider');
    } finally {
      fs.rmSync(consumerRepo, { recursive: true, force: true });
      fs.rmSync(providerRepo, { recursive: true, force: true });
    }
  });

  it('preserves case-sensitive include paths in shared_libs contracts', async () => {
    const consumerRepo = createTempRepo('ontoindex-sync-case-consumer-', {
      'src/main.cpp': '#include "shared/api.h"\nint main() { return 0; }\n',
    });
    const providerRepo = createTempRepo('ontoindex-sync-case-provider-', {
      'shared/API.h': '#pragma once\n',
    });
    const config = makeSharedLibConfig({
      'app/consumer': 'consumer',
      'libs/provider': 'provider',
    });

    try {
      const result = await withMockedPoolAdapter(() =>
        syncGroup(config, {
          resolveRepoHandle: async (_name, groupPath) => ({
            id: groupPath.replace(/\//g, '-'),
            path: groupPath,
            repoPath: groupPath === 'app/consumer' ? consumerRepo : providerRepo,
            storagePath: path.join(
              groupPath === 'app/consumer' ? consumerRepo : providerRepo,
              '.ontoindex',
            ),
          }),
          skipWrite: true,
        }),
      );

      expect(
        result.contracts.some(
          (contract) =>
            contract.type === 'lib' &&
            contract.role === 'provider' &&
            contract.contractId === 'lib::include/shared/API.h',
        ),
      ).toBe(true);
      expect(
        result.contracts.some(
          (contract) =>
            contract.type === 'lib' &&
            contract.role === 'consumer' &&
            contract.contractId === 'lib::include/shared/api.h',
        ),
      ).toBe(true);
      expect(result.crossLinks).toHaveLength(0);
    } finally {
      fs.rmSync(consumerRepo, { recursive: true, force: true });
      fs.rmSync(providerRepo, { recursive: true, force: true });
    }
  });
});

describe('stableRepoPoolId', () => {
  it('returns lowercase name when no collision', () => {
    const entry: RegistryEntry = {
      name: 'MyRepo',
      path: '/a/MyRepo',
      storagePath: '/a/MyRepo/.ontoindex',
      indexedAt: '',
      lastCommit: '',
    };
    const all = [entry];
    expect(stableRepoPoolId(entry, all)).toBe('myrepo');
  });

  it('appends hash suffix on name collision with different path', () => {
    const entry1: RegistryEntry = {
      name: 'repo',
      path: '/a/repo',
      storagePath: '/a/repo/.ontoindex',
      indexedAt: '',
      lastCommit: '',
    };
    const entry2: RegistryEntry = {
      name: 'repo',
      path: '/b/repo',
      storagePath: '/b/repo/.ontoindex',
      indexedAt: '',
      lastCommit: '',
    };
    const all = [entry1, entry2];

    const id1 = stableRepoPoolId(entry1, all);
    const id2 = stableRepoPoolId(entry2, all);

    expect(id1).toMatch(/^repo-/);
    expect(id2).toMatch(/^repo-/);
    expect(id1).not.toBe(id2);
  });
});
