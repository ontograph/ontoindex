/**
 * MCP Resources (Multi-Repo)
 *
 * Provides structured on-demand data to AI agents.
 * All resources use repo-scoped URIs: ontoindex://repo/{name}/context
 */

import type { LocalBackend } from './local/local-backend.js';
import { checkStaleness } from './staleness.js';
import { loadAnalysisCatalog } from '../analysis-packs/catalog.js';
import { buildAnalysisExecutionPlan } from '../analysis-packs/execution.js';
import { loadMemories, loadMemory, type ParsedMemory } from './memory-parser.js';
import {
  recordEvidenceReadSafe,
  type EvidenceReadClass,
} from '../core/runtime/evidence-read-ledger.js';

interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

type ResourceSuitability = {
  audit: 'never' | 'verified-only';
  docs: boolean;
  diagnostics: boolean;
};

export interface ResourceContractSummary {
  purpose: string;
  freshness: string;
  evidenceClass: EvidenceReadClass;
  responsePolicy: string;
  suitability: ResourceSuitability;
}

interface ResourceDefinitionEntry extends ResourceDefinition {
  contract: ResourceContractSummary;
}

interface ResourceTemplateEntry extends ResourceTemplate {
  contract: ResourceContractSummary;
}

export interface ResourceContractSummaryEntry {
  kind: 'definition' | 'template';
  uri: string;
  name: string;
  contract: ResourceContractSummary;
}

function errorMessage(err: unknown): unknown {
  return (err as { message: unknown }).message;
}

function formatSuitability(suitability: ResourceSuitability): string {
  return `audit=${suitability.audit},docs=${suitability.docs ? 'yes' : 'no'},diagnostics=${suitability.diagnostics ? 'yes' : 'no'}`;
}

function formatResourceContractSummary(contract: ResourceContractSummary): string {
  return [
    'Contract:',
    `purpose=${contract.purpose};`,
    `freshness=${contract.freshness};`,
    `evidence=${contract.evidenceClass};`,
    `response=${contract.responsePolicy};`,
    `suitability=${formatSuitability(contract.suitability)}.`,
  ].join(' ');
}

const RESOURCE_DEFINITIONS: ResourceDefinitionEntry[] = [
  {
    uri: 'ontoindex://repos',
    name: 'All Indexed Repositories',
    description:
      'List of all indexed repos with stats. Read this first to discover available repos.',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'discover indexed repositories',
      freshness: 'live registry snapshot at read time',
      evidenceClass: 'runtime_diagnostic',
      responsePolicy: 'one entry per indexed repo; no hard list cap',
      suitability: { audit: 'never', docs: true, diagnostics: true },
    },
  },
  {
    uri: 'ontoindex://setup',
    name: 'OntoIndex Setup Content',
    description: 'Returns AGENTS.md content for all indexed repos. Useful for setup/onboarding.',
    mimeType: 'text/markdown',
    contract: {
      purpose: 'setup/onboarding guidance across indexed repos',
      freshness: 'generated on read from current indexed repo list',
      evidenceClass: 'runtime_diagnostic',
      responsePolicy: 'one markdown section per indexed repo; no hard section cap',
      suitability: { audit: 'never', docs: true, diagnostics: true },
    },
  },
];

