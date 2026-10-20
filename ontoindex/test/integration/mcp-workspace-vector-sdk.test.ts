import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import * as httpEmbeddings from '../../src/core/embeddings/http-client.js';
import * as embedder from '../../src/mcp/core/embedder.js';
import * as backendQuery from '../../src/mcp/local/backend-query.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { resetOverlaySnapshotCache } from '../../src/mcp/local/backend-overlay.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { resetFreshnessCache } from '../../src/mcp/super/ensure-fresh.js';

describe('workspace vector fallback over the real MCP SDK', () => {
  let root: string;
  let backend: LocalBackend;
  let client: Client;
  let server: ReturnType<typeof createMCPServer>;
  const repoName = 'workspace-vector-sdk';
  const symbol = 'workspaceVectorDirtyOnly';
  const vectorWarning =
    'Vector search is unavailable on the working-tree graph; results use full-text ranking only.';
  const policyWarning =
    'retrieval_policy symbol-neighborhood is unavailable on the working-tree graph and was ignored.';

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-workspace-vector-sdk-'));
    const home = path.join(root, 'home');
    const repo = path.join(root, repoName);
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    vi.stubEnv('ONTOINDEX_VECTOR_BACKEND', 'lbug');
    vi.stubEnv('ONTOINDEX_MCP_AUTO_ANALYZE', '0');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n');
    await fs.writeFile(
      path.join(repo, 'src/base.ts'),
      'export function baseline() { return 1; }\n',
    );
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-C',
          repo,
          ...args,
        ],
        { stdio: 'pipe' },
      );
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'workspace vector baseline');
    await runFullAnalysis(
      repo,
      {
        skipAgentsMd: true,
        noStats: true,
        registryName: repoName,
        embeddings: false,
      },
      { onProgress() {} },
    );
    await fs.writeFile(
      path.join(repo, 'src/dirty.ts'),
      `export function ${symbol}() { return 2; }\n`,
    );
    resetFreshnessCache();
    resetOverlaySnapshotCache();
    backend = new LocalBackend();
    await backend.init();
    server = createMCPServer(backend);
    client = new Client({ name: repoName, version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 240_000);

  afterAll(async () => {
    try {
      await client?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        try {
          await backend?.disconnect();
        } finally {
          resetFreshnessCache();
          resetOverlaySnapshotCache();
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
          if (root) await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  });

  for (const policy of [undefined, 'symbol-neighborhood']) {
    it(`returns the dirty symbol and explicit vector fallback for ${policy ?? 'plain'} search`, async () => {
      // Fail closed if either retrieval path tries to use committed-index vectors or a provider.
      const unexpectedEmbedding = async (): Promise<never> => {
        throw new Error('Workspace search must not request embeddings');
      };
      const semantic = vi
        .spyOn(backendQuery, 'semanticSearch')
        .mockImplementation(unexpectedEmbedding);
      const queryEmbedding = vi
        .spyOn(embedder, 'embedQuery')
        .mockImplementation(unexpectedEmbedding);
      const httpEmbedding = vi
        .spyOn(httpEmbeddings, 'httpEmbedQuery')
        .mockImplementation(unexpectedEmbedding);
      try {
        const response = await client.callTool({
          name: 'search',
          arguments: {
            action: 'semantic',
            repo: repoName,
            query: symbol,
            ...(policy ? { retrieval_policy: policy } : {}),
          },
        });
        expect(response.isError).not.toBe(true);
        const text = (response.content as Array<{ type: string; text?: string }>)
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n');
        const result = JSON.parse(text.split('\n\n---\n')[0]) as {
          definitions?: Array<{ name: string; filePath: string }>;
          warning?: string;
        };
        expect(result.definitions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: symbol, filePath: 'src/dirty.ts' }),
          ]),
        );
        expect(result.warning).toContain(vectorWarning);
        if (policy) expect(result.warning).toContain(policyWarning);
        else expect(result.warning).not.toContain(policyWarning);
        expect(semantic).not.toHaveBeenCalled();
        expect(queryEmbedding).not.toHaveBeenCalled();
        expect(httpEmbedding).not.toHaveBeenCalled();
      } finally {
        semantic.mockRestore();
        queryEmbedding.mockRestore();
        httpEmbedding.mockRestore();
      }
    }, 120_000);
  }
});
