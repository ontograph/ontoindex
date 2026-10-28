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

describe('committed graph discovery over the real MCP SDK', () => {
  let root: string;
  let repo: string;
  let backend: LocalBackend;
  let client: Client;
  let server: ReturnType<typeof createMCPServer>;
  const repoName = 'committed-discovery-sdk';
  const notice =
    'This tool reads the committed index and does not include 1 uncommitted file change(s); use context, impact or query for the working tree.';
  const resourcePaths = ['context', 'clusters', 'processes'];

  async function read(resourcePath: string) {
    const response = await client.readResource({
      uri: `ontoindex://repo/${repoName}/${resourcePath}`,
    });
    const text = response.contents.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).not.toMatch(/^error:/m);
    return text;
  }

  async function related(symbol = 'baseline') {
    const response = await client.callTool({
      name: 'gn_find_related',
      arguments: { repo: repoName, symbol, includeCrossRepo: true, includeCoChanged: false },
    });
    expect(response.isError).not.toBe(true);
    const text = (response.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    return JSON.parse(text.split('\n\n---\n')[0]) as {
      resolvedSymbol: { name: string };
      warnings: string[];
    };
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-committed-discovery-sdk-'));
    const home = path.join(root, 'home');
    repo = path.join(root, repoName);
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    // Legacy gn_* listings are asserted below; core hides them by default.
    vi.stubEnv('ONTOINDEX_MCP_STARTUP_PROFILE', 'public-full');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n');
    await fs.writeFile(
      path.join(repo, 'src/base.ts'),
      [
        'export function baseline() { return second() + third() + fourth() + fifth() + sixth() + seventh() + eighth(); }',
        'export function second() { return third() + fourth() + fifth() + sixth() + seventh() + eighth(); }',
        'export function third() { return fourth() + fifth() + sixth() + seventh() + eighth(); }',
        'export function fourth() { return fifth() + sixth() + seventh() + eighth(); }',
        'export function fifth() { return sixth() + seventh() + eighth(); }',
        'export function sixth() { return seventh() + eighth(); }',
        'export function seventh() { return eighth(); }',
        'export function eighth() { return 1; }',
        '',
      ].join('\n'),
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
    git('commit', '-qm', 'committed discovery baseline');
    await runFullAnalysis(
      repo,
      {
        skipAgentsMd: true,
        noStats: true,
        registryName: repoName,
      },
      { onProgress() {} },
    );
    backend = new LocalBackend();
    await backend.init();
    const clusters = await backend.queryClusters(repoName);
    const processes = await backend.queryProcesses(repoName);
    // Some native clustering versions omit tiny communities; never invent an entity name.
    const cluster = clusters.clusters[0];
    if (cluster)
      resourcePaths.push(`cluster/${encodeURIComponent(cluster.heuristicLabel || cluster.label)}`);
    const process = processes.processes[0];
    const processName = process?.heuristicLabel || process?.label;
    if (typeof processName === 'string')
      resourcePaths.push(`process/${encodeURIComponent(processName)}`);
    expect(resourcePaths.some((resourcePath) => resourcePath.startsWith('cluster/'))).toBe(true);
    expect(resourcePaths.some((resourcePath) => resourcePath.startsWith('process/'))).toBe(true);
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
          resetOverlaySnapshotCache();
          vi.unstubAllEnvs();
          if (root) await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  });

  it('advertises committed graph boundaries in templates and discovery tools', async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const graphTemplates = resourceTemplates.filter((template) =>
      ['context', 'clusters', 'processes', 'cluster/{clusterName}', 'process/{processName}'].some(
        (tail) => template.uriTemplate === `ontoindex://repo/{name}/${tail}`,
      ),
    );
    expect(graphTemplates).toHaveLength(5);
    for (const template of graphTemplates) {
      expect(template.description).toContain('committed graph snapshot');
      expect(template.description).toContain('excludes uncommitted changes');
    }
    const { tools } = await client.listTools();
    for (const name of ['gn_explore', 'gn_explain_module', 'gn_find_related']) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool?.description).toContain('committed index');
      expect(tool?.description).toContain('exclude uncommitted changes');
    }
  });

  it('prepares dirty graph reads while preserving diagnostic health and unrelated tool warnings', async () => {
    resetOverlaySnapshotCache();
    for (const resourcePath of resourcePaths)
      expect(await read(resourcePath)).not.toContain(notice);
    await fs.appendFile(
      path.join(repo, 'src/base.ts'),
      '\nexport function dirtyOnly() { return 2; }\n',
    );
    resetOverlaySnapshotCache();
    const prepared = vi.spyOn(backend, 'withPreparedRepoRead');
    for (const resourcePath of resourcePaths) {
      prepared.mockClear();
      const text = await read(resourcePath);
      expect(prepared).toHaveBeenCalled();
      expect(text).not.toContain(notice);
      if (resourcePath === 'context') expect(text).toContain('freshness_state: "dirty"');
    }
    const dirty = await related('dirtyOnly');
    expect(dirty.resolvedSymbol.name).toBe('dirtyOnly');
    expect(dirty.warnings).toContain('cross-repo not yet wired');
    expect(dirty.warnings).not.toContain(notice);
    prepared.mockRestore();

    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
    resetOverlaySnapshotCache();
    for (const resourcePath of resourcePaths)
      expect(await read(resourcePath)).not.toContain(notice);
    const disabled = await related();
    expect(disabled.resolvedSymbol.name).toBe('baseline');
    expect(disabled.warnings).toContain('cross-repo not yet wired');
    expect(disabled.warnings).not.toContain(notice);
  });
});
