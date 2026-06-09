import { writeSync } from 'node:fs';
import { getGitRoot } from '../storage/git.js';
import { loadAnalysisCatalog } from '../analysis-packs/catalog.js';
import { buildAnalysisExecutionPlan } from '../analysis-packs/execution.js';
import { LocalBackend } from '../mcp/local/local-backend.js';

let backend: LocalBackend | null = null;

interface PackRunResult {
  step: string;
  tool: string;
  status: 'success' | 'error';
  result?: unknown;
  error?: unknown;
}

function toOutputText(data: unknown): string {
  if (typeof data === 'string') return data;
  const serialized = JSON.stringify(data, null, 2);
  return serialized === undefined ? 'undefined' : serialized;
}

function hasErrnoCode(error: unknown): error is { code?: unknown } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return hasErrnoCode(error) && error.code === code;
}

function thrownMessage(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('message' in error)) {
    return undefined;
  }
  return error.message;
}

function output(data: unknown): void {
  const text = toOutputText(data);
  try {
    writeSync(1, text + '\n');
  } catch (err: unknown) {
    if (isErrnoCode(err, 'EPIPE')) process.exit(0);
    process.stderr.write(text + '\n');
  }
}

function resolveRepoPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) {
    return explicitPath;
  }
  return getGitRoot(process.cwd()) ?? process.cwd();
}

function hasToolError(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    Boolean((result as { error?: unknown }).error)
  );
}

async function getBackend(): Promise<LocalBackend> {
  if (backend) return backend;
  backend = new LocalBackend();
  const ok = await backend.init();
  if (!ok) {
    console.error('OntoIndex: No indexed repositories found. Run: ontoindex analyze');
    process.exit(1);
  }
  return backend;
}

export async function listPacksCommand(options?: {
  path?: string;
  kind?: 'library' | 'query' | 'model';
  tier?: 'stable' | 'experimental';
  json?: boolean;
}): Promise<void> {
  const repoPath = resolveRepoPath(options?.path);
  const catalog = await loadAnalysisCatalog(repoPath);
  const packs = catalog.packs.filter((pack) => {
    if (options?.kind && pack.kind !== options.kind) return false;
    if (options?.tier && pack.tier !== options.tier) return false;
    return true;
  });

  if (options?.json) {
    output({
      repoPath,
      packs,
      suites: catalog.suites,
      errors: catalog.errors,
    });
    return;
  }

  const lines = [
    `Repo: ${repoPath}`,
    `Packs: ${packs.length}`,
    `Suites: ${catalog.suites.length}`,
    '',
  ];
  for (const pack of packs) {
    lines.push(`${pack.id}  [${pack.kind}/${pack.tier}]`);
    lines.push(`  ${pack.summary}`);
    if (pack.runs.length > 0) {
      lines.push(`  runs: ${pack.runs.map((run) => run.tool).join(', ')}`);
    }
  }
  if (catalog.errors.length > 0) {
    lines.push('');
    lines.push(`Manifest errors: ${catalog.errors.length}`);
  }
  output(lines.join('\n'));
}

export async function describePackCommand(
  id: string,
  options?: { path?: string; json?: boolean },
): Promise<void> {
  const repoPath = resolveRepoPath(options?.path);
  const plan = await buildAnalysisExecutionPlan(repoPath, id);
  if (options?.json) {
    output(plan);
    return;
  }

  const lines = [
    `${plan.target.type}: ${plan.target.id}`,
    `${plan.target.name}`,
    `packs: ${plan.packs.length}`,
    `steps: ${plan.steps.length}`,
    `model packs: ${plan.modelPacks.length}`,
    '',
  ];
  for (const pack of plan.packs) {
    lines.push(`${pack.id}  [${pack.kind}/${pack.tier}]`);
    lines.push(`  ${pack.summary}`);
    if (pack.runs.length > 0) {
      lines.push(`  runs: ${pack.runs.map((run) => run.tool).join(', ')}`);
    }
  }
  if (plan.steps.length > 0) {
    lines.push('');
    lines.push('Execution plan:');
    for (const step of plan.steps) {
      lines.push(`  - ${step.packId} -> ${step.tool}`);
    }
  }
  if (plan.modelPacks.length > 0) {
    lines.push('');
    lines.push('Model packs:');
    for (const pack of plan.modelPacks) {
      lines.push(`  - ${pack.id} (${pack.provides.join(', ')})`);
    }
  }
  output(lines.join('\n'));
}

export async function runPackCommand(
  id: string,
  options?: { path?: string; repo?: string; failFast?: boolean; json?: boolean },
): Promise<void> {
  const repoPath = resolveRepoPath(options?.path);
  const plan = await buildAnalysisExecutionPlan(repoPath, id);
  const executor = await getBackend();

  const results: PackRunResult[] = [];

  for (const step of plan.steps) {
    try {
      const result = await executor.callTool(step.tool, {
        ...step.params,
        ...(options?.repo ? { repo: options.repo } : {}),
      });
      results.push({ step: step.packId, tool: step.tool, status: 'success', result });
      if (hasToolError(result) && options?.failFast) {
        break;
      }
    } catch (err: unknown) {
      results.push({
        step: step.packId,
        tool: step.tool,
        status: 'error',
        error: thrownMessage(err),
      });
      if (options?.failFast) break;
    }
  }

  const payload = {
    target: plan.target,
    steps: plan.steps,
    modelPacks: plan.modelPacks.map((pack) => ({
      id: pack.id,
      provides: pack.provides,
      tier: pack.tier,
    })),
    results,
  };

  if (options?.json) {
    output(payload);
    return;
  }

  const lines = [
    `Ran ${plan.target.type} ${plan.target.id}`,
    `steps: ${plan.steps.length}`,
    `model packs: ${plan.modelPacks.length}`,
    '',
  ];
  for (const result of results) {
    lines.push(`- ${result.step} -> ${result.tool}: ${result.status}`);
  }
  output(lines.join('\n'));
}