const RESOURCE_TEMPLATES: ResourceTemplateEntry[] = [
  {
    uriTemplate: 'ontoindex://repo/{name}/context',
    name: 'Repo Overview',
    description: 'Codebase stats, staleness check, and available tools',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'repo overview and staleness hints',
      freshness: 'indexed graph snapshot with runtime staleness probe',
      evidenceClass: 'graph_evidence',
      responsePolicy: 'compact summary; bounded fields',
      suitability: { audit: 'verified-only', docs: true, diagnostics: true },
    },
  },
  {
    uriTemplate: 'ontoindex://repo/{name}/clusters',
    name: 'Repo Modules',
    description: 'All functional areas (Leiden clusters)',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'top functional-area inventory',
      freshness: 'indexed graph snapshot',
      evidenceClass: 'graph_evidence',
      responsePolicy: 'top 20 modules; emits truncation hint when clipped',
      suitability: { audit: 'verified-only', docs: true, diagnostics: false },
    },
  },
  {
    uriTemplate: 'ontoindex://repo/{name}/processes',
    name: 'Repo Processes',
    description: 'All execution flows',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'execution-flow inventory',
      freshness: 'indexed graph snapshot',
      evidenceClass: 'graph_evidence',
      responsePolicy: 'top 20 processes; emits truncation hint when clipped',
      suitability: { audit: 'verified-only', docs: true, diagnostics: false },
    },
  },
  {
    uriTemplate: 'ontoindex://repo/{name}/schema',
    name: 'Graph Schema',
    description: 'Node/edge schema for Cypher queries',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'graph query schema reference',
      freshness: 'static schema text from runtime build',
      evidenceClass: 'runtime_diagnostic',
      responsePolicy: 'static document; no truncation signaling',
      suitability: { audit: 'never', docs: true, diagnostics: true },
    },
  },
  {
    uriTemplate: 'ontoindex://repo/{name}/analysis-packs',
    name: 'Analysis Packs',
    description: 'Discovered local analysis packs (CodeQL-style pack manifests)',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'analysis pack manifest inventory',
      freshness: 'filesystem state at read time',
      evidenceClass: 'graph_evidence',
      responsePolicy: 'full discovered pack list; no hard cap',
      suitability: { audit: 'verified-only', docs: true, diagnostics: true },
    },
  },
  {
    uriTemplate: 'ontoindex://repo/{name}/analysis-suites',
    name: 'Analysis Suites',
    description: 'Discovered local analysis suites that bundle packs',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'analysis suite manifest inventory',
      freshness: 'filesystem state at read time',
      evidenceClass: 'graph_evidence',
      responsePolicy: 'full discovered suite list; no hard cap',
      suitability: { audit: 'verified-only', docs: true, diagnostics: true },
    },
  },
  {
    uriTemplate: 'ontoindex://repo/{name}/analysis-plan/{targetId}',
    name: 'Analysis Plan',
    description: 'Execution plan for a discovered analysis pack or suite',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'resolved analysis execution steps for target pack/suite',
      freshness: 'computed on read from local pack manifests',
      evidenceClass: 'graph_evidence',
      responsePolicy: 'full plan output; no hard cap',
      suitability: { audit: 'verified-only', docs: true, diagnostics: true },
    },
  },
  {
    uriTemplate: 'ontoindex://repo/{name}/cluster/{clusterName}',
    name: 'Module Detail',
    description: 'Deep dive into a specific functional area',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'module detail with representative members',
      freshness: 'indexed graph snapshot',
      evidenceClass: 'graph_evidence',
      responsePolicy: 'member list capped at 20; emits overflow hint',
      suitability: { audit: 'verified-only', docs: true, diagnostics: false },
    },
  },
  {
    uriTemplate: 'ontoindex://repo/{name}/process/{processName}',
    name: 'Process Trace',
    description: 'Step-by-step execution trace',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'process step trace for one execution flow',
      freshness: 'indexed graph snapshot',
      evidenceClass: 'graph_evidence',
      responsePolicy: 'step list bounded by process detail limit; emits truncation marker',
      suitability: { audit: 'verified-only', docs: true, diagnostics: false },
    },
  },
  {
    uriTemplate: 'ontoindex://group/{name}/contracts',
    name: 'Group Contract Registry',
    description:
      'Cross-repo contract registry for a repository group. Optional query: type, repo, unmatchedOnly (true|false).',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'cross-repo contract snapshot for a group',
      freshness: 'computed on read from group metadata and per-repo state',
      evidenceClass: 'runtime_diagnostic',
      responsePolicy: 'JSON payload serialized as text; size depends on group cardinality',
      suitability: { audit: 'never', docs: true, diagnostics: true },
    },
  },
  {
    uriTemplate: 'ontoindex://group/{name}/status',
    name: 'Group Index Status',
    description: 'Per-repo index and contract-registry staleness for a repository group',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'group-wide index and contract staleness diagnostics',
      freshness: 'computed on read from current group members',
      evidenceClass: 'runtime_diagnostic',
      responsePolicy: 'JSON payload serialized as text; size depends on group cardinality',
      suitability: { audit: 'never', docs: true, diagnostics: true },
    },
  },
  {
    uriTemplate: 'ontoindex://repo/{name}/memories',
    name: 'Advisory Memories',
    description: 'List of advisory project memories from .ontoindex/memories/. NOT audit evidence.',
    mimeType: 'text/yaml',
    contract: {
      purpose: 'advisory memory index with validity/freshness metadata',
      freshness: 'filesystem read at request time; validity checked on read',
      evidenceClass: 'advisory_memory',
      responsePolicy: 'one entry per memory file; no hard list cap',
      suitability: { audit: 'never', docs: true, diagnostics: true },
    },
  },
  {
    uriTemplate: 'ontoindex://repo/{name}/memory/{memoryName}',
    name: 'Advisory Memory',
    description: 'Single advisory memory file from .ontoindex/memories/. NOT audit evidence.',
    mimeType: 'text/markdown',
    contract: {
      purpose: 'single advisory memory payload',
      freshness: 'filesystem read at request time; validity checked on read',
      evidenceClass: 'advisory_memory',
      responsePolicy: 'single file payload; returns invalid-memory envelope when malformed',
      suitability: { audit: 'never', docs: true, diagnostics: true },
    },
  },
  {
    uriTemplate: 'ontoindex://repo/{name}/onboarding',
    name: 'Onboarding Memory',
    description:
      'Advisory onboarding memory for the repo (reads onboarding.md if present). NOT audit evidence.',
    mimeType: 'text/markdown',
    contract: {
      purpose: 'preferred onboarding advisory memory',
      freshness: 'filesystem read at request time; onboarding.md or first memory fallback',
      evidenceClass: 'advisory_memory',
      responsePolicy: 'single memory payload; returns advisory fallback text when missing',
      suitability: { audit: 'never', docs: true, diagnostics: true },
    },
  },
];

/**
 * Static resources — includes per-repo resources and the global repos list
 */
export function getResourceDefinitions(): ResourceDefinition[] {
  return RESOURCE_DEFINITIONS.map(({ contract, ...def }) => ({
    ...def,
    description: `${def.description} ${formatResourceContractSummary(contract)}`,
  }));
}

/**
 * Dynamic resource templates
 */
export function getResourceTemplates(): ResourceTemplate[] {
  return RESOURCE_TEMPLATES.map(({ contract, ...template }) => ({
    ...template,
    description: `${template.description} ${formatResourceContractSummary(contract)}`,
  }));
}

export function getResourceContractSummaries(): ResourceContractSummaryEntry[] {
  return [
    ...RESOURCE_DEFINITIONS.map((resource) => ({
      kind: 'definition' as const,
      uri: resource.uri,
      name: resource.name,
      contract: resource.contract,
    })),
    ...RESOURCE_TEMPLATES.map((resource) => ({
      kind: 'template' as const,
      uri: resource.uriTemplate,
      name: resource.name,
      contract: resource.contract,
    })),
  ];
}

/** Query parameters for `ontoindex://group/{name}/contracts` */
type GroupContractsResourceFilter = {
  type?: string;
  repo?: string;
  unmatchedOnly?: boolean;
};

