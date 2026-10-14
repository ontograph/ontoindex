/**
 * Unit Tests: MCP Resources
 *
 * Tests: getResourceDefinitions, getResourceTemplates, readResource
 * - Static resource definitions
 * - Dynamic resource templates
 * - URI parsing and dispatch
 * - Error handling for invalid URIs
 * - Resource handlers with mocked backend
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
const { readRuntimeHealthMock } = vi.hoisted(() => ({ readRuntimeHealthMock: vi.fn() }));
vi.mock('../../src/core/runtime/runtime-health.js', () => ({
  readRuntimeHealth: readRuntimeHealthMock,
}));
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'node:module';
import {
  getResourceDefinitions,
  getResourceTemplates,
  parseResourceUri,
  readResource,
} from '../../src/mcp/resources.js';
import {
  CANONICAL_MEMORY_FRESHNESS,
  loadMemory,
  loadMemories,
  MAX_MEMORY_FILE_SIZE_BYTES,
  normalizeMemoryName,
  parseMemoryFrontMatter,
  parseMemoryFile,
  REQUIRED_MEMORY_FIELDS,
} from '../../src/mcp/memory-parser.js';

// ─── Minimal mock backend ──────────────────────────────────────────

const yaml = createRequire(import.meta.url)('js-yaml') as typeof import('js-yaml');

function createMockBackend(overrides: Partial<Record<string, any>> = {}): any {
  return {
    listRepos: vi.fn().mockResolvedValue(overrides.repos ?? []),
    resolveRepo: vi.fn().mockResolvedValue(
      overrides.resolvedRepo ?? {
        id: 'test-repo',
        name: 'test-repo',
        repoPath: '/tmp/test-repo',
        lastCommit: 'abc1234',
      },
    ),
    getContext: vi.fn().mockReturnValue(overrides.context ?? null),
    queryClusters: vi.fn().mockResolvedValue(overrides.clusters ?? { clusters: [] }),
    queryProcesses: vi.fn().mockResolvedValue(overrides.processes ?? { processes: [] }),
    queryClusterDetail: vi
      .fn()
      .mockResolvedValue(overrides.clusterDetail ?? { error: 'Not found' }),
    queryProcessDetail: vi
      .fn()
      .mockResolvedValue(overrides.processDetail ?? { error: 'Not found' }),
    readGroupContractsResource: vi
      .fn()
      .mockResolvedValue(overrides.groupContractsBody ?? 'contracts: []\n'),
    readGroupStatusResource: vi
      .fn()
      .mockResolvedValue(overrides.groupStatusBody ?? 'group: mock\n'),
    ...overrides,
  };
}

async function createMemoryRepo(prefix: string): Promise<string> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(repoDir, '.ontoindex/memories'), { recursive: true });
  return repoDir;
}

function makeMemoryContent(overrides: string[] = [], bodyLines: string[] = ['# Memory']): string {
  return [
    '---',
    'version: 1',
    'repo: TestRepo',
    'created_at: 2026-01-01',
    'source_commit: abc1234',
    'indexed_commit: def5678',
    'freshness: current',
    'kind: advisory',
    'not_audit_evidence: true',
    'sources:',
    '  - docs/some-doc.md',
    ...overrides,
    '---',
    ...bodyLines,
  ].join('\n');
}

// ─── Static definitions ─────────────────────────────────────────────

describe('getResourceDefinitions', () => {
  it('returns 2 static resources', () => {
    const defs = getResourceDefinitions();
    expect(defs).toHaveLength(2);
  });

  it('includes repos resource', () => {
    const defs = getResourceDefinitions();
    const repos = defs.find((d) => d.uri === 'ontoindex://repos');
    expect(repos).toBeDefined();
    expect(repos!.mimeType).toBe('text/yaml');
  });

  it('includes setup resource', () => {
    const defs = getResourceDefinitions();
    const setup = defs.find((d) => d.uri === 'ontoindex://setup');
    expect(setup).toBeDefined();
    expect(setup!.mimeType).toBe('text/markdown');
  });

  it('each definition has uri, name, description, mimeType', () => {
    for (const def of getResourceDefinitions()) {
      expect(def.uri).toBeTruthy();
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.mimeType).toBeTruthy();
    }
  });

  it('includes compact contract metadata in static resource descriptions', () => {
    for (const def of getResourceDefinitions()) {
      expect(def.description).toContain('Contract:');
      expect(def.description).toContain('purpose=');
      expect(def.description).toContain('freshness=');
      expect(def.description).toContain('evidence=');
      expect(def.description).toContain('response=');
      expect(def.description).toContain('suitability=');
    }
  });
});

describe('context resource runtime health', () => {
  beforeEach(() => {
    readRuntimeHealthMock.mockReset();
  });
  const context = {
    projectName: 'test-project',
    stats: { fileCount: 10, functionCount: 50, communityCount: 3, processCount: 5 },
  };

  function health(overrides: Record<string, unknown> = {}) {
    return {
      indexedCommit: 'abc1234',
      currentCommit: 'abc1234',
      dirtyWorktree: false,
      freshnessState: 'clean',
      degradedReason: null,
      ...overrides,
    };
  }

  it('reports clean runtime health and preserves context stats', async () => {
    readRuntimeHealthMock.mockResolvedValue(health());
    const backend = createMockBackend({ context });

    const result = await readResource('ontoindex://repo/test-project/context', backend);

    expect(readRuntimeHealthMock).toHaveBeenCalledWith('/tmp/test-repo', {
      repoLabel: 'test-repo',
      storagePath: undefined,
    });
    expect(result).toContain('runtime_health:');
    expect(result).toContain('freshness_state: "clean"');
    expect(result).toContain('indexed_commit: "abc1234"');
    expect(result).toContain('current_commit: "abc1234"');
    expect(result).toContain('dirty_worktree: false');
    expect(result).toContain('files: 10');
    expect(result).toContain('symbols: 50');
  });

  it('reports dirty worktrees and commit mismatch from runtime health', async () => {
    readRuntimeHealthMock.mockResolvedValue(
      health({
        indexedCommit: 'abc1234',
        currentCommit: 'def5678',
        dirtyWorktree: true,
        freshnessState: 'dirty',
        degradedReason: 'dirty worktree contains uncommitted changes',
      }),
    );
    const backend = createMockBackend({ context });

    const result = await readResource('ontoindex://repo/test-project/context', backend);

    expect(result).toContain('freshness_state: "dirty"');
    expect(result).toContain('indexed_commit: "abc1234"');
    expect(result).toContain('current_commit: "def5678"');
    expect(result).toContain('dirty_worktree: true');
    expect(result).toContain('degraded_reason: "dirty worktree contains uncommitted changes"');
  });

  it('does not report clean when the dirty-worktree probe is unknown', async () => {
    readRuntimeHealthMock.mockResolvedValue(health({ dirtyWorktree: null }));
    const backend = createMockBackend({ context });

    const result = await readResource('ontoindex://repo/test-project/context', backend);

    expect(result).toContain('freshness_state: "unknown"');
    expect(result).toContain('dirty_worktree: unknown');
  });

  it('reports a clean worktree whose indexed commit differs as stale', async () => {
    readRuntimeHealthMock.mockResolvedValue(
      health({
        currentCommit: 'def5678',
        freshnessState: 'stale',
        degradedReason: 'indexed commit differs from current HEAD',
      }),
    );
    const result = await readResource(
      'ontoindex://repo/test-project/context',
      createMockBackend({ context }),
    );
    expect(result).toContain('freshness_state: "stale"');
    expect(result).toContain('dirty_worktree: false');
    expect(result).toContain('current_commit: "def5678"');
  });

  it('reports unknown health when the repository path is unavailable', async () => {
    const backend = createMockBackend({ resolvedRepo: { id: 'r', name: 'test-project' }, context });

    const result = await readResource('ontoindex://repo/test-project/context', backend);

    expect(readRuntimeHealthMock).not.toHaveBeenCalled();
    expect(result).toContain('freshness_state: "unknown"');
    expect(result).toContain('degraded_reason: "repository path unavailable"');
  });

  it('reports bounded unknown health when the runtime probe fails', async () => {
    readRuntimeHealthMock.mockRejectedValue(new Error('sensitive probe details'));
    const backend = createMockBackend({ context });

    const result = await readResource('ontoindex://repo/test-project/context', backend);

    expect(result).toContain('freshness_state: "unknown"');
    expect(result).toContain('degraded_reason: "runtime health unavailable"');
    expect(result).not.toContain('sensitive probe details');
  });
});

describe('getResourceTemplates', () => {
  it('returns 14 dynamic templates', () => {
    const templates = getResourceTemplates();
    expect(templates).toHaveLength(14);
  });

  it('includes context, clusters, processes, schema, analysis packs/suites/plan, cluster detail, process detail, group contracts/status, memories, memory, onboarding', () => {
    const templates = getResourceTemplates();
    const uris = templates.map((t) => t.uriTemplate);
    expect(uris).toContain('ontoindex://repo/{name}/context');
    expect(uris).toContain('ontoindex://repo/{name}/clusters');
    expect(uris).toContain('ontoindex://repo/{name}/processes');
    expect(uris).toContain('ontoindex://repo/{name}/schema');
    expect(uris).toContain('ontoindex://repo/{name}/analysis-packs');
    expect(uris).toContain('ontoindex://repo/{name}/analysis-suites');
    expect(uris).toContain('ontoindex://repo/{name}/analysis-plan/{targetId}');
    expect(uris).toContain('ontoindex://repo/{name}/cluster/{clusterName}');
    expect(uris).toContain('ontoindex://repo/{name}/process/{processName}');
    expect(uris).toContain('ontoindex://group/{name}/contracts');
    expect(uris).toContain('ontoindex://group/{name}/status');
    expect(uris).toContain('ontoindex://repo/{name}/memories');
    expect(uris).toContain('ontoindex://repo/{name}/memory/{memoryName}');
    expect(uris).toContain('ontoindex://repo/{name}/onboarding');
  });

  it('each template has uriTemplate, name, description, mimeType', () => {
    for (const tmpl of getResourceTemplates()) {
      expect(tmpl.uriTemplate).toBeTruthy();
      expect(tmpl.name).toBeTruthy();
      expect(tmpl.description).toBeTruthy();
      expect(tmpl.mimeType).toBeTruthy();
    }
  });

  it('includes compact contract metadata in template descriptions', () => {
    for (const tmpl of getResourceTemplates()) {
      expect(tmpl.description).toContain('Contract:');
      expect(tmpl.description).toContain('purpose=');
      expect(tmpl.description).toContain('freshness=');
      expect(tmpl.description).toContain('evidence=');
      expect(tmpl.description).toContain('response=');
      expect(tmpl.description).toContain('suitability=');
    }
  });
});

describe('parseResourceUri', () => {
  it('parses group contracts without query', () => {
    const p = parseResourceUri('ontoindex://group/acme/contracts');
    expect(p).toEqual({
      kind: 'group',
      groupName: 'acme',
      resourceType: 'contracts',
      contractsFilter: {},
    });
  });

  it('parses nested group name and contracts query params', () => {
    const p = parseResourceUri(
      'ontoindex://group/acme/billing/contracts?type=http&repo=app%2Fapi&unmatchedOnly=true',
    );
    expect(p.kind).toBe('group');
    if (p.kind !== 'group' || p.resourceType !== 'contracts') throw new Error('unexpected');
    expect(p.groupName).toBe('acme/billing');
    expect(p.contractsFilter).toEqual({
      type: 'http',
      repo: 'app/api',
      unmatchedOnly: true,
    });
  });

  it('coerces unmatchedOnly false from string', () => {
    const p = parseResourceUri('ontoindex://group/g1/contracts?unmatchedOnly=false');
    expect(p.kind).toBe('group');
    if (p.kind !== 'group' || p.resourceType !== 'contracts') throw new Error('unexpected');
    expect(p.contractsFilter.unmatchedOnly).toBe(false);
  });

  it('parses group status', () => {
    const p = parseResourceUri('ontoindex://group/my/product/status');
    expect(p).toEqual({
      kind: 'group',
      groupName: 'my/product',
      resourceType: 'status',
    });
  });

  it('round-trips repo URI like legacy regex', () => {
    const p = parseResourceUri('ontoindex://repo/my%20project/schema');
    expect(p).toEqual({
      kind: 'repo',
      repoName: 'my project',
      resourceType: 'schema',
    });
  });

  it('parses analysis pack and suite resources', () => {
    expect(parseResourceUri('ontoindex://repo/my-project/analysis-packs')).toEqual({
      kind: 'repo',
      repoName: 'my-project',
      resourceType: 'analysis-packs',
    });
    expect(parseResourceUri('ontoindex://repo/my-project/analysis-suites')).toEqual({
      kind: 'repo',
      repoName: 'my-project',
      resourceType: 'analysis-suites',
    });
    expect(parseResourceUri('ontoindex://repo/my-project/analysis-plan/suite.demo')).toEqual({
      kind: 'repo',
      repoName: 'my-project',
      resourceType: 'analysis-plan',
      param: 'suite.demo',
    });
  });

  it('rejects unknown group resource tail', () => {
    expect(() => parseResourceUri('ontoindex://group/foo/bar')).toThrow(
      expect.objectContaining({ code: -32002 }),
    );
  });

  it('classifies malformed URIs and percent encoding as invalid params', () => {
    for (const uri of ['not a URI', 'https://repo/name/context', 'ontoindex://repo/%ZZ/context']) {
      try {
        parseResourceUri(uri);
        throw new Error(`expected ${uri} to fail`);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
      }
    }
  });

  it('classifies unknown URI shapes as invalid params and unsupported types separately', () => {
    for (const uri of ['ontoindex://unknown', 'ontoindex://repo/name']) {
      try {
        parseResourceUri(uri);
        throw new Error(`expected ${uri} to fail`);
      } catch (error) {
        expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
      }
    }
    for (const uri of ['ontoindex://repo/name/cluster', 'ontoindex://repo/name/memory']) {
      try {
        parseResourceUri(uri);
        throw new Error(`expected ${uri} to fail`);
      } catch (error) {
        expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
      }
    }
    expect(parseResourceUri('ontoindex://repo/name/not-a-resource')).toEqual({
      kind: 'repo',
      repoName: 'name',
      resourceType: 'not-a-resource',
    });
  });

  it('parses memory list resource', () => {
    expect(parseResourceUri('ontoindex://repo/my-repo/memories')).toEqual({
      kind: 'repo',
      repoName: 'my-repo',
      resourceType: 'memories',
    });
  });

  it('parses single memory resource', () => {
    expect(parseResourceUri('ontoindex://repo/my-repo/memory/onboarding')).toEqual({
      kind: 'repo',
      repoName: 'my-repo',
      resourceType: 'memory',
      param: 'onboarding',
    });
  });

  it('parses onboarding resource', () => {
    expect(parseResourceUri('ontoindex://repo/my-repo/onboarding')).toEqual({
      kind: 'repo',
      repoName: 'my-repo',
      resourceType: 'onboarding',
    });
  });
});

// ─── readResource URI parsing ────────────────────────────────────────

describe('readResource', () => {
  it('routes ontoindex://repos to listRepos', async () => {
    const backend = createMockBackend({
      repos: [
        {
          name: 'my-project',
          path: '/home/me/my-project',
          indexedAt: '2024-01-01',
          lastCommit: 'abc1234',
          stats: { files: 10, nodes: 50, processes: 5 },
        },
      ],
    });

    const result = await readResource('ontoindex://repos', backend);
    expect(backend.listRepos).toHaveBeenCalled();
    expect(result).toContain('my-project');
  });

  it('returns empty message when no repos', async () => {
    const backend = createMockBackend({ repos: [] });
    const result = await readResource('ontoindex://repos', backend);
    expect(result).toContain('No repositories indexed');
  });

  it('routes ontoindex://setup to setup resource', async () => {
    const backend = createMockBackend({
      repos: [
        {
          name: 'proj',
          path: '/tmp/proj',
          indexedAt: '2024-01-01',
          lastCommit: 'abc',
          stats: { nodes: 10, edges: 20, processes: 3 },
        },
      ],
    });
    const result = await readResource('ontoindex://setup', backend);
    expect(result).toContain('OntoIndex MCP');
    expect(result).toContain('proj');
    expect(result).toContain('CLI equivalent: `ontoindex list`');
    expect(result).toContain('| `gn_ensure_fresh` |');
    expect(result).toContain('| `search` |');
    expect(result).toContain('| `inspect` |');
    expect(result).not.toContain('| `query` |');
    expect(result).not.toContain('| `detect_changes` |');
  });

  it('returns fallback when setup has no repos', async () => {
    const backend = createMockBackend({ repos: [] });
    const result = await readResource('ontoindex://setup', backend);
    expect(result).toContain('No repositories indexed');
  });

  it('routes group contracts resource through backend', async () => {
    const backend = createMockBackend();
    const uri = 'ontoindex://group/g1/contracts?type=http&unmatchedOnly=true';
    await readResource(uri, backend);
    expect(backend.readGroupContractsResource).toHaveBeenCalledWith('g1', {
      type: 'http',
      unmatchedOnly: true,
    });
  });

  it('routes group status resource through backend', async () => {
    const backend = createMockBackend();
    await readResource('ontoindex://group/acme/status', backend);
    expect(backend.readGroupStatusResource).toHaveBeenCalledWith('acme');
  });

  it('routes ontoindex://repo/{name}/context correctly', async () => {
    const backend = createMockBackend({
      context: {
        projectName: 'test-project',
        stats: { fileCount: 10, functionCount: 50, communityCount: 3, processCount: 5 },
      },
    });

    const result = await readResource('ontoindex://repo/test-project/context', backend);
    expect(backend.listRepos).toHaveBeenCalled();
    expect(backend.resolveRepo).toHaveBeenCalledWith('test-project');
    expect(result).toContain('test-project');
    expect(result).toContain('files: 10');
    expect(result).toContain('search: Search semantically');
    expect(result).not.toContain('ontoindex_query');
  });

  it('includes analysis catalog summary in context when manifests exist', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-resource-catalog-'));
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/demo-pack'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/demo-pack/pack.yml'),
      [
        'schema: 1',
        'id: demo.pack',
        'name: Demo Pack',
        'version: 0.1.0',
        'kind: query',
        'tier: stable',
        'summary: Demo pack.',
      ].join('\n'),
      'utf8',
    );

    const backend = createMockBackend({
      resolvedRepo: {
        id: 'test-repo',
        name: 'test-project',
        repoPath: repoDir,
        lastCommit: 'abc1234',
      },
      context: {
        projectName: 'test-project',
        stats: { fileCount: 10, functionCount: 50, communityCount: 3, processCount: 5 },
      },
    });

    const result = await readResource('ontoindex://repo/test-project/context', backend);
    expect(result).toContain('analysis_catalog:');
    expect(result).toContain('packs: 1');

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('returns error when context has no codebase loaded', async () => {
    const backend = createMockBackend({ context: null });
    const result = await readResource('ontoindex://repo/test-project/context', backend);
    expect(result).toContain('error');
  });

  it('routes ontoindex://repo/{name}/schema to static schema', async () => {
    const backend = createMockBackend();
    const result = await readResource('ontoindex://repo/any/schema', backend);
    expect(result).toContain('OntoIndex Graph Schema');
    expect(result).toContain('CALLS');
    expect(result).toContain('IMPORTS');
  });

  it('reads analysis pack and suite resources from local manifests', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-resource-packs-'));
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/api-pack'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/suites/api-suite'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/api-pack/pack.yml'),
      [
        'schema: 1',
        'id: core.api-pack',
        'name: API Pack',
        'version: 0.1.0',
        'kind: query',
        'tier: stable',
        'summary: API checks.',
        'provides:',
        '  - shape_check',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/suites/api-suite/suite.yml'),
      [
        'schema: 1',
        'id: suite.api',
        'name: API Suite',
        'tier: stable',
        'summary: API suite.',
        'packs:',
        '  - core.api-pack',
      ].join('\n'),
      'utf8',
    );

    const backend = createMockBackend({
      resolvedRepo: {
        id: 'test-repo',
        name: 'test-project',
        repoPath: repoDir,
        lastCommit: 'abc1234',
      },
    });

    const packs = await readResource('ontoindex://repo/test-project/analysis-packs', backend);
    const suites = await readResource('ontoindex://repo/test-project/analysis-suites', backend);

    expect(packs).toContain('core.api-pack');
    expect(packs).toContain('shape_check');
    expect(suites).toContain('suite.api');
    expect(suites).toContain('core.api-pack');

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('reads analysis execution plan resources', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-resource-plan-'));
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/api-pack'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/suites/api-suite'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/api-pack/pack.yml'),
      [
        'schema: 1',
        'id: core.api-pack',
        'name: API Pack',
        'version: 0.1.0',
        'kind: query',
        'tier: stable',
        'summary: API checks.',
        'runs:',
        '  - tool: shape_check',
        '    params: {}',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/suites/api-suite/suite.yml'),
      [
        'schema: 1',
        'id: suite.api',
        'name: API Suite',
        'tier: stable',
        'summary: API suite.',
        'packs:',
        '  - core.api-pack',
      ].join('\n'),
      'utf8',
    );

    const backend = createMockBackend({
      resolvedRepo: {
        id: 'test-repo',
        name: 'test-project',
        repoPath: repoDir,
        lastCommit: 'abc1234',
      },
    });

    const plan = await readResource(
      'ontoindex://repo/test-project/analysis-plan/suite.api',
      backend,
    );
    expect(plan).toContain('target_id: "suite.api"');
    expect(plan).toContain('tool: "shape_check"');

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('routes ontoindex://repo/{name}/clusters correctly', async () => {
    const backend = createMockBackend({
      clusters: {
        clusters: [{ heuristicLabel: 'Auth', symbolCount: 10, cohesion: 0.9 }],
      },
    });
    const result = await readResource('ontoindex://repo/test/clusters', backend);
    expect(backend.queryClusters).toHaveBeenCalledWith('test', 100);
    expect(result).toContain('Auth');
  });

  it('returns empty modules when no clusters', async () => {
    const backend = createMockBackend({ clusters: { clusters: [] } });
    const result = await readResource('ontoindex://repo/test/clusters', backend);
    expect(result).toContain('modules: []');
  });

  it('handles cluster query error gracefully', async () => {
    const backend = createMockBackend();
    backend.queryClusters = vi.fn().mockRejectedValue(new Error('DB locked'));
    const result = await readResource('ontoindex://repo/test/clusters', backend);
    expect(result).toContain('DB locked');
  });

  it('routes ontoindex://repo/{name}/processes correctly', async () => {
    const backend = createMockBackend({
      processes: {
        processes: [{ heuristicLabel: 'LoginFlow', processType: 'intra_community', stepCount: 3 }],
      },
    });
    const result = await readResource('ontoindex://repo/test/processes', backend);
    expect(backend.queryProcesses).toHaveBeenCalledWith('test', 50);
    expect(result).toContain('LoginFlow');
  });

  it('handles process query error gracefully', async () => {
    const backend = createMockBackend();
    backend.queryProcesses = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await readResource('ontoindex://repo/test/processes', backend);
    expect(result).toContain('timeout');
  });

  it('routes ontoindex://repo/{name}/cluster/{clusterName} correctly', async () => {
    const backend = createMockBackend({
      clusterDetail: {
        cluster: { heuristicLabel: 'Auth', symbolCount: 5, cohesion: 0.85 },
        members: [{ name: 'login', type: 'Function', filePath: 'src/auth.ts' }],
      },
    });
    const result = await readResource('ontoindex://repo/test/cluster/Auth', backend);
    expect(backend.queryClusterDetail).toHaveBeenCalledWith('Auth', 'test');
    expect(result).toContain('Auth');
    expect(result).toContain('login');
  });

  it('handles cluster detail error', async () => {
    const backend = createMockBackend({
      clusterDetail: { error: 'Cluster not found' },
    });
    const result = await readResource('ontoindex://repo/test/cluster/Missing', backend);
    expect(result).toContain('Cluster not found');
  });

  it('routes ontoindex://repo/{name}/process/{processName} correctly', async () => {
    const backend = createMockBackend({
      processDetail: {
        process: { heuristicLabel: 'LoginFlow', processType: 'intra_community', stepCount: 3 },
        steps: [
          { step: 1, name: 'login', filePath: 'src/auth.ts' },
          { step: 2, name: 'validate', filePath: 'src/validate.ts' },
        ],
      },
    });
    const result = await readResource('ontoindex://repo/test/process/LoginFlow', backend);
    expect(backend.queryProcessDetail).toHaveBeenCalledWith('LoginFlow', 'test');
    expect(result).toContain('LoginFlow');
    expect(result).toContain('login');
    expect(result).toContain('validate');
  });

  it('marks truncated process detail resources', async () => {
    const backend = createMockBackend({
      processDetail: {
        process: { heuristicLabel: 'LoginFlow', processType: 'intra_community', stepCount: 1500 },
        steps: [{ step: 1, name: 'login', filePath: 'src/auth.ts' }],
        truncated: true,
        stepLimit: 1000,
      },
    });
    const result = await readResource('ontoindex://repo/test/process/LoginFlow', backend);
    expect(result).toContain('truncated at 1000 steps');
  });

  it('handles process detail error', async () => {
    const backend = createMockBackend({
      processDetail: { error: 'Process not found' },
    });
    const result = await readResource('ontoindex://repo/test/process/Missing', backend);
    expect(result).toContain('Process not found');
  });

  it('throws for unknown resource URI', async () => {
    const backend = createMockBackend();
    await expect(readResource('ontoindex://unknown', backend)).rejects.toThrow(
      'Unknown resource URI',
    );
  });

  it('throws for unknown repo-scoped resource type', async () => {
    const backend = createMockBackend();
    await expect(readResource('ontoindex://repo/test/nonexistent', backend)).rejects.toMatchObject({
      code: -32002,
    });
  });

  it('decodes URI-encoded repo names', async () => {
    const backend = createMockBackend();
    await readResource('ontoindex://repo/my%20project/schema', backend);
    // Should not throw — the schema resource is static
  });

  it('decodes URI-encoded cluster names', async () => {
    const backend = createMockBackend({
      clusterDetail: {
        cluster: { heuristicLabel: 'Auth Module', symbolCount: 5 },
        members: [],
      },
    });
    await readResource('ontoindex://repo/test/cluster/Auth%20Module', backend);
    expect(backend.queryClusterDetail).toHaveBeenCalledWith('Auth Module', 'test');
  });

  it('repos resource shows multi-repo hint for multiple repos', async () => {
    const backend = createMockBackend({
      repos: [
        { name: 'proj-a', path: '/a', indexedAt: '2024-01-01', lastCommit: 'abc' },
        { name: 'proj-b', path: '/b', indexedAt: '2024-01-02', lastCommit: 'def' },
      ],
    });
    const result = await readResource('ontoindex://repos', backend);
    expect(result).toContain('Multiple repos indexed');
    expect(result).toContain('repo parameter');
  });

  // ─── Advisory memories ──────────────────────────────────────────────

  it('memories resource returns empty when no memories dir', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-memories-empty-'));
    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });
    const result = await readResource('ontoindex://repo/r/memories', backend);
    expect(result).toContain('advisory_boundary');
    expect(result).toContain('memories: []');
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('memories resource lists valid and invalid memories', async () => {
    const repoDir = await createMemoryRepo('gn-memories-list-');
    const validMemory = makeMemoryContent([], ['# Valid memory']);
    const invalidMemory = [
      '---',
      'version: 1',
      '# missing most required fields',
      '---',
      '# Invalid memory',
    ].join('\n');

    await fs.writeFile(path.join(repoDir, '.ontoindex/memories/valid.md'), validMemory, 'utf8');
    await fs.writeFile(path.join(repoDir, '.ontoindex/memories/bad.md'), invalidMemory, 'utf8');

    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });
    const result = await readResource('ontoindex://repo/r/memories', backend);

    expect(result).toContain('advisory_boundary');
    expect(result).toContain('valid.md');
    expect(result).toContain('bad.md');
    expect(result).toContain('source: memory');
    expect(result).toContain('valid: true');
    expect(result).toContain('valid: false');
    expect(result).toContain('freshness: "fresh"');
    expect(result).toContain('source_commit: "abc1234"');
    expect(result).toContain('indexed_commit: "def5678"');
    expect(result).toContain('not_audit_evidence: true');
    expect(result).toContain('missing_fields');
    expect(result).toContain('reason:');

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('memory resource reads a valid memory file with advisory header', async () => {
    const repoDir = await createMemoryRepo('gn-memory-read-');
    const content = makeMemoryContent([], ['# Onboarding', 'Welcome to the project.']);
    await fs.writeFile(path.join(repoDir, '.ontoindex/memories/onboarding.md'), content, 'utf8');

    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });
    const result = await readResource('ontoindex://repo/r/memory/onboarding', backend);

    expect(result).toContain('ADVISORY MEMORY');
    expect(result).toContain('advisory_boundary');
    expect(result).toContain('memory:');
    expect(result).toContain('source: memory');
    expect(result).toContain('file: "onboarding.md"');
    expect(result).toContain('freshness: "fresh"');
    expect(result).toContain('source_commit: "abc1234"');
    expect(result).toContain('indexed_commit: "def5678"');
    expect(result).toContain('not_audit_evidence: true');
    expect(result).toContain('Not audit evidence');
    expect(result).toContain('Welcome to the project.');

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('does not read memories whose real target escapes the repository', async () => {
    const repoDir = await createMemoryRepo('gn-memory-symlink-');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-memory-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.md'), 'outside secret');
      await fs.symlink(
        path.join(outside, 'secret.md'),
        path.join(repoDir, '.ontoindex/memories/escape.md'),
      );
      await fs.writeFile(
        path.join(repoDir, '.ontoindex/memories/internal.md'),
        makeMemoryContent([], ['inside memory']),
      );
      expect(await loadMemory(repoDir, 'escape')).toBeNull();
      expect((await loadMemory(repoDir, 'internal'))?.content).toContain('inside memory');
      expect((await loadMemories(repoDir)).map((memory) => memory.fileName)).toEqual([
        'internal.md',
      ]);
      await fs.rm(path.join(repoDir, '.ontoindex/memories'), { recursive: true });
      await fs.symlink(outside, path.join(repoDir, '.ontoindex/memories'));
      expect(await loadMemories(repoDir)).toEqual([]);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('memory resource reports invalid front matter clearly', async () => {
    const repoDir = await createMemoryRepo('gn-memory-invalid-');

    const content = ['---', 'version: 1', '---', '# Partial memory'].join('\n');
    await fs.writeFile(path.join(repoDir, '.ontoindex/memories/partial.md'), content, 'utf8');

    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });
    const result = await readResource('ontoindex://repo/r/memory/partial', backend);

    expect(result).toContain('advisory_boundary');
    expect(result).toContain('invalid_memory: true');
    expect(result).toContain('source: memory');
    expect(result).toContain('file: "partial.md"');
    expect(result).toContain('valid: false');
    expect(result).toContain('reason:');
    expect(result).toContain('missing_fields');
    expect(result).toContain('not_audit_evidence');

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('memory resource rejects traversal, absolute, and nested names', async () => {
    const repoDir = await createMemoryRepo('gn-memory-invalid-name-');
    await fs.writeFile(
      path.join(repoDir, '.ontoindex/memories/valid.md'),
      makeMemoryContent([], ['# Valid memory']),
      'utf8',
    );

    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });

    for (const name of ['../secrets', '/etc/passwd', 'nested/name']) {
      const result = await readResource(
        `ontoindex://repo/r/memory/${encodeURIComponent(name)}`,
        backend,
      );
      expect(result).toContain('invalid_memory: true');
      expect(result).toContain('invalid_fields: ["file"]');
    }

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('memory resource rejects non-markdown and URL-like names', async () => {
    const repoDir = await createMemoryRepo('gn-memory-invalid-kind-');
    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });

    for (const name of ['notes.txt', 'http://example.com/memory']) {
      const result = await readResource(
        `ontoindex://repo/r/memory/${encodeURIComponent(name)}`,
        backend,
      );
      expect(result).toContain('invalid_memory: true');
      expect(result).toContain('reason:');
    }

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('memories resource keeps oversized files visible as invalid advisory artifacts', async () => {
    const repoDir = await createMemoryRepo('gn-memories-oversized-');
    await fs.writeFile(
      path.join(repoDir, '.ontoindex/memories/oversized.md'),
      `# ${'x'.repeat(MAX_MEMORY_FILE_SIZE_BYTES + 32)}`,
      'utf8',
    );

    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });
    const result = await readResource('ontoindex://repo/r/memories', backend);

    expect(result).toContain('oversized.md');
    expect(result).toContain('valid: false');
    expect(result).toContain('size_bytes:');
    expect(result).toContain(`Memory file exceeds ${MAX_MEMORY_FILE_SIZE_BYTES} bytes`);

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('memory resource reports oversized files as invalid advisory artifacts', async () => {
    const repoDir = await createMemoryRepo('gn-memory-oversized-');
    await fs.writeFile(
      path.join(repoDir, '.ontoindex/memories/oversized.md'),
      `# ${'x'.repeat(MAX_MEMORY_FILE_SIZE_BYTES + 32)}`,
      'utf8',
    );

    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });
    const result = await readResource('ontoindex://repo/r/memory/oversized', backend);

    expect(result).toContain('invalid_memory: true');
    expect(result).toContain('oversized.md');
    expect(result).toContain(`Memory file exceeds ${MAX_MEMORY_FILE_SIZE_BYTES} bytes`);

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('memory resource returns not-found message for missing file', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-memory-missing-'));
    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });
    const result = await readResource('ontoindex://repo/r/memory/nonexistent', backend);
    expect(result).toContain('ADVISORY MEMORY');
    expect(result).toContain('not found');
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('onboarding resource prefers onboarding.md', async () => {
    const repoDir = await createMemoryRepo('gn-onboarding-');
    const onboardingContent = makeMemoryContent(
      ['source_commit: abc', 'indexed_commit: def', 'sources:', '  - docs/adr/0001.md'],
      ['# Onboarding guide'],
    );
    await fs.writeFile(
      path.join(repoDir, '.ontoindex/memories/onboarding.md'),
      onboardingContent,
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, '.ontoindex/memories/aaa.md'),
      '# Would be picked first alphabetically',
      'utf8',
    );

    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });
    const result = await readResource('ontoindex://repo/r/onboarding', backend);

    expect(result).toContain('ADVISORY MEMORY');
    expect(result).toContain('advisory_boundary');
    expect(result).toContain('memory:');
    expect(result).toContain('source: memory');
    expect(result).toContain('file: "onboarding.md"');
    expect(result).toContain('source_commit: "abc"');
    expect(result).toContain('indexed_commit: "def"');
    expect(result).toContain('not_audit_evidence: true');
    expect(result).toContain('Onboarding guide');

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('onboarding resource falls back to first alphabetical memory', async () => {
    const repoDir = await createMemoryRepo('gn-onboarding-fallback-');

    await fs.writeFile(path.join(repoDir, '.ontoindex/memories/zzz.md'), '# last', 'utf8');
    await fs.writeFile(
      path.join(repoDir, '.ontoindex/memories/aaa.md'),
      '# first alphabetically',
      'utf8',
    );

    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });
    const result = await readResource('ontoindex://repo/r/onboarding', backend);

    expect(result).toContain('ADVISORY MEMORY');
    expect(result).toContain('advisory_boundary');
    expect(result).toContain('memory:');
    expect(result).toContain('source: memory');
    expect(result).toContain('file: "aaa.md"');
    expect(result).toContain('first alphabetically');

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('onboarding resource returns advisory header when no memories dir', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-onboarding-nodir-'));
    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });
    const result = await readResource('ontoindex://repo/r/onboarding', backend);
    expect(result).toContain('ADVISORY MEMORY');
    expect(result).toContain('advisory_boundary');
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('onboarding resource keeps invalid memories advisory and machine-readable', async () => {
    const repoDir = await createMemoryRepo('gn-onboarding-invalid-');
    await fs.writeFile(
      path.join(repoDir, '.ontoindex/memories/onboarding.md'),
      ['---', 'version: 1', '---', '# Invalid onboarding'].join('\n'),
      'utf8',
    );

    const backend = createMockBackend({
      resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir, lastCommit: 'abc' },
    });
    const result = await readResource('ontoindex://repo/r/onboarding', backend);

    expect(result).toContain('ADVISORY MEMORY');
    expect(result).toContain('advisory_boundary');
    expect(result).toContain('invalid_memory: true');
    expect(result).toContain('source: memory');
    expect(result).toContain('file: "onboarding.md"');
    expect(result).toContain('valid: false');
    expect(result).toContain('reason:');
    expect(result).toContain('missing_fields');

    await fs.rm(repoDir, { recursive: true, force: true });
  });
});

describe('resource YAML string roundtrips', () => {
  const values = [
    'ordinary',
    'true',
    'null',
    '2026-01-01',
    'quotes " and backslash \\',
    'line one\nforged: true',
    'label: value # comment',
    'line\u0085next\u2028next\u2029last',
  ];

  it.each(values)('preserves repository, graph, and trace strings: %j', async (value) => {
    const backend = createMockBackend({
      repos: [{ name: value, path: value, indexedAt: value, lastCommit: 'abcdefghi' }],
      resolvedRepo: { id: 'r', name: 'r' },
      context: {
        projectName: value,
        stats: { fileCount: 1, functionCount: 2, processCount: 3 },
      },
      clusters: { clusters: [{ heuristicLabel: value, symbolCount: 1 }] },
      processes: { processes: [{ heuristicLabel: value, processType: value, stepCount: 1 }] },
      clusterDetail: {
        cluster: { heuristicLabel: value, symbolCount: 1 },
        members: [{ name: value, type: value, filePath: value }],
      },
      processDetail: {
        process: { heuristicLabel: value, processType: value, stepCount: 1 },
        steps: [{ step: 1, name: value, filePath: value }],
      },
    });
    const read = async (resource: string) =>
      yaml.load(
        await readResource(
          resource === 'repos' ? 'ontoindex://repos' : `ontoindex://repo/r/${resource}`,
          backend,
        ),
      ) as any;

    expect(await read('repos')).toEqual({
      repos: [{ name: value, path: value, indexed: value, commit: 'abcdefg' }],
    });
    const context = await read('context');
    expect(context.project).toBe(value);
    expect(context.tools_available.map((tool: object) => Object.keys(tool)[0])).toContain('search');
    expect(context.tools_available.map((tool: object) => Object.keys(tool)[0])).toContain(
      'gn_ensure_fresh',
    );
    expect(context.tools_available.map((tool: object) => Object.keys(tool)[0])).not.toContain(
      'query',
    );
    expect(
      context.resources_available.slice(1, 8).map((entry: object) => Object.keys(entry)),
    ).toEqual(
      [
        'clusters',
        'processes',
        'analysis-packs',
        'analysis-suites',
        'analysis-plan/{id}',
        'cluster/{name}',
        'process/{name}',
      ].map((suffix) => [`ontoindex://repo/${value}/${suffix}`]),
    );
    expect(Object.keys(context)).toEqual([
      'project',
      'runtime_health',
      'stats',
      'tools_available',
      're_index',
      'resources_available',
    ]);
    expect(await read('clusters')).toEqual({ modules: [{ name: value, symbols: 1 }] });
    expect(await read('processes')).toEqual({
      processes: [{ name: value, type: value, steps: 1 }],
    });
    expect(await read('cluster/any')).toEqual({
      module: value,
      symbols: 1,
      members: [{ name: value, type: value, file: value }],
    });
    expect(await read('process/any')).toEqual({
      name: value,
      type: value,
      step_count: 1,
      trace: { 1: `${value} (${value})` },
    });
  });

  it.each(values)('preserves errors without creating YAML keys: %j', async (value) => {
    const backend = createMockBackend({
      clusterDetail: { error: value },
      processDetail: { error: value },
    });
    for (const [resource, method] of [
      ['clusters', 'queryClusters'],
      ['processes', 'queryProcesses'],
      ['cluster/any', 'queryClusterDetail'],
      ['process/any', 'queryProcessDetail'],
    ]) {
      backend[method] = vi.fn().mockRejectedValue(new Error(value));
      expect(yaml.load(await readResource(`ontoindex://repo/r/${resource}`, backend))).toEqual({
        error: value,
      });
    }
    for (const resource of ['cluster/any', 'process/any']) {
      const detailBackend = createMockBackend({
        clusterDetail: { error: value },
        processDetail: { error: value },
      });
      expect(
        yaml.load(await readResource(`ontoindex://repo/r/${resource}`, detailBackend)),
      ).toEqual({ error: value });
    }
  });

  it.each([
    ['primitive failure', 'primitive failure'],
    [null, 'null'],
    [undefined, 'undefined'],
    [42, '42'],
    [false, 'false'],
    [{ stack: 'private stack' }, 'Unknown error'],
  ])('normalizes thrown errors %j', async (error, expected) => {
    const backend = createMockBackend();
    backend.queryClusters.mockRejectedValue(error);
    expect(yaml.load(await readResource('ontoindex://repo/r/clusters', backend))).toEqual({
      error: expected,
    });
  });

  it('serializes the context setup error as one string', async () => {
    expect(
      yaml.load(await readResource('ontoindex://repo/r/context', createMockBackend())),
    ).toEqual({
      error: 'No codebase loaded. Run: ontoindex analyze',
    });
  });

  it('preserves pack, suite, and plan fields and structured params', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-yaml-catalog- '));
    const value = 'quoted " \\ path\nforged: true\u0085line\u2028line\u2029end # comment';
    const packId = 'pack: quoted " \\ value';
    const suiteId = 'suite: quoted " \\ value';
    const params = {
      query: 'name: value # comment',
      enabled: true,
      count: 2,
      nested: { list: ['null', value] },
    };
    try {
      for (const folder of ['model', 'suite']) {
        await fs.mkdir(path.join(repoDir, 'ontoindex-packs', folder), { recursive: true });
      }
      await fs.writeFile(
        path.join(repoDir, 'ontoindex-packs/model/pack.yml'),
        yaml.dump({
          schema: 1,
          id: packId,
          name: value,
          version: '0.1.0',
          kind: 'model',
          tier: 'stable',
          summary: value,
          provides: [value, 'null'],
          tags: [value],
          runs: [{ tool: value, params }],
        }),
      );
      await fs.writeFile(
        path.join(repoDir, 'ontoindex-packs/suite/suite.yml'),
        yaml.dump({
          schema: 1,
          id: suiteId,
          name: value,
          tier: 'stable',
          summary: value,
          packs: [packId],
          tags: [value],
        }),
      );
      const backend = createMockBackend({
        resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir },
      });
      const read = async (resource: string) =>
        yaml.load(await readResource(`ontoindex://repo/r/${resource}`, backend));
      const root = path.join(repoDir, 'ontoindex-packs');
      expect(await read('analysis-packs')).toEqual({
        packs: [
          {
            id: packId,
            name: value,
            kind: 'model',
            tier: 'stable',
            version: '0.1.0',
            summary: value,
            manifest: 'ontoindex-packs/model/pack.yml',
            provides: [value, 'null'],
            runs: [value],
            tags: [value],
          },
        ],
        root,
      });
      expect(await read('analysis-suites')).toEqual({
        suites: [
          {
            id: suiteId,
            name: value,
            tier: 'stable',
            summary: value,
            manifest: 'ontoindex-packs/suite/suite.yml',
            packs: [packId],
            tags: [value],
          },
        ],
        root,
      });
      expect(await read(`analysis-plan/${encodeURIComponent(suiteId)}`)).toEqual({
        target_id: suiteId,
        target_type: 'suite',
        target_name: value,
        root,
        packs: [{ id: packId, kind: 'model', tier: 'stable' }],
        steps: [{ pack: packId, tool: value, params }],
        model_packs: [{ id: packId, provides: [value, 'null'] }],
      });
      expect(await read(`analysis-plan/${encodeURIComponent(value)}`)).toEqual({
        error: `No analysis pack or suite with id "${value}" found.`,
      });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('preserves memory metadata and the original Markdown body', async () => {
    const repoDir = await createMemoryRepo('gn-yaml-memory-');
    const fileName = 'quoted memory.md';
    const body = '# Body\noriginal: "Markdown"\nsecond line\u2028third line';
    try {
      await fs.writeFile(
        path.join(repoDir, '.ontoindex/memories', fileName),
        makeMemoryContent([], [body]),
      );
      const backend = createMockBackend({
        resolvedRepo: { id: 'r', name: 'r', repoPath: repoDir },
      });
      expect(yaml.load(await readResource('ontoindex://repo/r/memories', backend))).toEqual({
        truncated: false,
        total: 1,
        emitted: 1,
        advisory_boundary:
          'Memories are advisory only. NOT audit evidence. Must not drive audit status decisions.',
        memories: [
          {
            source: 'memory',
            file: fileName,
            kind: 'advisory',
            freshness: 'fresh',
            source_commit: 'abc1234',
            indexed_commit: 'def5678',
            not_audit_evidence: true,
            valid: true,
          },
        ],
      });
      const content = (await loadMemory(repoDir, fileName))!.content!;
      const resource = await readResource(
        `ontoindex://repo/r/memory/${encodeURIComponent(fileName)}`,
        backend,
      );
      expect(resource.endsWith(content)).toBe(true);
      expect((yaml.load(resource.slice(0, -content.length)) as any).memory).toEqual({
        source: 'memory',
        file: fileName,
        freshness: 'fresh',
        source_commit: 'abc1234',
        indexed_commit: 'def5678',
        not_audit_evidence: true,
        valid: true,
      });
      const invalidName = 'invalid\nforged: true " \\ name';
      const invalidResource = await readResource(
        `ontoindex://repo/r/memory/${encodeURIComponent(invalidName)}`,
        backend,
      );
      expect(
        invalidResource.startsWith(
          '<!-- ADVISORY MEMORY: Not audit evidence. Do not use to drive audit status decisions. -->\n\n',
        ),
      ).toBe(true);
      const invalid = yaml.load(invalidResource.slice(invalidResource.indexOf('-->') + 3)) as any;
      expect(invalid.file).toBe(invalidName);
      expect(invalid.reason).toContain('control characters');
      expect(Object.keys(invalid)).toEqual([
        'advisory_boundary',
        'invalid_memory',
        'source',
        'file',
        'valid',
        'invalid_fields',
        'reason',
      ]);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });
});

// ─── Memory parser unit tests ───────────────────────────────────────────

describe('parseMemoryFrontMatter', () => {
  it('returns empty front matter and full body when no front matter', () => {
    const { frontMatter, body } = parseMemoryFrontMatter('# Hello\nworld');
    expect(frontMatter).toEqual({});
    expect(body).toBe('# Hello\nworld');
  });

  it('parses scalar fields', () => {
    const content = ['---', 'version: 1', 'repo: MyRepo', 'kind: advisory', '---', '# Body'].join(
      '\n',
    );
    const { frontMatter, body } = parseMemoryFrontMatter(content);
    expect(frontMatter.version).toBe(1);
    expect(frontMatter.repo).toBe('MyRepo');
    expect(frontMatter.kind).toBe('advisory');
    expect(body).toBe('# Body');
  });

  it('parses boolean fields', () => {
    const content = ['---', 'not_audit_evidence: true', '---'].join('\n');
    const { frontMatter } = parseMemoryFrontMatter(content);
    expect(frontMatter.not_audit_evidence).toBe(true);
  });

  it('parses list fields', () => {
    const content = ['---', 'sources:', '  - docs/a.md', '  - docs/b.md', '---'].join('\n');
    const { frontMatter } = parseMemoryFrontMatter(content);
    expect(frontMatter.sources).toEqual(['docs/a.md', 'docs/b.md']);
  });
});

describe('parseMemoryFile', () => {
  it('marks file valid when all required fields present', () => {
    const content = [
      '---',
      'version: 1',
      'repo: R',
      'created_at: 2026-01-01',
      'source_commit: abc',
      'indexed_commit: def',
      'freshness: current',
      'kind: advisory',
      'not_audit_evidence: true',
      'sources:',
      '  - docs/x.md',
      '---',
    ].join('\n');
    const result = parseMemoryFile('/repo/.ontoindex/memories/test.md', content);
    expect(result.valid).toBe(true);
    expect(result.missingFields).toHaveLength(0);
    expect(result.invalidFields).toHaveLength(0);
    expect(result.fileName).toBe('test.md');
    expect(result.frontMatter.freshness).toBe('fresh');
  });

  it('marks file invalid and reports missing fields', () => {
    const content = ['---', 'version: 1', '---'].join('\n');
    const result = parseMemoryFile('/repo/.ontoindex/memories/partial.md', content);
    expect(result.valid).toBe(false);
    expect(result.missingFields).toContain('repo');
    expect(result.missingFields).toContain('not_audit_evidence');
    expect(result.missingFields).toContain('sources');
  });

  it('requires not_audit_evidence to be the boolean true', () => {
    const falseValue = parseMemoryFile(
      '/repo/.ontoindex/memories/false.md',
      makeMemoryContent(['not_audit_evidence: false']),
    );
    const stringValue = parseMemoryFile(
      '/repo/.ontoindex/memories/string.md',
      makeMemoryContent(['not_audit_evidence: "false"']),
    );

    expect(falseValue.valid).toBe(false);
    expect(falseValue.invalidFields).toContain('not_audit_evidence');
    expect(stringValue.valid).toBe(false);
    expect(stringValue.invalidFields).toContain('not_audit_evidence');
  });

  it('requires non-empty sources', () => {
    const result = parseMemoryFile(
      '/repo/.ontoindex/memories/empty-sources.md',
      makeMemoryContent(['sources:']),
    );

    expect(result.valid).toBe(false);
    expect(result.invalidFields).toContain('sources');
  });

  it('accepts canonical freshness values and rejects arbitrary freshness', () => {
    for (const freshness of CANONICAL_MEMORY_FRESHNESS) {
      const result = parseMemoryFile(
        `/repo/.ontoindex/memories/${freshness}.md`,
        makeMemoryContent([`freshness: ${freshness}`]),
      );
      expect(result.valid).toBe(true);
      expect(result.frontMatter.freshness).toBe(freshness);
    }

    const invalid = parseMemoryFile(
      '/repo/.ontoindex/memories/invalid-freshness.md',
      makeMemoryContent(['freshness: eventually']),
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.invalidFields).toContain('freshness');
  });

  it('REQUIRED_MEMORY_FIELDS includes not_audit_evidence', () => {
    expect(REQUIRED_MEMORY_FIELDS).toContain('not_audit_evidence');
  });
});

describe('normalizeMemoryName', () => {
  it('adds a markdown extension for bare memory names', () => {
    expect(normalizeMemoryName('onboarding')).toEqual({
      fileName: 'onboarding.md',
      stem: 'onboarding',
    });
  });

  it('rejects traversal, absolute, nested, hidden, and URL-like names', () => {
    for (const candidate of ['../secret', '/etc/passwd', 'nested/path', '.hidden', 'http://x']) {
      expect(() => normalizeMemoryName(candidate)).toThrow();
    }
  });

  it('rejects non-markdown names', () => {
    expect(() => normalizeMemoryName('notes.txt')).toThrow('Markdown');
  });
});
