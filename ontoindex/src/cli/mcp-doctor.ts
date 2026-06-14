import { LocalBackend } from '../mcp/local/local-backend.js';
import { shellQuote } from '../mcp/shared/repo-resolution-errors.js';
import { gnDiagnose, type DiagnoseParams, type DiagnoseReport } from '../mcp/super/diagnose.js';

export type McpDoctorVerdict = 'READY' | 'DEGRADED' | 'MISCONFIGURED';

export interface McpDoctorOptions {
  repo?: string;
  projectCwd?: string;
  symbol?: string;
  json?: boolean;
}

export interface McpDoctorReport {
  version: 1;
  verdict: McpDoctorVerdict;
  repoSelector: string;
  projectCwd?: string;
  symbol?: string;
  diagnose: DiagnoseReport;
  symbolSmoke?: {
    status: 'skipped' | 'ok' | 'failed';
    reason?: string;
  };
  nextCommand: string;
}

export interface McpDoctorDeps {
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  diagnose?: (repo: string, params: DiagnoseParams) => Promise<DiagnoseReport>;
  smokeSymbol?: (repo: string, symbol: string) => Promise<void>;
}

export async function createMcpDoctorReport(
  options: McpDoctorOptions = {},
  deps: McpDoctorDeps = {},
): Promise<McpDoctorReport> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd?.() ?? process.cwd();
  const repoSelector =
    options.repo?.trim() ||
    env.ONTOINDEX_MCP_REPO?.trim() ||
    options.projectCwd?.trim() ||
    env.ONTOINDEX_MCP_PROJECT_CWD?.trim() ||
    cwd;
  const diagnose = await (deps.diagnose ?? gnDiagnose)(repoSelector, {
    legacyResponse: true,
    checkLsp: true,
    checkEmbeddings: true,
    checkIndexFreshness: true,
    checkToolContract: true,
  });
  const symbolSmoke = await runSymbolSmoke(
    repoSelector,
    options.symbol,
    options.projectCwd?.trim() || env.ONTOINDEX_MCP_PROJECT_CWD?.trim() || cwd,
    deps.smokeSymbol,
  );
  const verdict = resolveVerdict(diagnose, symbolSmoke);
  const restartPath =
    diagnose.misconfiguration.activeRepoPath ??
    diagnose.targetContext?.repoPath ??
    options.projectCwd ??
    env.ONTOINDEX_MCP_PROJECT_CWD ??
    repoSelector;
  const fallbackRestartCommand =
    options.repo?.trim()
      ? `ontoindex mcp --project ${shellQuote(restartPath)} --repo ${shellQuote(options.repo.trim())}`
      : `ontoindex mcp --project ${shellQuote(restartPath)}`;

  return {
    version: 1,
    verdict,
    repoSelector,
    ...(options.projectCwd ? { projectCwd: options.projectCwd } : {}),
    ...(options.symbol ? { symbol: options.symbol } : {}),
    diagnose,
    symbolSmoke,
    nextCommand: diagnose.misconfiguration.recommendedCommand ?? fallbackRestartCommand,
  };
}

export async function mcpDoctorCommand(options: McpDoctorOptions = {}): Promise<void> {
  const previousProjectCwd = process.env.ONTOINDEX_MCP_PROJECT_CWD;
  if (options.projectCwd?.trim()) {
    process.env.ONTOINDEX_MCP_PROJECT_CWD = options.projectCwd.trim();
  }

  try {
    const report = await createMcpDoctorReport(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatMcpDoctorText(report));
    }
    if (report.verdict === 'MISCONFIGURED') {
      process.exitCode = 1;
    }
  } finally {
    if (previousProjectCwd === undefined) delete process.env.ONTOINDEX_MCP_PROJECT_CWD;
    else process.env.ONTOINDEX_MCP_PROJECT_CWD = previousProjectCwd;
  }
}

