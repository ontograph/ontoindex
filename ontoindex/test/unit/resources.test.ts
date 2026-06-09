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
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  getResourceDefinitions,
  getResourceTemplates,
  parseResourceUri,
  readResource,
} from '../../src/mcp/resources.js';
import {
  CANONICAL_MEMORY_FRESHNESS,
  MAX_MEMORY_FILE_SIZE_BYTES,
  normalizeMemoryName,
  parseMemoryFrontMatter,
  parseMemoryFile,
  REQUIRED_MEMORY_FIELDS,
} from '../../src/mcp/memory-parser.js';

// ─── Minimal mock backend ──────────────────────────────────────────

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
    expect(() => parseResourceUri('ontoindex://group/foo/bar')).toThrow('Unknown group resource');
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
    await expect(readResource('ontoindex://repo/test/nonexistent', backend)).rejects.toThrow(
      'Unknown resource',
    );
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
