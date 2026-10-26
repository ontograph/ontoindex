import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { resetOverlaySnapshotCache } from '../../src/mcp/local/backend-overlay.js';
import { createMCPServer } from '../../src/mcp/server.js';

const metadataKeys = [
  'targetContext',
  'freshness',
  'repoLabel',
  'repoPath',
  'capabilitiesUsed',
  'capabilitiesMissing',
] as const;
const metadata = (payload: Record<string, unknown>, context = false) =>
  Object.fromEntries(
    [...metadataKeys, ...(context ? ['source', 'graphImpactAvailable'] : [])]
      .filter((key) => payload[key] !== undefined)
      .map((key) => [key, payload[key]]),
  );

describe('group workspace provenance over the real MCP SDK', () => {
  let root: string;
  let backend: LocalBackend;
  let client: Client;
  let server: ReturnType<typeof createMCPServer>;
  const members = [
    { member: 'app/alpha', registry: 'workspace-alpha', symbol: 'workspaceAlphaDirty' },
    { member: 'app/beta', registry: 'workspace-beta', symbol: 'workspaceBetaDirty' },
  ];

  async function call(name: string, args: Record<string, unknown>) {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError).not.toBe(true);
    const text = (response.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    return JSON.parse(text.split('\n\n---\n')[0]) as Record<string, any>;
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-group-workspace-sdk-'));
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    for (const member of members) {
      const repo = path.join(root, member.registry);
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
      git('commit', '-qm', 'baseline');
      await runFullAnalysis(
        repo,
        {
          skipAgentsMd: true,
          noStats: true,
          registryName: member.registry,
        },
        { onProgress() {} },
      );
      await fs.writeFile(
        path.join(repo, 'src/dirty.ts'),
        `export function ${member.symbol}() { return 2; }\n`,
      );
    }
    const groupDir = path.join(home, 'groups', 'workspace-sdk');
    await fs.mkdir(groupDir, { recursive: true });
    await fs.writeFile(
      path.join(groupDir, 'group.yaml'),
      [
        'version: 1',
        'name: workspace-sdk',
        'repos:',
        ...members.map((member) => `  ${member.member}: ${member.registry}`),
        '  app/missing: nonexistent-workspace-sdk-registry',
        'links: []',
        '',
      ].join('\n'),
    );
    backend = new LocalBackend();
    await backend.init();
    server = createMCPServer(backend);
    client = new Client({ name: 'group-workspace-provenance', version: '1' });
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
          resetOverlaySnapshotCache();
          vi.unstubAllEnvs();
          if (root) await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  });

  it('finds dirty-only symbols and preserves available context provenance through filtering', async () => {
    for (const member of members) {
      const direct = await call('inspect', {
        action: 'context',
        repo: member.registry,
        name: member.symbol,
      });
      expect(direct.status).toBe('found');
      expect(direct.symbol.name).toBe(member.symbol);
      expect(direct.source).toBe('workspace-graph');
      // Real context producers currently expose source, not freshness/targetContext.
      expect(direct).not.toHaveProperty('freshness');
      expect(direct).not.toHaveProperty('targetContext');
      const grouped = await call('inspect', {
        action: 'context',
        repo: '@workspace-sdk',
        name: member.symbol,
      });
      const entry = grouped.results.find((entry: any) => entry.repoPath === member.member);
      expect(entry.payload.status).toBe('found');
      expect(entry.payload.symbol.name).toBe(member.symbol);
      expect(metadata(entry.payload, true)).toEqual(metadata(direct, true));
      expect(
        grouped.results.find((entry: any) => entry.repoPath === 'app/missing').payload.error,
      ).toBeTruthy();
      const filtered = await call('inspect', {
        action: 'context',
        repo: `@workspace-sdk/${member.member}`,
        name: member.symbol,
        service: 'unrelated',
      });
      expect(filtered.results).toHaveLength(1);
      expect(filtered.results[0].payload).toEqual(metadata(direct, true));
    }
  });

  it('keeps a missing symbol empty and preserves available query metadata', async () => {
    const missing = await call('inspect', {
      action: 'context',
      repo: '@workspace-sdk/app/alpha',
      name: 'noSuchWorkspaceSdkSymbol',
    });
    expect(missing.results).toHaveLength(1);
    expect(missing.results[0].payload.status).not.toBe('found');
    for (const member of members) {
      const direct = await call('search', {
        action: 'semantic',
        repo: member.registry,
        query: member.symbol,
      });
      expect(JSON.stringify(direct)).toContain(member.symbol);
      const grouped = await call('search', {
        action: 'semantic',
        repo: '@workspace-sdk',
        query: member.symbol,
      });
      const entry = grouped.per_repo.find((entry: any) => entry.repo === member.member);
      expect(metadata(entry)).toEqual(metadata(direct));
      expect(grouped.per_repo.find((entry: any) => entry.repo === 'app/missing').status).toBe(
        'unavailable',
      );
      // Group search returns process candidates; isolated functions may only be definitions.
      expect(Array.isArray(grouped.results)).toBe(true);
    }
  });
});