export function formatMcpDoctorText(report: McpDoctorReport): string {
  const target = report.diagnose.targetContext;
  const lines = [
    'OntoIndex MCP Doctor',
    `Verdict: ${report.verdict}`,
    `Repo selector: ${report.repoSelector}`,
  ];
  if (target?.repoLabel || target?.repoPath) {
    lines.push(`Resolved repo: ${target.repoLabel ?? target.repoKey ?? '<unknown>'} -> ${target.repoPath ?? '<unknown>'}`);
  }
  if (report.diagnose.misconfiguration.status === 'fail') {
    lines.push(`Misconfiguration: ${report.diagnose.misconfiguration.reason}`);
  }
  if (report.diagnose.degradedContext.reasons.length > 0) {
    lines.push(`Degraded reasons: ${report.diagnose.degradedContext.reasons.join(', ')}`);
  }
  if (report.symbolSmoke?.status === 'failed') {
    lines.push(`Symbol smoke: failed (${report.symbolSmoke.reason ?? 'unknown'})`);
  } else if (report.symbolSmoke?.status === 'ok') {
    lines.push('Symbol smoke: ok');
  }
  lines.push('', 'Next command:', `  ${report.nextCommand}`);
  return lines.join('\n');
}

function resolveVerdict(
  diagnose: DiagnoseReport,
  symbolSmoke: McpDoctorReport['symbolSmoke'],
): McpDoctorVerdict {
  if (diagnose.misconfiguration.status === 'fail') return 'MISCONFIGURED';
  if (diagnose.targetContext && diagnose.targetContext.status !== 'ok') return 'MISCONFIGURED';
  if (symbolSmoke?.status === 'failed') return 'DEGRADED';
  return diagnose.degradedContext.status === 'degraded' ? 'DEGRADED' : 'READY';
}

async function runSymbolSmoke(
  repo: string,
  symbol: string | undefined,
  preferredProjectPath: string,
  smokeSymbol: McpDoctorDeps['smokeSymbol'],
): Promise<McpDoctorReport['symbolSmoke']> {
  const trimmedSymbol = symbol?.trim();
  if (!trimmedSymbol) return { status: 'skipped', reason: 'no-symbol-supplied' };
  try {
    if (smokeSymbol) {
      await smokeSymbol(repo, trimmedSymbol);
      return { status: 'ok' };
    }
    return await runProductionSymbolSmoke(repo, trimmedSymbol, preferredProjectPath);
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

async function runProductionSymbolSmoke(
  repo: string,
  symbol: string,
  preferredProjectPath: string,
): Promise<McpDoctorReport['symbolSmoke']> {
  const backend = new LocalBackend({
    repoFilter: repo,
    preferredProjectPath,
  });
  try {
    const initialized = await backend.init();
    if (!initialized) {
      return { status: 'failed', reason: 'local-backend-init-failed' };
    }

    const contextResult = await backend.callTool('context', {
      repo,
      name: symbol,
      depth: 1,
      limit: 1,
    });
    if (isSmokeFailure('context', contextResult)) {
      return { status: 'failed', reason: describeSmokeFailure('context', contextResult) };
    }

    const impactResult = await backend.callTool('impact', {
      repo,
      target: symbol,
      direction: 'upstream',
      maxDepth: 1,
      includeTests: false,
    });
    if (isSmokeFailure('impact', impactResult)) {
      return { status: 'failed', reason: describeSmokeFailure('impact', impactResult) };
    }

    return { status: 'ok' };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await backend.dispose().catch(() => {});
  }
}

function isSmokeFailure(tool: 'context' | 'impact', result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return true;
  const record = result as Record<string, unknown>;
  if (typeof record.error === 'string' && record.error.trim()) return true;
  if (tool === 'context') {
    return record.status !== 'found' && record.status !== 'ambiguous';
  }
  if (record.status === 'ambiguous') return false;
  return !('target' in record) && !('impactedCount' in record) && !('byDepth' in record);
}

function describeSmokeFailure(tool: 'context' | 'impact', result: unknown): string {
  if (typeof result !== 'object' || result === null) return `${tool}-smoke-invalid-response`;
  const record = result as Record<string, unknown>;
  if (typeof record.error === 'string' && record.error.trim()) {
    return `${tool}-smoke:${record.error}`;
  }
  if (typeof record.status === 'string' && record.status.trim()) {
    return `${tool}-smoke:${record.status}`;
  }
  return `${tool}-smoke-failed`;
}
