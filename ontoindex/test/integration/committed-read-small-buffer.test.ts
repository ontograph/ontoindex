import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { createMCPServer } from '../../src/mcp/server.js';

describe('navigation with a small native read buffer', () => {
  const repoName = 'committed-small-buffer';
  // Buffers <=32 MiB cannot serve any query natively; 48 MiB still fails the unlabeled content query on HEAD 591823a.
  const bufferMiB = 48;
  const payloadBytes = 16 * 1024 * 1024;
  let root: string;
  let backend: LocalBackend;
  let client: Client;
  let server: ReturnType<typeof createMCPServer>;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-small-buffer-'));
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    vi.stubEnv('ONTOINDEX_VECTOR_BACKEND', 'lbug');
    vi.stubEnv('ONTOINDEX_MCP_AUTO_ANALYZE', '0');
    vi.stubEnv('ONTOINDEX_AUTO_REFRESH', '0');
    vi.stubEnv('ONTOINDEX_SCAN_MAX_FILE_KB', '0');
    // Analyze at the default buffer; the small buffer applies to a fresh reader.
    vi.stubEnv('ONTOINDEX_LBUG_BUFFER_MB', '0');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n.claude/\n');
    await fs.writeFile(
      path.join(repo, 'src/ranks.ts'),
      'export function fuseRanks(left: number, right: number) { return left + right; }\n',
    );
    await fs.writeFile(
      path.join(repo, 'src/caller.ts'),
      "import { fuseRanks } from './ranks';\nexport function rankCaller() { return fuseRanks(1, 2); }\n",
    );
    // File.content is stored in full. Plain text avoids allocating parse workers.
    for (let i = 0; i < 4; i++) {
      await fs.writeFile(path.join(repo, `payload-${i}.txt`), 'payload '.repeat(payloadBytes / 8));
    }
    expect(4 * payloadBytes).toBeGreaterThan(bufferMiB * 1024 * 1024);
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
    git('commit', '-qm', 'small buffer fixture');
    await runFullAnalysis(
      repo,
      { skipAgentsMd: true, noStats: true, registryName: repoName, embeddings: false },
      { onProgress() {} },
    );
    expect(git('status', '--porcelain').toString()).toBe('');
    vi.stubEnv('ONTOINDEX_LBUG_BUFFER_MB', String(bufferMiB));
    backend = new LocalBackend();
    await backend.init();
    server = createMCPServer(backend);
    client = new Client({ name: repoName, version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    await client.connect(left);
  }, 120_000);

  afterAll(async () => {
    try {
      await client?.close();
      await server?.close();
      await backend?.disconnect();
    } finally {
      vi.unstubAllEnvs();
      if (root) await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: { repo: repoName, ...args } });
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    const blocks = result.content as Array<{ text: string }>;
    return JSON.parse(blocks[0].text.split('\n\n---')[0]);
  }

  it('inspect context finds the symbol and its caller', async () => {
    const result = await call('inspect', {
      action: 'context',
      target: 'fuseRanks',
      include_content: true,
      read_mode: 'committed',
    });
    expect(result.status).toBe('found');
    expect(result.symbol.name).toBe('fuseRanks');
    expect(result.contextCompleteness.missingReasons).not.toContain('method-metadata-query-failed');
    expect(result.symbol.content).toContain('return left + right');
    expect(JSON.stringify(result.incoming)).toContain('rankCaller');
  });

  it('impact resolves the symbol and reports its upstream caller', async () => {
    const result = await call('impact', {
      action: 'symbol',
      target: 'fuseRanks',
      direction: 'upstream',
      read_mode: 'committed',
    });
    expect(result.risk).toBeDefined();
    expect(result.risk).not.toBe('UNKNOWN');
    expect(result.target.name).toBe('fuseRanks');
    expect(JSON.stringify(result.byDepth)).toContain('rankCaller');
  });

  it('safe_edit_check resolves the symbol instead of reporting it absent', async () => {
    const result = await call('audit', {
      action: 'safe_edit_check',
      symbol: 'fuseRanks',
      read_mode: 'committed',
    });
    expect(result.symbol.nodeId).toContain('fuseRanks');
    expect(result.symbol.filePath).toBe('src/ranks.ts');
    expect(JSON.stringify(result)).not.toContain('symbol not found in index');
  });

  it('semantic search returns symbol content without lookup warnings', async () => {
    const result = await call('search', {
      action: 'semantic',
      query: 'fuseRanks',
      include_content: true,
      read_mode: 'committed',
    });
    const symbols = [...(result.process_symbols ?? []), ...(result.definitions ?? [])];
    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'fuseRanks',
          content: expect.stringContaining('fuseRanks'),
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /content lookup failed|Content enrichment unavailable/i,
    );
  });

  it('repomap includes the focused symbol on the clean workspace', async () => {
    const result = await call('search', {
      action: 'repomap',
      focus: ['src/ranks.ts'],
      format: 'full',
      token_budget: 2000,
    });
    expect(JSON.stringify(result)).toContain('fuseRanks');
  });
});
