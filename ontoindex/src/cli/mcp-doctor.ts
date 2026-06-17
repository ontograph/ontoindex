import { LocalBackend } from '../mcp/local/local-backend.js';
import { shellQuote } from '../mcp/shared/repo-resolution-errors.js';
import { gnDiagnose, type DiagnoseParams, type DiagnoseReport } from '../mcp/super/diagnose.js';
import { execFileText } from '../core/process/exec-file.js';

export type McpDoctorVerdict = 'READY' | 'DEGRADED' | 'MISCONFIGURED';
export type McpDoctorProcessLivenessStatus =
  | 'ok'
  | 'missing'
  | 'mismatch'
  | 'ambiguous'
  | 'unavailable';

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
  processLiveness?: {
    status: McpDoctorProcessLivenessStatus;
    reason?: string;
    pid?: number;
    command?: string;
    projectCwd?: string;
    repairCommand?: string;
  };
  nextCommand: string;
}

export interface McpDoctorDeps {
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  diagnose?: (repo: string, params: DiagnoseParams) => Promise<DiagnoseReport>;
  smokeSymbol?: (repo: string, symbol: string) => Promise<void>;
  processLiveness?: (
    repo: string,
    projectCwd: string,
    repairCommand: string,
  ) => Promise<McpDoctorReport['processLiveness']>;
}

export async function createMcpDoctorReport(
  options: McpDoctorOptions = {},
  deps: McpDoctorDeps = {},
): Promise<McpDoctorReport> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd?.() ?? process.cwd();
  const repoSelector = resolveRepoSelector(options, env, cwd);
  const projectCwd = resolveProjectCwd(options, env, cwd);
  const explicitRepo = options.repo?.trim() || env.ONTOINDEX_MCP_REPO?.trim() || undefined;
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
    projectCwd,
    deps.smokeSymbol,
  );
  const restartPath =
    diagnose.misconfiguration.activeRepoPath ??
    diagnose.targetContext?.repoPath ??
    projectCwd ??
    repoSelector;
  const fallbackRestartCommand = buildRepairCommand(restartPath, explicitRepo);
  const processLiveness = await (deps.processLiveness ?? probeMcpProcessLiveness)(
    repoSelector,
    projectCwd,
    fallbackRestartCommand,
  );
  const verdict = resolveVerdict(diagnose, symbolSmoke, processLiveness);

  return {
    version: 1,
    verdict,
    repoSelector,
    ...(options.projectCwd ? { projectCwd: options.projectCwd } : {}),
    ...(options.symbol ? { symbol: options.symbol } : {}),
    diagnose,
    symbolSmoke,
    ...(processLiveness ? { processLiveness } : {}),
    nextCommand:
      diagnose.misconfiguration.recommendedCommand ??
      processLiveness?.repairCommand ??
      fallbackRestartCommand,
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
    lines.push(
      `Resolved repo: ${target.repoLabel ?? target.repoKey ?? '<unknown>'} -> ${target.repoPath ?? '<unknown>'}`,
    );
  }
  if (report.diagnose.misconfiguration.status === 'fail') {
    lines.push(`Misconfiguration: ${report.diagnose.misconfiguration.reason}`);
  }
  if (report.diagnose.degradedContext.reasons.length > 0) {
    lines.push(`Degraded reasons: ${report.diagnose.degradedContext.reasons.join(', ')}`);
  }
  if (report.diagnose.responseBudgetHealth) {
    const health = report.diagnose.responseBudgetHealth;
    lines.push(`Response guard: ${health.guardLimitBytes} bytes`);
    lines.push(`Guarded preview: ${health.guardedPreviewAvailable ? 'available' : 'unavailable'}`);
    if (health.recentOversizedTools.length > 0) {
      lines.push(`Recent oversized tools: ${health.recentOversizedTools.join(', ')}`);
    }
  }
  if (report.symbolSmoke?.status === 'failed') {
    lines.push(`Symbol smoke: failed (${report.symbolSmoke.reason ?? 'unknown'})`);
  } else if (report.symbolSmoke?.status === 'ok') {
    lines.push('Symbol smoke: ok');
  }
  if (report.processLiveness) {
    const liveness = report.processLiveness;
    if (liveness.status === 'ok') {
      lines.push(`MCP process: ok (PID ${liveness.pid ?? 'unknown'})`);
      if (liveness.command) {
        lines.push(`Process command: ${liveness.command}`);
      }
    } else if (liveness.status === 'mismatch') {
      lines.push(`MCP process: mismatch (${liveness.reason ?? 'wrong project cwd'})`);
      if (liveness.command) {
        lines.push(`Observed command: ${liveness.command}`);
      }
    } else if (liveness.status === 'ambiguous') {
      lines.push(`MCP process: ambiguous (${liveness.reason ?? 'multiple matches'})`);
    } else if (liveness.status === 'missing') {
      lines.push(`MCP process: missing (${liveness.reason ?? 'no matching process found'})`);
    } else {
      lines.push(
        `MCP process: unavailable (${liveness.reason ?? 'process discovery unavailable'})`,
      );
    }
    if (liveness.repairCommand) {
      lines.push(`Process repair: ${liveness.repairCommand}`);
    }
  }
  lines.push('', 'Next command:', `  ${report.nextCommand}`);
  return lines.join('\n');
}

