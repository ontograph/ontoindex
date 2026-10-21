import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import * as analysis from '../../src/core/run-analyze.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { resetOverlaySnapshotCache } from '../../src/mcp/local/backend-overlay.js';
import { createMCPServer } from '../../src/mcp/server.js';

describe('explicit committed navigation over MCP', () => {
  let root: string;
  let backend: LocalBackend;
  let client: Client;
  let server: ReturnType<typeof createMCPServer>;
  let analysisSpy: ReturnType<typeof vi.spyOn>;
  const repoName = 'committed-navigation';
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-committed-sdk-'));
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    vi.stubEnv('ONTOINDEX_VECTOR_BACKEND', 'lbug');
    vi.stubEnv('ONTOINDEX_MCP_AUTO_ANALYZE', '0');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n');
    await fs.writeFile(
      path.join(repo, 'src/base.ts'),
      'export function baseline() { return "COMMITTED_MARKER"; }\nexport function caller() { return baseline(); }\n',
    );
    await fs.writeFile(path.join(repo, 'src/other.ts'), 'export const other = 1;\n');
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
        skipNativeClose: true,
        skipAgentsMd: true,
        noStats: true,
        registryName: repoName,
        embeddings: false,
      },
      { onProgress() {} },
    );
    analysisSpy = vi.spyOn(analysis, 'runFullAnalysis');
    await fs.writeFile(
      path.join(repo, 'src/base.ts'),
      'export function dirtyOnly() { return "DIRTY_MARKER"; }\n',
    );
    vi.stubEnv('ONTOINDEX_WORKSPACE_MAX_FILES', '1');
    resetOverlaySnapshotCache();
    backend = new LocalBackend();
    await backend.init();
    server = createMCPServer(backend);
    client = new Client({ name: repoName, version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    await client.connect(left);
  }, 240_000);
  afterAll(async () => {
    await client?.close();
    await server?.close();
    await backend?.disconnect();
    analysisSpy?.mockRestore();
    resetOverlaySnapshotCache();
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  const calls = [
    {
      name: 'gn_explore',
      arguments: { query: 'baseline', depth: 'shallow', includeSkeletons: false },
    },
    {
      name: 'inspect',
      arguments: {
        action: 'context',
        target: 'baseline',
        file_path: 'src/base.ts',
        include_content: true,
      },
    },
    {
      name: 'impact',
      arguments: { action: 'symbol', target: 'baseline', file_path: 'src/base.ts', maxDepth: 1 },
    },
    {
      name: 'search',
      arguments: { action: 'semantic', query: 'baseline', limit: 3, include_content: true },
    },
  ];
  const payloadOf = (result: { content?: unknown }) =>
    JSON.parse((result.content as Array<{ text: string }>)[0].text.split('\n\n---')[0]);

  it('reports committed freshness without promising workspace-graph readiness', async () => {
    const result = await client.callTool({
      name: 'gn_ensure_fresh',
      arguments: {
        repo: repoName,
        autoAnalyze: false,
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const payload = payloadOf(result);
    expect(payload.isStale).toBe(false);
    expect(payload.indexedCommit).toBe(payload.headCommit);
    expect(payload.runtimeHealth.dirtyCoverage.state).toBe('coverable');
    expect(payload.runtimeHealth.workspaceReadiness).toMatchObject({
      state: 'not-checked',
      preparationChecked: false,
    });
    expect(payload.actionsTaken).toEqual([]);
  });

  it.each(calls)(
    'serves indexed evidence for $name while default preparation refuses',
    async (call) => {
      const defaultResult = await client.callTool({
        ...call,
        arguments: { ...call.arguments, repo: repoName },
      });
      expect(defaultResult.isError).toBe(true);
      expect(payloadOf(defaultResult)).toMatchObject({
        error: 'workspace_preparation_failed: workspace_too_large',
        code: 'workspace_too_large',
        retryable: false,
        remediation: { read_mode: 'committed' },
        diagnostics: {
          observedIndexedFiles: 2,
          maxIndexedFiles: 1,
          requiredCapability: 'workspace-graph',
        },
      });
      expect(payloadOf(defaultResult).remediation.message).toContain('Uncommitted source changes');
      expect(payloadOf(defaultResult).remediation.message).toContain(
        'Do not automatically retry or reindex',
      );
      const result = await client.callTool({
        ...call,
        arguments: { ...call.arguments, repo: repoName, read_mode: 'committed' },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      const payload = JSON.parse(text.split('\n\n---')[0]);
      expect(payload.readContext).toMatchObject({ mode: 'committed', workingTreeIncluded: false });
      expect(payload.readContext.indexedCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(text).not.toContain('dirtyOnly');
      expect(text).not.toContain('DIRTY_MARKER');
      expect(text).toContain('baseline');
      if (call.name === 'inspect') expect(text).toContain('COMMITTED_MARKER');
      expect(analysisSpy).not.toHaveBeenCalled();
    },
  );

  it('executes a generated committed UID continuation', async () => {
    const result = await client.callTool({
      name: 'gn_explore',
      arguments: {
        repo: repoName,
        query: 'baseline',
        profile: 'task-pack',
        read_mode: 'committed',
        includeSkeletons: false,
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const example = payloadOf(result).taskPack.nextCalls[0] as string;
    expect(example).toMatch(/^inspect\(/);
    const args = Object.fromEntries(
      [...example.matchAll(/(action|repo|uid|read_mode): "([^"]*)"/g)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    expect(args.read_mode).toBe('committed');
    const next = await client.callTool({ name: 'inspect', arguments: args });
    expect(next.isError, JSON.stringify(next)).not.toBe(true);
    expect(payloadOf(next).readContext.workingTreeIncluded).toBe(false);
    expect(analysisSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, [], ['baseline']])(
    'distinguishes symbol expectations %j',
    async (expectedSymbols) => {
      const result = await client.callTool({
        name: 'gn_verify_diff',
        arguments: {
          repo: repoName,
          scope: 'all',
          changedFiles: ['src/base.ts'],
          expectedFiles: ['src/base.ts'],
          changedSymbols: ['baseline'],
          ...(expectedSymbols === undefined ? {} : { expectedSymbols }),
        },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const payload = payloadOf(result);
      expect(payload.status).toBe(expectedSymbols?.length === 0 ? 'FAIL' : 'PASS');
      expect(payload.unexpectedChangedFiles).toEqual([]);
      expect(payload.actual.changedSymbols).toEqual(['baseline']);
      expect(payload.unexpectedChangedSymbols).toEqual(
        expectedSymbols?.length === 0 ? ['baseline'] : [],
      );
      expect(payload.skipReasons).toEqual(
        expectedSymbols === undefined
          ? ['expectedSymbols not provided; symbol scope was not checked.']
          : [],
      );
      expect(payload.actual.executedTests).toEqual([]);
    },
  );

  it('rejects unsupported read modes and live enrichment', async () => {
    for (const args of [
      { read_mode: 'unknown' },
      { read_mode: 'committed', include_lsp_refs: true },
    ]) {
      const result = await client.callTool({
        name: 'search',
        arguments: {
          action: 'semantic',
          repo: repoName,
          query: 'baseline',
          ...args,
        },
      });
      expect(result.isError).toBe(true);
    }
  });

  it('isolates concurrent committed and workspace requests', async () => {
    const call = calls[1];
    const [committed, workspace] = await Promise.all([
      client.callTool({
        ...call,
        arguments: { ...call.arguments, repo: repoName, read_mode: 'committed' },
      }),
      client.callTool({ ...call, arguments: { ...call.arguments, repo: repoName } }),
    ]);
    expect(committed.isError, JSON.stringify(committed)).not.toBe(true);
    expect(workspace.isError).toBe(true);
    expect(JSON.stringify(workspace)).toContain('workspace_too_large');
  });

  it('excludes dirty parsing when automatic workspace is disabled', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
    try {
      const call = calls[2];
      const result = await client.callTool({
        ...call,
        arguments: { ...call.arguments, repo: repoName, read_mode: 'committed' },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(JSON.stringify(result)).toContain('baseline');
      expect(JSON.stringify(result)).not.toContain('dirtyOnly');
    } finally {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    }
  });
});
