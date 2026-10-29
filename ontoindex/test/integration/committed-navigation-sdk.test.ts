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
  let committedSha: string;
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
    committedSha = git('rev-parse', 'HEAD').toString().trim();
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
    // Legacy gn_* listings are asserted below; core hides them by default.
    vi.stubEnv('ONTOINDEX_MCP_STARTUP_PROFILE', 'public-full');
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

  it.each(['gn_test_gap', 'audit'])(
    'initializes cold target reads through %s and preserves absolute-path identity',
    async (name) => {
      for (const target of [
        { symbol: 'baseline' },
        { filePath: 'src/base.ts' },
        { query: 'baseline' },
      ]) {
        const result = await client.callTool({
          name,
          arguments: {
            repo: path.join(root, 'repo'),
            ...(name === 'audit' ? { action: 'test_gap' } : {}),
            ...target,
          },
        });
        expect(result.isError).not.toBe(true);
        const payload = payloadOf(result);
        expect(payload.mode).toBe('target');
        if ('query' in target) {
          // This fixture deliberately has no embeddings; unavailable semantic evidence
          // must remain unknown rather than fabricate a matching symbol.
          expect(payload.resolvedSymbols).toEqual([]);
          expect(payload.targetedCoverage).toBe('unknown');
        } else {
          expect(payload.resolvedSymbols).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: 'baseline', filePath: 'src/base.ts' }),
            ]),
          );
        }
        expect(payload).not.toHaveProperty('readContext');
        expect(JSON.stringify(payload)).not.toContain('not initialized');
        expect(analysisSpy).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['gn_docs', 'docs'])(
    'reaches missing-sidecar readiness through %s above the workspace cap',
    async (name) => {
      const result = await client.callTool({
        name,
        arguments: { repo: repoName, action: 'readiness' },
      });
      expect(result.isError).not.toBe(true);
      const payload = payloadOf(result);
      expect(payload.report).toBe('docs-readiness');
      expect(JSON.stringify(payload)).toContain('sidecar is missing');
      expect(JSON.stringify(payload)).not.toContain('workspace_preparation_failed');
      expect(analysisSpy).not.toHaveBeenCalled();
    },
  );

  it('reports committed freshness and the workspace size limit without building', async () => {
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
      state: 'over-limit',
      preparationChecked: false,
      maxIndexedFiles: 1,
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
      expect(payload.readContext.indexedCommit).toBe(committedSha);
      expect(text).not.toContain('dirtyOnly');
      expect(text).not.toContain('DIRTY_MARKER');
      expect(text).toContain('baseline');
      if (call.name === 'inspect') {
        expect(payload).toMatchObject({
          status: 'found',
          symbol: {
            uid: expect.any(String),
            name: 'baseline',
            kind: 'Function',
            filePath: 'src/base.ts',
            startLine: 0,
            endLine: 0,
          },
          contextCompleteness: { sourceIncluded: true, truncated: false },
        });
        expect(payload.symbol.uid.length).toBeGreaterThan(0);
        expect(payload.symbol.content).toContain('COMMITTED_MARKER');
        expect(payload.symbol.content).not.toContain('DIRTY_MARKER');
        expect(payload.contextCompleteness.missingReasons).not.toContain('source-unavailable');
        expect(payload.incoming.calls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'caller', kind: 'Function', filePath: 'src/base.ts' }),
          ]),
        );
      }
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
    const payload = payloadOf(result);
    const example = payload.taskPack.nextCalls[0] as string;
    expect(example).toMatch(/^inspect\(/);
    const args = Object.fromEntries(
      [...example.matchAll(/(action|repo|uid|read_mode): "([^"]*)"/g)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    expect(args).toMatchObject({ action: 'context', repo: repoName, read_mode: 'committed' });
    expect(args.uid).toEqual(expect.any(String));
    expect(args.uid.length).toBeGreaterThan(0);
    const firstSymbol = payload.taskPack.topSymbols[0];
    expect(args.uid).toBe(firstSymbol.nodeId);
    const next = await client.callTool({ name: 'inspect', arguments: args });
    expect(next.isError, JSON.stringify(next)).not.toBe(true);
    const nextPayload = payloadOf(next);
    expect(nextPayload).toMatchObject({
      status: 'found',
      symbol: { uid: args.uid, name: firstSymbol.name, filePath: firstSymbol.filePath },
      readContext: {
        mode: 'committed',
        indexedCommit: committedSha,
        generation: payload.readContext.generation,
        workingTreeIncluded: false,
      },
      contextCompleteness: {
        sourceIncluded: false,
        truncated: false,
        missingReasons: ['source-not-requested'],
      },
    });
    expect(nextPayload.symbol).not.toHaveProperty('content');
    expect(analysisSpy).not.toHaveBeenCalled();
  });

  it('serves the same committed related symbol through the legacy and facade tools', async () => {
    const relatedArgs = {
      repo: repoName,
      symbol: 'baseline',
      read_mode: 'committed',
      includeCoChanged: false,
      includeCrossRepo: false,
      maxItemsPerCategory: 3,
    };
    const symbols = [];
    for (const call of [
      { name: 'gn_find_related', arguments: relatedArgs },
      { name: 'inspect', arguments: { action: 'related', ...relatedArgs } },
    ]) {
      const result = await client.callTool(call);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const payload = payloadOf(result);
      expect(payload.resolvedSymbol).toMatchObject({
        nodeId: expect.any(String),
        name: 'baseline',
        filePath: 'src/base.ts',
        kind: 'Function',
      });
      expect(payload.resolvedSymbol.nodeId.length).toBeGreaterThan(0);
      expect(payload.readContext).toMatchObject({
        mode: 'committed',
        indexedCommit: committedSha,
        workingTreeIncluded: false,
      });
      expect(JSON.stringify(payload)).not.toContain('dirtyOnly');
      symbols.push(payload.resolvedSymbol);
      expect(analysisSpy).not.toHaveBeenCalled();
    }
    expect(symbols[0]).toEqual(symbols[1]);
  });

  it('executes hidden legacy related calls with facade parity under the core profile', async () => {
    const originalProfile = process.env.ONTOINDEX_MCP_STARTUP_PROFILE;
    let coreServer: ReturnType<typeof createMCPServer> | undefined;
    let coreClient: Client | undefined;
    try {
      process.env.ONTOINDEX_MCP_STARTUP_PROFILE = 'core';
      coreServer = createMCPServer(backend);
      coreClient = new Client({ name: `${repoName}-core`, version: '1' });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await coreServer.connect(right);
      await coreClient.connect(left);

      const { tools } = await coreClient.listTools();
      expect(tools.map((tool) => tool.name)).not.toContain('gn_find_related');
      expect(tools.map((tool) => tool.name)).toContain('inspect');

      const relatedArgs = {
        repo: repoName,
        symbol: 'baseline',
        read_mode: 'committed',
        includeCoChanged: false,
        includeCrossRepo: false,
        maxItemsPerCategory: 3,
      };
      const symbols = [];
      for (const call of [
        { name: 'gn_find_related', arguments: relatedArgs },
        { name: 'inspect', arguments: { action: 'related', ...relatedArgs } },
      ]) {
        const result = await coreClient.callTool(call);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const payload = payloadOf(result);
        expect(payload.resolvedSymbol).toMatchObject({
          nodeId: expect.any(String),
          name: 'baseline',
          filePath: 'src/base.ts',
          kind: 'Function',
        });
        expect(payload.resolvedSymbol.nodeId.length).toBeGreaterThan(0);
        expect(payload.readContext).toMatchObject({
          mode: 'committed',
          indexedCommit: committedSha,
          workingTreeIncluded: false,
        });
        expect(JSON.stringify(payload)).not.toContain('dirtyOnly');
        symbols.push(payload.resolvedSymbol);
      }
      expect(symbols[0]).toEqual(symbols[1]);
      expect(analysisSpy).not.toHaveBeenCalled();
    } finally {
      try {
        const cleanup = await Promise.allSettled([coreClient?.close(), coreServer?.close()]);
        for (const result of cleanup) {
          if (result.status === 'rejected') throw result.reason;
        }
      } finally {
        if (originalProfile === undefined) delete process.env.ONTOINDEX_MCP_STARTUP_PROFILE;
        else process.env.ONTOINDEX_MCP_STARTUP_PROFILE = originalProfile;
      }
    }
  });

  it('serves committed explore through the inspect facade', async () => {
    const explore = {
      repo: repoName,
      query: 'baseline',
      depth: 'shallow',
      includeSkeletons: false,
      read_mode: 'committed',
    };
    const results = [];
    for (const call of [
      { name: 'gn_explore', arguments: explore },
      { name: 'inspect', arguments: { action: 'explore', ...explore } },
    ]) {
      const result = await client.callTool(call);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const payload = payloadOf(result);
      expect(payload.readContext).toMatchObject({
        mode: 'committed',
        indexedCommit: committedSha,
        workingTreeIncluded: false,
      });
      // Equal-score symbols may tie in either order; compare the selected set.
      results.push(payload.topSymbols.map((symbol: { nodeId: string }) => symbol.nodeId).sort());
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0].length).toBeGreaterThan(0);
    expect(analysisSpy).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'gn_safe_edit_check', action: 'safe_edit_check' },
    { name: 'gn_can_delete', action: 'can_delete' },
  ])(
    'serves the same committed $action verdict through legacy and audit tools',
    async ({ name, action }) => {
      const args = { repo: repoName, symbol: 'baseline', read_mode: 'committed' };
      const reports = [];
      for (const call of [
        { name, arguments: args },
        { name: 'audit', arguments: { action, ...args } },
      ]) {
        const result = await client.callTool(call);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const payload = payloadOf(result);
        expect(payload.symbol).toMatchObject({
          nodeId: expect.any(String),
          name: 'baseline',
          filePath: 'src/base.ts',
          kind: 'Function',
        });
        expect(payload.symbol.nodeId.length).toBeGreaterThan(0);
        expect(payload.verdict).toEqual(expect.any(String));
        expect(payload.readContext).toMatchObject({
          mode: 'committed',
          indexedCommit: committedSha,
          workingTreeIncluded: false,
        });
        if (action === 'safe_edit_check') {
          expect(payload.freshness.authoritative).toBe(false);
          expect(payload.freshness.dirtyFileCount).toBeGreaterThan(0);
          expect(payload.warnings).toEqual(
            expect.arrayContaining([expect.stringContaining('Graph is not authoritative')]),
          );
        }
        reports.push({ nodeId: payload.symbol.nodeId, verdict: payload.verdict });
        expect(analysisSpy).not.toHaveBeenCalled();
      }
      expect(reports[1]).toEqual(reports[0]);
    },
  );

  it('advertises committed read mode for legacy safety tools and audit', async () => {
    const { tools } = await client.listTools();
    for (const name of ['gn_safe_edit_check', 'gn_can_delete', 'audit']) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.inputSchema.properties).toHaveProperty('read_mode');
      expect(tool!.inputSchema.properties!.read_mode).toMatchObject({
        type: 'string',
        enum: expect.arrayContaining(['committed']),
        description: expect.stringContaining('inspect context|related|explore'),
      });
    }
  });

  it('advertises read-only annotations only for safe navigation tools', async () => {
    const { tools } = await client.listTools();
    const readOnlyTools = new Set([
      'search',
      'inspect',
      'impact',
      'gn_help',
      'gn_tool_contract',
      'gn_explore',
      'gn_find_related',
      'gn_explain_module',
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['inspect', 'search']));
    for (const tool of tools) {
      if (readOnlyTools.has(tool.name)) {
        expect(tool.annotations, tool.name).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        });
      } else {
        expect(tool, tool.name).not.toHaveProperty('annotations');
      }
    }
  });

  it('still rejects committed reads for unsupported inspect operations', async () => {
    const result = await client.callTool({
      name: 'inspect',
      arguments: { repo: repoName, action: 'shape', route: '/baseline', read_mode: 'committed' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      'read_mode=committed requires an explicit single repository and a supported navigation operation.',
    );
    expect(JSON.stringify(result)).toContain('search semantic');
    expect(JSON.stringify(result)).toContain('Received inspect/shape.');
    expect(analysisSpy).not.toHaveBeenCalled();
  });

  it('lists supported operations when committed cypher reads are rejected', async () => {
    const result = await client.callTool({
      name: 'search',
      arguments: { repo: repoName, action: 'cypher', query: 'RETURN 1', read_mode: 'committed' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Received search/cypher.');
    expect(JSON.stringify(result)).toContain('search semantic');
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