function resolveVerdict(
  diagnose: DiagnoseReport,
  symbolSmoke: McpDoctorReport['symbolSmoke'],
  processLiveness: McpDoctorReport['processLiveness'],
): McpDoctorVerdict {
  if (diagnose.misconfiguration.status === 'fail') return 'MISCONFIGURED';
  if (diagnose.targetContext && diagnose.targetContext.status !== 'ok') return 'MISCONFIGURED';
  if (processLiveness?.status === 'mismatch') return 'MISCONFIGURED';
  if (processLiveness?.status === 'ambiguous' || processLiveness?.status === 'missing') {
    return 'DEGRADED';
  }
  if (symbolSmoke?.status === 'failed') return 'DEGRADED';
  return diagnose.degradedContext.status === 'degraded' ? 'DEGRADED' : 'READY';
}

function resolveRepoSelector(
  options: McpDoctorOptions,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  return (
    options.repo?.trim() ||
    env.ONTOINDEX_MCP_REPO?.trim() ||
    options.projectCwd?.trim() ||
    env.ONTOINDEX_MCP_PROJECT_CWD?.trim() ||
    cwd
  );
}

function resolveProjectCwd(options: McpDoctorOptions, env: NodeJS.ProcessEnv, cwd: string): string {
  return options.projectCwd?.trim() || env.ONTOINDEX_MCP_PROJECT_CWD?.trim() || cwd;
}

function buildRepairCommand(projectCwd: string, repo?: string): string {
  return repo
    ? `ontoindex mcp --project ${shellQuote(projectCwd)} --repo ${shellQuote(repo)}`
    : `ontoindex mcp --project ${shellQuote(projectCwd)}`;
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

async function probeMcpProcessLiveness(
  repoSelector: string,
  projectCwd: string,
  repairCommand: string,
): Promise<McpDoctorReport['processLiveness']> {
  if (process.platform === 'win32') {
    return {
      status: 'unavailable',
      reason: 'process-discovery-unsupported-platform',
      repairCommand,
    };
  }

  try {
    const output = await execFileText('ps', ['-ax', '-o', 'pid=', '-o', 'args='], {
      timeoutMs: 2_000,
      maxBuffer: 64 * 1024,
    });

    const candidates: Array<{
      pid: number;
      command: string;
      projectCwd?: string;
    }> = [];

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!match) continue;

      const pid = Number.parseInt(match[1], 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;

      const command = match[2].trim();
      if (!looksLikeOntoindexMcpCommand(command)) continue;

      candidates.push({
        pid,
        command,
        projectCwd: extractCliOptionValue(command, '--project'),
      });
    }

    const matching = candidates.filter((candidate) =>
      matchesBoundPath(candidate.projectCwd, projectCwd),
    );
    if (matching.length === 1) {
      const match = matching[0];
      return {
        status: 'ok',
        pid: match.pid,
        command: match.command,
        projectCwd: match.projectCwd,
        repairCommand,
      };
    }

    if (matching.length > 1) {
      return {
        status: 'ambiguous',
        reason: `multiple matching MCP processes found for ${projectCwd}`,
        repairCommand,
      };
    }

    if (candidates.length > 0) {
      const observed = candidates[0];
      return {
        status: 'mismatch',
        reason: `found running MCP process for ${observed.projectCwd ?? '<unknown>'}`,
        pid: observed.pid,
        command: observed.command,
        projectCwd: observed.projectCwd,
        repairCommand,
      };
    }

    return {
      status: 'missing',
      reason: `no running MCP process matched ${repoSelector}`,
      repairCommand,
    };
  } catch (err) {
    return {
      status: 'unavailable',
      reason: err instanceof Error ? err.message : String(err),
      repairCommand,
    };
  }
}

function looksLikeOntoindexMcpCommand(command: string): boolean {
  return (
    /(?:^|\s)mcp(?:\s|$)/.test(command) &&
    command.includes('--project') &&
    (command.includes('ontoindex') || command.includes('index.js'))
  );
}

function extractCliOptionValue(command: string, option: string): string | undefined {
  const optionPattern = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = command.match(
    new RegExp(`(?:^|\\s)${optionPattern}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function matchesBoundPath(observed: string | undefined, expected: string): boolean {
  if (!observed) return false;
  const normalizedObserved = observed.replace(/\\/g, '/');
  const normalizedExpected = expected.replace(/\\/g, '/');
  return (
    normalizedObserved === normalizedExpected || normalizedObserved.includes(normalizedExpected)
  );
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
