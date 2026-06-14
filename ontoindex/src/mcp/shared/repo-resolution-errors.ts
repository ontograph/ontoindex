import path from 'node:path';

export interface RepoResolutionCandidate {
  label: string;
  path: string;
}

export interface RepoResolutionEnvironment {
  mcpRepo?: string;
  projectCwd?: string;
  processCwd?: string;
}

export interface RepoResolutionErrorOptions {
  reason: 'not-found' | 'ambiguous' | 'no-index';
  requestedRepo?: string;
  candidates: readonly RepoResolutionCandidate[];
  environment?: RepoResolutionEnvironment;
  preferredRetryLabel?: string;
  intendedPath?: string;
}

export interface McpStartupMismatchErrorOptions {
  repoSelector: string;
  resolvedRepo: RepoResolutionCandidate;
  projectCwd: string;
  processCwd: string;
  gitRoot?: string;
  source: 'env' | 'cli';
}

export function formatRepoResolutionError(options: RepoResolutionErrorOptions): string {
  const requested = options.requestedRepo?.trim();
  if (options.reason === 'no-index' || options.candidates.length === 0) {
    return [
      requested
        ? `Repository "${requested}" is not indexed.`
        : 'No indexed repositories are available.',
      'Run `ontoindex analyze` from the target repository, then retry with `repo: "<label>"` or `repo: "/absolute/path/to/repo"`.',
      ...formatEnvironmentLines(options.environment),
    ].join('\n');
  }

  const header =
    options.reason === 'ambiguous'
      ? requested
        ? `Repository "${requested}" is ambiguous.`
        : 'Multiple repositories are indexed and no repository was selected.'
      : `Repository "${requested ?? '<unspecified>'}" not found.`;
  const retryLabel = options.preferredRetryLabel ?? options.candidates[0]?.label;
  const intendedPath = options.intendedPath ?? path.resolve(options.candidates[0]?.path ?? '.');

  return [
    header,
    'Available:',
    ...options.candidates.slice(0, 12).map((candidate) => `- ${candidate.label} -> ${candidate.path}`),
    ...formatEnvironmentLines(options.environment),
    '',
    'Retry:',
    retryLabel ? `  repo: "${retryLabel}"` : '  repo: "<repo-label-or-absolute-path>"',
    '',
    'To use another project, restart MCP with:',
    `  ontoindex mcp --project ${shellQuote(intendedPath)}`,
    retryLabel ? `  ontoindex mcp --project ${shellQuote(intendedPath)} --repo ${shellQuote(retryLabel)}` : '',
  ].join('\n');
}

export function formatMcpStartupMismatchError(options: McpStartupMismatchErrorOptions): string {
  const selector = options.repoSelector.trim();
  const sourceLabel = options.source === 'cli' ? '--repo' : 'ONTOINDEX_MCP_REPO';
  const restartCommand = `ontoindex mcp --project ${shellQuote(options.projectCwd)} --repo ${shellQuote(selector)}`;
  return [
    `OntoIndex MCP startup blocked: ${sourceLabel} "${selector}" resolves to ${options.resolvedRepo.label} -> ${options.resolvedRepo.path}, but the target project path is ${options.projectCwd}.`,
    `Resolved repo: ${options.resolvedRepo.label} -> ${options.resolvedRepo.path}`,
    `Project cwd: ${options.projectCwd}`,
    `Process cwd: ${options.processCwd}`,
    options.gitRoot ? `Git root: ${options.gitRoot}` : '',
    '',
    'Restart command:',
    `  ${restartCommand}`,
  ].filter(Boolean).join('\n');
}

export function repoResolutionCandidatesFromEntries(
  entries: readonly { name?: string; path: string }[],
): RepoResolutionCandidate[] {
  return entries.map((entry) => ({
    label: entry.name?.trim() || path.basename(path.resolve(entry.path)),
    path: path.resolve(entry.path),
  }));
}

export function repoResolutionEnvironmentFromProcess(): RepoResolutionEnvironment {
  return {
    mcpRepo: process.env.ONTOINDEX_MCP_REPO,
    projectCwd: process.env.ONTOINDEX_MCP_PROJECT_CWD,
    processCwd: process.cwd(),
  };
}

function formatEnvironmentLines(environment: RepoResolutionEnvironment | undefined): string[] {
  if (!environment) return [];
  const lines = [
    '',
    'Current MCP scope:',
    `- ONTOINDEX_MCP_REPO=${environment.mcpRepo ?? '<unset>'}`,
    `- ONTOINDEX_MCP_PROJECT_CWD=${environment.projectCwd ?? '<unset>'}`,
  ];
  if (environment.processCwd) lines.push(`- process.cwd=${environment.processCwd}`);
  return lines;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