/** Normalized parse result for OntoIndex MCP resource URIs */
type ParsedOntoIndexResource =
  | { kind: 'repos' }
  | { kind: 'setup' }
  | {
      kind: 'repo';
      repoName: string;
      resourceType: string;
      param?: string;
    }
  | {
      kind: 'group';
      groupName: string;
      resourceType: 'contracts';
      contractsFilter: GroupContractsResourceFilter;
    }
  | { kind: 'group'; groupName: string; resourceType: 'status' };

function parseUnmatchedOnlyParam(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

/**
 * Parse a OntoIndex resource URI (repos, setup, per-repo, or per-group templates).
 * Used by `readResource` and tests (round-trip / dispatch coverage).
 */
export function parseResourceUri(uri: string): ParsedOntoIndexResource {
  if (uri === 'ontoindex://repos') return { kind: 'repos' };
  if (uri === 'ontoindex://setup') return { kind: 'setup' };

  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new Error(`Unknown resource URI: ${uri}`);
  }

  if (u.protocol !== 'ontoindex:') {
    throw new Error(`Unknown resource URI: ${uri}`);
  }

  if (u.hostname === 'group') {
    const segments = u.pathname
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean);
    if (segments.length < 2) {
      throw new Error(
        `Invalid group resource URI (expected ontoindex://group/{name}/contracts or .../status): ${uri}`,
      );
    }
    const tail = segments[segments.length - 1]!;
    if (tail !== 'contracts' && tail !== 'status') {
      throw new Error(`Unknown group resource path in URI: ${uri}`);
    }
    const groupName = segments
      .slice(0, -1)
      .map((s) => decodeURIComponent(s))
      .join('/');
    if (!groupName) {
      throw new Error(`Invalid group resource URI (empty group name): ${uri}`);
    }
    if (tail === 'status') {
      return { kind: 'group', groupName, resourceType: 'status' };
    }
    const contractsFilter: GroupContractsResourceFilter = {};
    const type = u.searchParams.get('type');
    if (type && type.trim()) contractsFilter.type = type.trim();
    const repo = u.searchParams.get('repo');
    if (repo && repo.trim()) contractsFilter.repo = repo.trim();
    if (u.searchParams.has('unmatchedOnly')) {
      const coerced = parseUnmatchedOnlyParam(u.searchParams.get('unmatchedOnly'));
      if (coerced !== undefined) contractsFilter.unmatchedOnly = coerced;
    }
    return { kind: 'group', groupName, resourceType: 'contracts', contractsFilter };
  }

  if (u.hostname === 'repo') {
    const segments = u.pathname
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean);
    if (segments.length < 2) {
      throw new Error(`Unknown resource URI: ${uri}`);
    }
    const repoName = decodeURIComponent(segments[0]!);
    const restEncoded = segments.slice(1);
    const rest = restEncoded.map((s) => decodeURIComponent(s)).join('/');

    if (rest.startsWith('cluster/')) {
      return {
        kind: 'repo',
        repoName,
        resourceType: 'cluster',
        param: rest.replace(/^cluster\//, ''),
      };
    }
    if (rest.startsWith('process/')) {
      return {
        kind: 'repo',
        repoName,
        resourceType: 'process',
        param: rest.replace(/^process\//, ''),
      };
    }
    if (rest.startsWith('analysis-plan/')) {
      return {
        kind: 'repo',
        repoName,
        resourceType: 'analysis-plan',
        param: rest.replace(/^analysis-plan\//, ''),
      };
    }
    if (rest.startsWith('memory/')) {
      return {
        kind: 'repo',
        repoName,
        resourceType: 'memory',
        param: rest.replace(/^memory\//, ''),
      };
    }

    return { kind: 'repo', repoName, resourceType: rest };
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}

/**
 * Read a resource and return its content
 */
export async function readResource(uri: string, backend: LocalBackend): Promise<string> {
  const parsed = parseResourceUri(uri);

  let readClass: EvidenceReadClass = 'unknown';
  let targetType = 'resource';
  let target = uri;
  let repoName: string | undefined = undefined;
  let notAuditEvidence = false;

  if (parsed.kind === 'repos') {
    readClass = 'runtime_diagnostic';
    targetType = 'global_resource';
  } else if (parsed.kind === 'setup') {
    readClass = 'runtime_diagnostic';
    targetType = 'global_resource';
  } else if (parsed.kind === 'group') {
    readClass = 'runtime_diagnostic';
    targetType = 'group_resource';
    target = `${parsed.groupName}/${parsed.resourceType}`;
  } else {
    repoName = parsed.repoName;
    targetType = parsed.resourceType;
    target = parsed.param ? `${parsed.resourceType}/${parsed.param}` : parsed.resourceType;

    switch (parsed.resourceType) {
      case 'context':
      case 'clusters':
      case 'processes':
      case 'cluster':
      case 'process':
      case 'analysis-packs':
      case 'analysis-suites':
      case 'analysis-plan':
        readClass = 'graph_evidence';
        break;
      case 'schema':
        readClass = 'runtime_diagnostic';
        targetType = 'schema';
        break;
      case 'memories':
      case 'memory':
      case 'onboarding':
        readClass = 'advisory_memory';
        notAuditEvidence = true;
        break;
      default:
        readClass = 'unknown';
        break;
    }
  }

  let resultPromise: Promise<string>;

  if (parsed.kind === 'repos') {
    resultPromise = getReposResource(backend);
  } else if (parsed.kind === 'setup') {
    resultPromise = getSetupResource(backend);
  } else if (parsed.kind === 'group') {
    if (parsed.resourceType === 'contracts') {
      resultPromise = backend.readGroupContractsResource(parsed.groupName, parsed.contractsFilter);
    } else {
      resultPromise = backend.readGroupStatusResource(parsed.groupName);
    }
  } else {
    switch (parsed.resourceType) {
      case 'context':
        resultPromise = getContextResource(backend, repoName);
        break;
      case 'clusters':
        resultPromise = getClustersResource(backend, repoName);
        break;
      case 'processes':
        resultPromise = getProcessesResource(backend, repoName);
        break;
      case 'schema':
        resultPromise = Promise.resolve(getSchemaResource());
        break;
      case 'analysis-packs':
        resultPromise = getAnalysisPacksResource(backend, repoName);
        break;
      case 'analysis-suites':
        resultPromise = getAnalysisSuitesResource(backend, repoName);
        break;
      case 'analysis-plan':
        resultPromise = getAnalysisPlanResource(parsed.param!, backend, repoName);
        break;
      case 'cluster':
        resultPromise = getClusterDetailResource(parsed.param!, backend, repoName);
        break;
      case 'process':
        resultPromise = getProcessDetailResource(parsed.param!, backend, repoName);
        break;
      case 'memories':
        resultPromise = getMemoriesResource(backend, repoName);
        break;
      case 'memory':
        resultPromise = getMemoryResource(parsed.param!, backend, repoName);
        break;
      case 'onboarding':
        resultPromise = getOnboardingResource(backend, repoName);
        break;
      default:
        resultPromise = Promise.reject(new Error(`Unknown resource: ${uri}`));
        break;
    }
  }

  try {
    const result = await resultPromise;
    let memoryFreshness: string | undefined = undefined;
    if (readClass === 'advisory_memory' && result.includes('invalid_memory: true')) {
      memoryFreshness = 'invalid';
    }

    recordEvidenceReadSafe({
      readClass,
      surface: 'mcp_resource',
      target,
      targetType,
      repo: repoName,
      notAuditEvidence: notAuditEvidence ? true : undefined,
      memoryFreshness,
    });
    return result;
  } catch (err) {
    recordEvidenceReadSafe({
      readClass,
      surface: 'mcp_resource',
      target,
      targetType,
      repo: repoName,
      notAuditEvidence: notAuditEvidence ? true : undefined,
    });
    throw err;
  }
}

// ─── Resource Implementations ─────────────────────────────────────────

/**
 * Repos resource — list all indexed repositories
 */
async function getReposResource(backend: LocalBackend): Promise<string> {
  const repos = await backend.listRepos();

  if (repos.length === 0) {
    return 'repos: []\n# No repositories indexed. Run: ontoindex analyze';
  }

  const lines: string[] = ['repos:'];
  for (const repo of repos) {
    lines.push(`  - name: "${repo.name}"`);
    lines.push(`    path: "${repo.path}"`);
    lines.push(`    indexed: "${repo.indexedAt}"`);
    lines.push(`    commit: "${repo.lastCommit?.slice(0, 7) || 'unknown'}"`);
    if (repo.stats) {
      lines.push(`    files: ${repo.stats.files || 0}`);
      lines.push(`    symbols: ${repo.stats.nodes || 0}`);
      lines.push(`    processes: ${repo.stats.processes || 0}`);
    }
  }

  if (repos.length > 1) {
    lines.push('');
    lines.push('# Multiple repos indexed. Use repo parameter in tool calls:');
    lines.push(`# ontoindex_search({query: "auth", repo: "${repos[0].name}"})`);
  }

  return lines.join('\n');
}

/**
 * Context resource — codebase overview for a specific repo
 */
async function getContextResource(backend: LocalBackend, repoName?: string): Promise<string> {
  // Refresh repo metadata/context caches so long-lived MCP servers don't
  // serve stale stats after a reindex on disk.
  await backend.listRepos();

  // Resolve repo
  const repo = await backend.resolveRepo(repoName);
  const repoId = repo.id || repo.name.toLowerCase();
  const context = backend.getContext(repoId) || backend.getContext();

  if (!context) {
    return 'error: No codebase loaded. Run: ontoindex analyze';
  }

  // Check staleness
  const repoPath = repo.repoPath;
  const lastCommit = repo.lastCommit || 'HEAD';
  const analysisCatalog = repoPath ? await loadAnalysisCatalog(repoPath) : null;
  const staleness = repoPath
    ? await checkStaleness(repoPath, lastCommit)
    : { isStale: false, commitsBehind: 0 };

  const lines: string[] = [`project: ${context.projectName}`];

  if (staleness.isStale && staleness.hint) {
    lines.push('');
    lines.push(`staleness: "${staleness.hint}"`);
  }

  lines.push('');
  lines.push('stats:');
  lines.push(`  files: ${context.stats.fileCount}`);
  lines.push(`  symbols: ${context.stats.functionCount}`);
  lines.push(`  processes: ${context.stats.processCount}`);
  lines.push('');
  lines.push('tools_available:');
  lines.push('  - query: Process-grouped code intelligence (execution flows related to a concept)');
  lines.push('  - context: 360-degree symbol view (categorized refs, process participation)');
  lines.push('  - impact: Blast radius analysis (what breaks if you change a symbol)');
  lines.push('  - analysis_catalog: Local pack/suite catalog for CodeQL-style OntoIndex analyses');
  lines.push('  - detect_changes: Git-diff impact analysis (what do your changes affect)');
  lines.push('  - rename: Multi-file coordinated rename with confidence tags');
  lines.push('  - cypher: Raw graph queries');
  lines.push('  - list_repos: Discover all indexed repositories');

  if (
    analysisCatalog &&
    (analysisCatalog.packs.length || analysisCatalog.suites.length || analysisCatalog.errors.length)
  ) {
    const stablePackCount = analysisCatalog.packs.filter((pack) => pack.tier === 'stable').length;
    const experimentalPackCount = analysisCatalog.packs.filter(
      (pack) => pack.tier === 'experimental',
    ).length;
    lines.push('');
    lines.push('analysis_catalog:');
    lines.push(`  packs: ${analysisCatalog.packs.length}`);
    lines.push(`  suites: ${analysisCatalog.suites.length}`);
    lines.push(`  stable_packs: ${stablePackCount}`);
    lines.push(`  experimental_packs: ${experimentalPackCount}`);
    if (analysisCatalog.errors.length > 0) {
      lines.push(`  manifest_errors: ${analysisCatalog.errors.length}`);
    }
  }

  lines.push('');
  lines.push('re_index: Run `ontoindex analyze` in terminal if data is stale');
  lines.push('');
  lines.push('resources_available:');
  lines.push('  - ontoindex://repos: All indexed repositories');
  lines.push(`  - ontoindex://repo/${context.projectName}/clusters: All functional areas`);
  lines.push(`  - ontoindex://repo/${context.projectName}/processes: All execution flows`);
  lines.push(
    `  - ontoindex://repo/${context.projectName}/analysis-packs: Local analysis pack manifests`,
  );
  lines.push(
    `  - ontoindex://repo/${context.projectName}/analysis-suites: Local analysis suite manifests`,
  );
  lines.push(
    `  - ontoindex://repo/${context.projectName}/analysis-plan/{id}: Execution plan for a pack or suite`,
  );
  lines.push(`  - ontoindex://repo/${context.projectName}/cluster/{name}: Module details`);
  lines.push(`  - ontoindex://repo/${context.projectName}/process/{name}: Process trace`);
  lines.push(
    '  - ontoindex://group/{name}/contracts: Group contract registry (optional ?type=&repo=&unmatchedOnly=)',
  );
  lines.push('  - ontoindex://group/{name}/status: Group index / contract staleness');

  return lines.join('\n');
}

/**
 * Clusters resource — queries graph directly via backend.queryClusters()
 */
async function getClustersResource(backend: LocalBackend, repoName?: string): Promise<string> {
  try {
    const result = await backend.queryClusters(repoName, 100);

    if (!result.clusters || result.clusters.length === 0) {
      return 'modules: []\n# No functional areas detected. Run: ontoindex analyze';
    }

    const displayLimit = 20;
    const lines: string[] = ['modules:'];
    const toShow = result.clusters.slice(0, displayLimit);

    for (const cluster of toShow) {
      const label = cluster.heuristicLabel || cluster.label || cluster.id;
      lines.push(`  - name: "${label}"`);
      lines.push(`    symbols: ${cluster.symbolCount || 0}`);
      if (cluster.cohesion) {
        lines.push(`    cohesion: ${(cluster.cohesion * 100).toFixed(0)}%`);
      }
    }

    if (result.clusters.length > displayLimit) {
      lines.push(
        `\n# Showing top ${displayLimit} of ${result.clusters.length} modules. Use ontoindex_query for deeper search.`,
      );
    }

    return lines.join('\n');
  } catch (err: unknown) {
    return `error: ${errorMessage(err)}`;
  }
}

/**
 * Processes resource — queries graph directly via backend.queryProcesses()
 */
async function getProcessesResource(backend: LocalBackend, repoName?: string): Promise<string> {
  try {
    const result = await backend.queryProcesses(repoName, 50);

    if (!result.processes || result.processes.length === 0) {
      return 'processes: []\n# No processes detected. Run: ontoindex analyze';
    }

    const displayLimit = 20;
    const lines: string[] = ['processes:'];
    const toShow = result.processes.slice(0, displayLimit);

    for (const proc of toShow) {
      const label = proc.heuristicLabel || proc.label || proc.id;
      lines.push(`  - name: "${label}"`);
      lines.push(`    type: ${proc.processType || 'unknown'}`);
      lines.push(`    steps: ${proc.stepCount || 0}`);
    }

    if (result.processes.length > displayLimit) {
      lines.push(
        `\n# Showing top ${displayLimit} of ${result.processes.length} processes. Use ontoindex_query for deeper search.`,
      );
    }

    return lines.join('\n');
  } catch (err: unknown) {
    return `error: ${errorMessage(err)}`;
  }
}

async function getAnalysisPacksResource(backend: LocalBackend, repoName?: string): Promise<string> {
  const repo = await backend.resolveRepo(repoName);
  const catalog = await loadAnalysisCatalog(repo.repoPath);

  if (catalog.packs.length === 0) {
    return [
      'packs: []',
      `root: "${catalog.rootPath}"`,
      catalog.errors.length > 0
        ? `manifest_errors: ${catalog.errors.length}`
        : '# No analysis packs discovered.',
    ].join('\n');
  }

  const lines: string[] = ['packs:'];
  for (const pack of catalog.packs) {
    lines.push(`  - id: "${pack.id}"`);
    lines.push(`    name: "${pack.name}"`);
    lines.push(`    kind: "${pack.kind}"`);
    lines.push(`    tier: "${pack.tier}"`);
    lines.push(`    version: "${pack.version}"`);
    lines.push(`    summary: "${pack.summary}"`);
    lines.push(`    manifest: "${pack.manifestPath}"`);
    if (pack.provides.length > 0) {
      lines.push(`    provides: [${pack.provides.map((item) => `"${item}"`).join(', ')}]`);
    }
    if (pack.runs.length > 0) {
      lines.push(`    runs: [${pack.runs.map((run) => `"${run.tool}"`).join(', ')}]`);
    }
    if (pack.tags.length > 0) {
      lines.push(`    tags: [${pack.tags.map((item) => `"${item}"`).join(', ')}]`);
    }
  }
  lines.push(`root: "${catalog.rootPath}"`);
  if (catalog.errors.length > 0) {
    lines.push(`manifest_errors: ${catalog.errors.length}`);
  }
  return lines.join('\n');
}

async function getAnalysisSuitesResource(
  backend: LocalBackend,
  repoName?: string,
): Promise<string> {
  const repo = await backend.resolveRepo(repoName);
  const catalog = await loadAnalysisCatalog(repo.repoPath);

  if (catalog.suites.length === 0) {
    return [
      'suites: []',
      `root: "${catalog.rootPath}"`,
      catalog.errors.length > 0
        ? `manifest_errors: ${catalog.errors.length}`
        : '# No analysis suites discovered.',
    ].join('\n');
  }

  const lines: string[] = ['suites:'];
  for (const suite of catalog.suites) {
    lines.push(`  - id: "${suite.id}"`);
    lines.push(`    name: "${suite.name}"`);
    lines.push(`    tier: "${suite.tier}"`);
    lines.push(`    summary: "${suite.summary}"`);
    lines.push(`    manifest: "${suite.manifestPath}"`);
    lines.push(`    packs: [${suite.packs.map((item) => `"${item}"`).join(', ')}]`);
    if (suite.tags.length > 0) {
      lines.push(`    tags: [${suite.tags.map((item) => `"${item}"`).join(', ')}]`);
    }
  }
  lines.push(`root: "${catalog.rootPath}"`);
  if (catalog.errors.length > 0) {
    lines.push(`manifest_errors: ${catalog.errors.length}`);
  }
  return lines.join('\n');
}

async function getAnalysisPlanResource(
  targetId: string,
  backend: LocalBackend,
  repoName?: string,
): Promise<string> {
  try {
    const repo = await backend.resolveRepo(repoName);
    const plan = await buildAnalysisExecutionPlan(repo.repoPath, targetId);
    const lines: string[] = [
      `target_id: "${plan.target.id}"`,
      `target_type: "${plan.target.type}"`,
      `target_name: "${plan.target.name}"`,
      `root: "${plan.rootPath}"`,
      'packs:',
    ];

    for (const pack of plan.packs) {
      lines.push(`  - id: "${pack.id}"`);
      lines.push(`    kind: "${pack.kind}"`);
      lines.push(`    tier: "${pack.tier}"`);
    }

    lines.push('steps:');
    for (const step of plan.steps) {
      lines.push(`  - pack: "${step.packId}"`);
      lines.push(`    tool: "${step.tool}"`);
      lines.push(`    params: ${JSON.stringify(step.params)}`);
    }

    lines.push('model_packs:');
    for (const pack of plan.modelPacks) {
      lines.push(`  - id: "${pack.id}"`);
      lines.push(`    provides: [${pack.provides.map((item) => `"${item}"`).join(', ')}]`);
    }

    if (plan.errors.length > 0) {
      lines.push(`errors: ${plan.errors.length}`);
    }

    return lines.join('\n');
  } catch (err: unknown) {
    return `error: ${errorMessage(err)}`;
  }
}

/**
 * Schema resource — graph structure for Cypher queries
 */
function getSchemaResource(): string {
  return `# OntoIndex Graph Schema

nodes:
  - File: Source code files
  - Folder: Directory containers
  - Function: Functions and arrow functions
  - Class: Class definitions
  - Interface: Interface/type definitions
  - Method: Class methods
  - CodeElement: Catch-all for other code elements
  - Community: Auto-detected functional area (Leiden algorithm)
  - Process: Execution flow trace

additional_node_types: "Multi-language: Struct, Enum, Macro, Typedef, Union, Namespace, Trait, Impl, TypeAlias, Const, Static, Property, Record, Delegate, Annotation, Constructor, Template, Module (use backticks in queries: \`Struct\`, \`Enum\`, etc.)"

node_properties:
  common: "name (STRING), filePath (STRING), startLine (INT32), endLine (INT32)"
  Method: "parameterCount (INT32), returnType (STRING), isVariadic (BOOL), visibility (STRING), isStatic (BOOL), isAbstract (BOOL), isFinal (BOOL), isVirtual (BOOL), isOverride (BOOL), isAsync (BOOL), isPartial (BOOL), requiredParameterCount (INT32), parameterTypes (STRING[]), annotations (STRING[])"
  Function: "parameterCount (INT32), returnType (STRING), isVariadic (BOOL), visibility (STRING), isStatic (BOOL), isAbstract (BOOL), isFinal (BOOL), isAsync (BOOL), parameterTypes (STRING[]), annotations (STRING[])"
  Property: "declaredType (STRING) — the field's type annotation (e.g., 'Address', 'City'). Used for field-access chain resolution."
  Constructor: "parameterCount (INT32), visibility (STRING), isStatic (BOOL), parameterTypes (STRING[])"
  Community: "heuristicLabel (STRING), cohesion (DOUBLE), symbolCount (INT32), keywords (STRING[]), description (STRING), enrichedBy (STRING)"
  Process: "heuristicLabel (STRING), processType (STRING — 'intra_community' or 'cross_community'), stepCount (INT32), communities (STRING[]), entryPointId (STRING), terminalId (STRING)"

relationships:
  - CONTAINS: File/Folder contains child
  - DEFINES: File defines a symbol
  - CALLS: Function/method invocation
  - IMPORTS: Module imports
  - EXTENDS: Class inheritance
  - IMPLEMENTS: Interface implementation
  - HAS_METHOD: Class/Struct/Interface owns a Method
  - HAS_PROPERTY: Class/Struct/Interface owns a Property (field)
  - ACCESSES: Function/Method reads or writes a Property (reason: 'read' or 'write')
  - METHOD_OVERRIDES: Method overrides another Method (MRO)
  - METHOD_IMPLEMENTS: ConcreteMethod implements InterfaceMethod (matched by name + parameterTypes)
  - MEMBER_OF: Symbol belongs to community
  - STEP_IN_PROCESS: Symbol is step N in process

relationship_table: "All relationships use a single CodeRelation table with a 'type' property. Properties: type (STRING), confidence (DOUBLE), reason (STRING), step (INT32)"

example_queries:
  find_callers: |
    MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
    RETURN caller.name, caller.filePath
  
  find_community_members: |
    MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
    WHERE c.heuristicLabel = "Auth"
    RETURN s.name, labels(s)[0] AS type
  
  trace_process: |
    MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
    WHERE p.heuristicLabel = "LoginFlow"
    RETURN s.name, r.step
    ORDER BY r.step
`;
}

/**
 * Cluster detail resource — queries graph directly via backend.queryClusterDetail()
 */
async function getClusterDetailResource(
  name: string,
  backend: LocalBackend,
  repoName?: string,
): Promise<string> {
  try {
    const result = await backend.queryClusterDetail(name, repoName);

    if (result.error) {
      return `error: ${result.error}`;
    }

    const cluster = result.cluster;
    const members = result.members || [];

    const lines: string[] = [
      `module: "${cluster.heuristicLabel || cluster.label || cluster.id}"`,
      `symbols: ${cluster.symbolCount || members.length}`,
    ];

    if (cluster.cohesion) {
      lines.push(`cohesion: ${(cluster.cohesion * 100).toFixed(0)}%`);
    }

    if (members.length > 0) {
      lines.push('');
      lines.push('members:');
      for (const member of members.slice(0, 20)) {
        lines.push(`  - name: ${member.name}`);
        lines.push(`    type: ${member.type}`);
        lines.push(`    file: ${member.filePath}`);
      }
      if (members.length > 20) {
        lines.push(`  # ... and ${members.length - 20} more`);
      }
    }

    return lines.join('\n');
  } catch (err: unknown) {
    return `error: ${errorMessage(err)}`;
  }
}

/**
 * Process detail resource — queries graph directly via backend.queryProcessDetail()
 */
async function getProcessDetailResource(
  name: string,
  backend: LocalBackend,
  repoName?: string,
): Promise<string> {
  try {
    const result = await backend.queryProcessDetail(name, repoName);

    if (result.error) {
      return `error: ${result.error}`;
    }

    const proc = result.process;
    const steps = result.steps || [];

    const lines: string[] = [
      `name: "${proc.heuristicLabel || proc.label || proc.id}"`,
      `type: ${proc.processType || 'unknown'}`,
      `step_count: ${proc.stepCount || steps.length}`,
    ];

    if (steps.length > 0) {
      lines.push('');
      lines.push('trace:');
      for (const step of steps) {
        lines.push(`  ${step.step}: ${step.name} (${step.filePath})`);
      }
      if (result.truncated) {
        lines.push(`  # truncated at ${result.stepLimit ?? steps.length} steps`);
      }
    }

    return lines.join('\n');
  } catch (err: unknown) {
    return `error: ${errorMessage(err)}`;
  }
}

/**
 * Setup resource — generates AGENTS.md content for all indexed repos.
 */
async function getSetupResource(backend: LocalBackend): Promise<string> {
  const repos = await backend.listRepos();

  if (repos.length === 0) {
    return '# OntoIndex\n\nNo repositories indexed. Run: `npx ontoindex analyze` in a repository.';
  }

  const sections: string[] = [];

  for (const repo of repos) {
    const stats = repo.stats || {};
    const lines = [
      `# OntoIndex MCP — ${repo.name}`,
      '',
      `This project is indexed by OntoIndex as **${repo.name}** (${stats.nodes || 0} symbols, ${stats.edges || 0} relationships, ${stats.processes || 0} execution flows).`,
      '',
      '## Tools',
      '',
      '| Tool | What it gives you |',
      '|------|-------------------|',
      '| `query` | Process-grouped code intelligence — execution flows related to a concept |',
      '| `context` | 360-degree symbol view — categorized refs, processes it participates in |',
      '| `impact` | Symbol blast radius — what breaks at depth 1/2/3 with confidence |',
      '| `detect_changes` | Git-diff impact — what do your current changes affect |',
      '| `rename` | Multi-file coordinated rename with confidence-tagged edits |',
      '| `cypher` | Raw graph queries |',
      '| `list_repos` | Discover indexed repos |',
      '',
      '## Resources',
      '',
      `- \`ontoindex://repo/${repo.name}/context\` — Stats, staleness check`,
      `- \`ontoindex://repo/${repo.name}/clusters\` — All functional areas`,
      `- \`ontoindex://repo/${repo.name}/processes\` — All execution flows`,
      `- \`ontoindex://repo/${repo.name}/schema\` — Graph schema for Cypher`,
    ];
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

const ADVISORY_MEMORY_HEADER =
  '<!-- ADVISORY MEMORY: Not audit evidence. Do not use to drive audit status decisions. -->';
const ADVISORY_BOUNDARY =
  'advisory_boundary: "Memories are advisory only. NOT audit evidence. Must not drive audit status decisions."';

function appendValidMemoryMetadata(lines: string[], indent: string, mem: ParsedMemory): void {
  lines.push(`${indent}source: memory`);
  lines.push(`${indent}file: "${mem.fileName}"`);
  lines.push(`${indent}freshness: "${mem.frontMatter.freshness}"`);
  lines.push(`${indent}source_commit: "${mem.frontMatter.source_commit}"`);
  lines.push(`${indent}indexed_commit: "${mem.frontMatter.indexed_commit}"`);
  lines.push(`${indent}not_audit_evidence: ${mem.frontMatter.not_audit_evidence}`);
  lines.push(`${indent}valid: true`);
}

function appendInvalidMemoryMetadata(lines: string[], indent: string, mem: ParsedMemory): void {
  lines.push(`${indent}source: memory`);
  lines.push(`${indent}file: "${mem.fileName}"`);
  lines.push(`${indent}valid: false`);
  appendMemoryValidation(lines, indent, mem);
}

function getMemoryValidationReason(mem: ParsedMemory): string | undefined {
  const reasons: string[] = [];
  if (mem.missingFields.length > 0) {
    reasons.push(`Missing required fields: ${mem.missingFields.join(', ')}`);
  }
  if (mem.validationErrors.length > 0) {
    reasons.push(...mem.validationErrors);
  } else if (mem.invalidFields.length > 0) {
    reasons.push(`Invalid fields: ${mem.invalidFields.join(', ')}`);
  }
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

function appendMemoryValidation(lines: string[], indent: string, mem: ParsedMemory): void {
  if (mem.missingFields.length > 0) {
    lines.push(
      `${indent}missing_fields: [${mem.missingFields.map((field) => `"${field}"`).join(', ')}]`,
    );
  }
  if (mem.invalidFields.length > 0) {
    lines.push(
      `${indent}invalid_fields: [${mem.invalidFields.map((field) => `"${field}"`).join(', ')}]`,
    );
  }
  const reason = getMemoryValidationReason(mem);
  if (reason) {
    lines.push(`${indent}reason: "${reason.replaceAll('"', '\\"')}"`);
  }
  if (mem.sizeBytes !== undefined) {
    lines.push(`${indent}size_bytes: ${mem.sizeBytes}`);
  }
}

function renderInvalidMemoryResource(mem: ParsedMemory, content?: string | null): string {
  const lines = [ADVISORY_MEMORY_HEADER, '', ADVISORY_BOUNDARY, '', 'invalid_memory: true'];
  appendInvalidMemoryMetadata(lines, '', mem);
  if (content) {
    lines.push('', content);
  }
  return lines.join('\n');
}

/**
 * Memories resource — lists all advisory memory files in .ontoindex/memories/.
 */
async function getMemoriesResource(backend: LocalBackend, repoName?: string): Promise<string> {
  const repo = await backend.resolveRepo(repoName);
  const memories = await loadMemories(repo.repoPath);

  const lines: string[] = [ADVISORY_BOUNDARY, ''];

  if (memories.length === 0) {
    lines.push('memories: []');
    lines.push('# No advisory memories found in .ontoindex/memories/');
    return lines.join('\n');
  }

  lines.push('memories:');
  for (const mem of memories) {
    if (mem.valid) {
      lines.push(`  - source: memory`);
      lines.push(`    file: "${mem.fileName}"`);
      lines.push(`    kind: "${mem.frontMatter.kind}"`);
      lines.push(`    freshness: "${mem.frontMatter.freshness}"`);
      lines.push(`    source_commit: "${mem.frontMatter.source_commit}"`);
      lines.push(`    indexed_commit: "${mem.frontMatter.indexed_commit}"`);
      lines.push(`    not_audit_evidence: ${mem.frontMatter.not_audit_evidence}`);
      lines.push(`    valid: true`);
    } else {
      lines.push(`  - source: memory`);
      lines.push(`    file: "${mem.fileName}"`);
      lines.push(`    valid: false`);
      appendMemoryValidation(lines, '    ', mem);
      lines.push(`    # Invalid advisory memory`);
    }
  }

  return lines.join('\n');
}

/**
 * Memory resource — reads a single advisory memory file by name.
 */
async function getMemoryResource(
  memoryName: string,
  backend: LocalBackend,
  repoName?: string,
): Promise<string> {
  const repo = await backend.resolveRepo(repoName);
  const loaded = await loadMemory(repo.repoPath, memoryName);
  if (!loaded) {
    const fileName = memoryName.endsWith('.md') ? memoryName : `${memoryName}.md`;
    return [
      ADVISORY_MEMORY_HEADER,
      ``,
      ADVISORY_BOUNDARY,
      ``,
      `error: Memory file not found: ${fileName}`,
    ].join('\n');
  }

  const { content, memory: mem } = loaded;
  const contentText = content ?? '';

  if (!mem.valid) {
    return renderInvalidMemoryResource(mem, content);
  }

  const lines = [ADVISORY_MEMORY_HEADER, ``, ADVISORY_BOUNDARY, ``, 'memory:'];
  appendValidMemoryMetadata(lines, '  ', mem);
  lines.push('', contentText);

  return lines.join('\n');
}

/**
 * Onboarding resource — reads onboarding.md if present, else first memory alphabetically.
 * Always advisory. Not audit evidence.
 */
async function getOnboardingResource(backend: LocalBackend, repoName?: string): Promise<string> {
  const repo = await backend.resolveRepo(repoName);
  const header = ADVISORY_MEMORY_HEADER;
  const memories = await loadMemories(repo.repoPath);
  if (memories.length === 0) {
    return [
      header,
      ``,
      ADVISORY_BOUNDARY,
      ``,
      `# No advisory memories found in .ontoindex/memories/`,
    ].join('\n');
  }

  const target = memories.find((memory) => memory.fileName === 'onboarding.md') ?? memories[0]!;
  const loaded = await loadMemory(repo.repoPath, target.fileName);
  if (!loaded) {
    return [
      header,
      ``,
      ADVISORY_BOUNDARY,
      ``,
      `error: Could not read onboarding memory: ${target.fileName}`,
    ].join('\n');
  }

  const { content, memory: mem } = loaded;
  const contentText = content ?? '';
  if (!mem.valid) {
    return renderInvalidMemoryResource(mem, content);
  }

  const lines = [header, ``, ADVISORY_BOUNDARY, ``, 'memory:'];
  appendValidMemoryMetadata(lines, '  ', mem);
  lines.push('', contentText);

  return lines.join('\n');
}
