import fs from 'fs/promises';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { LocalBackend } from '../mcp/local/local-backend.js';
import { shellQuote } from '../mcp/shared/repo-resolution-errors.js';
import { gnDiagnose } from '../mcp/super/diagnose.js';
import type { DiagnoseParams, DiagnoseReport } from '../mcp/super/diagnose.js';
import { formatSupportLines } from './status.js';
import { getGitRoot } from '../storage/git.js';

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
    candidates?: Array<{ pid: number; projectCwd?: string }>;
  };
  setupHealth?: {
    status: 'ok' | 'degraded' | 'misconfigured';
    issues: Array<{
      kind: 'stale-hardcoded-repo-path' | 'missing-generated-skill-dir';
      path: string;
      repairCommand: string;
      message: string;
    }>;
  };
  capabilityGaps?: Array<{ reason: string; repairCommand?: string; details?: string[] }>;
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
  spawnPs?: typeof spawn;
  readProcessCwd?: (pid: number) => Promise<string | undefined>;
  setupHealth?: (projectCwd: string) => Promise<McpDoctorReport['setupHealth']>;
}

export async function createMcpDoctorReport(
  options: McpDoctorOptions = {},
  deps: McpDoctorDeps = {},
): Promise<McpDoctorReport> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd?.() ?? process.cwd();
  const needsImplicitCwd = !options.projectCwd?.trim() && !env.ONTOINDEX_MCP_PROJECT_CWD?.trim();
  const implicitCwd = needsImplicitCwd ? (getGitRoot(cwd) ?? cwd) : undefined;
  const repoSelector = resolveRepoSelector(options, env, implicitCwd ?? cwd);
  const projectCwd = resolveProjectCwd(options, env, implicitCwd ?? cwd);
  const explicitRepo = options.repo?.trim() || undefined;
  let diagnose = await (deps.diagnose ?? gnDiagnose)(repoSelector, {
    legacyResponse: true,
    checkLsp: true,
    checkEmbeddings: true,
    checkIndexFreshness: true,
    checkToolContract: true,
  });
  const selectorIsImplicit = !options.repo?.trim() && needsImplicitCwd;
  const noTargetRepo = selectorIsImplicit && diagnose.targetContext?.status === 'not-found';
  if (noTargetRepo) {
    const mismatchCommand = diagnose.misconfiguration.recommendedCommand;
    diagnose = {
      ...diagnose,
      misconfiguration: { status: 'ok' },
      degradedContext: {
        ...diagnose.degradedContext,
        status: 'degraded',
        confidence: 'reduced',
        reasons: [
          ...diagnose.degradedContext.reasons.filter(
            (reason) =>
              reason !== 'mcp-service-target-mismatch' && reason !== 'target-context-not-found',
          ),
          'no-target-repo',
        ],
      },
      recommendations: diagnose.recommendations.filter(
        (recommendation) => recommendation.fix !== mismatchCommand,
      ),
    };
  }
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
  const processLiveness = deps.processLiveness
    ? await deps.processLiveness(repoSelector, projectCwd, fallbackRestartCommand)
    : await probeMcpProcessLiveness(repoSelector, projectCwd, fallbackRestartCommand, deps);
  const setupHealth = await (deps.setupHealth ?? probeSetupHealth)(projectCwd);
  const capabilityGaps: NonNullable<McpDoctorReport['capabilityGaps']> =
    diagnose.degradedContext.reasons
      .filter(
        (reason) =>
          reason === 'embeddings-unavailable' ||
          reason === 'embeddings-missing' ||
          reason.endsWith('-lsp-missing'),
      )
      .map((reason) => ({
        reason,
        ...(reason.startsWith('embeddings-')
          ? {
              details: [
                `ONTOINDEX_EMBEDDING_URL: ${env.ONTOINDEX_EMBEDDING_URL ? 'set' : 'unset'}`,
                `ONTOINDEX_EMBEDDING_MODEL: ${env.ONTOINDEX_EMBEDDING_MODEL ? 'set' : 'unset'}`,
                'Vectors appear after ontoindex analyze --embeddings',
              ],
            }
          : {}),
        ...(reason.startsWith('embeddings-') && diagnose.embeddings?.repairCommand
          ? { repairCommand: diagnose.embeddings.repairCommand }
          : {}),
      }));
  if (noTargetRepo) {
    const registeredRepos = diagnose.targetContext?.availableRepos
      ?.slice(0, 5)
      .map((repo) => repo.key);
    capabilityGaps.push({
      reason: 'no-target-repo',
      details: [
        'current directory is not an indexed repository; run from an indexed repo or pass --repo <name|path>',
        ...(registeredRepos?.length
          ? [`Registered repositories: ${registeredRepos.join(', ')}`]
          : []),
      ],
    });
  }
  if (
    diagnose.degradedContext.reasons.includes('runtime-warnings') &&
    diagnose.warnings.every(isInformationalRuntimeWarning)
  ) {
    capabilityGaps.push({
      reason: 'runtime-warnings',
      details: summarizeRuntimeWarnings(diagnose.warnings),
    });
  }
  const verdict = resolveVerdict(
    diagnose,
    symbolSmoke,
    processLiveness,
    setupHealth,
    capabilityGaps,
  );

  return {
    version: 1,
    verdict,
    repoSelector,
    ...(options.projectCwd ? { projectCwd: options.projectCwd } : {}),
    ...(options.symbol ? { symbol: options.symbol } : {}),
    diagnose,
    symbolSmoke,
    ...(processLiveness ? { processLiveness } : {}),
    ...(setupHealth && setupHealth.status !== 'ok' ? { setupHealth } : {}),
    ...(capabilityGaps.length > 0 ? { capabilityGaps } : {}),
    nextCommand: noTargetRepo
      ? 'ontoindex mcp-doctor --repo <name>'
      : (diagnose.misconfiguration.recommendedCommand ??
        processLiveness?.repairCommand ??
        setupHealth?.issues[0]?.repairCommand ??
        fallbackRestartCommand),
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
  const runtime = report.diagnose.runtimeContextSummary;
  const lines = [
    'OntoIndex MCP Doctor',
    `Verdict: ${report.verdict}`,
    `Repo selector: ${report.repoSelector}`,
  ];
  if (target?.repoLabel || target?.repoPath) {
    lines.push(
      `Resolved repo: ${target.repoLabel ?? target.repoKey ?? '<unknown>'} -> ${
        target.repoPath ?? '<unknown>'
      }`,
    );
  }
  if (runtime) {
    lines.push(`Freshness: ${runtime.freshness}`);
    if (runtime.scopeConfidence) {
      lines.push(`Scope confidence: ${runtime.scopeConfidence}`);
    }
    if (runtime.dirtyWorktree !== null) {
      lines.push(
        `Dirty worktree: ${
          runtime.dirtyWorktree
            ? `yes${runtime.dirtyFileCount !== null ? `, ${runtime.dirtyFileCount} files changed` : ''}`
            : 'no'
        }`,
      );
    }
    lines.push(`Embeddings: ${runtime.embeddings}`);
  }
  if (report.diagnose.misconfiguration.status === 'fail') {
    lines.push(`Misconfiguration: ${report.diagnose.misconfiguration.reason}`);
  }
  if (report.diagnose.degradedContext.reasons.length > 0) {
    const requiredReasons = report.diagnose.degradedContext.reasons.filter(
      (reason) => !isOptionalCapabilityGap(reason),
    );
    if (requiredReasons.length > 0) lines.push(`Degraded reasons: ${requiredReasons.join(', ')}`);
  }
  if (report.capabilityGaps && report.capabilityGaps.length > 0) {
    lines.push('Optional capabilities:');
    for (const gap of report.capabilityGaps) {
      lines.push(`- ${gap.reason}${gap.repairCommand ? ` (repair: ${gap.repairCommand})` : ''}`);
      for (const detail of gap.details ?? []) lines.push(`  - ${detail}`);
    }
  }
  if (report.diagnose.auditFreshness) {
    const audit = report.diagnose.auditFreshness;
    if (audit.status === 'stale') {
      const tgt = audit.targetHead ? audit.targetHead.slice(0, 12) : 'unknown';
      const cur = audit.currentHead ? audit.currentHead.slice(0, 12) : 'unknown';
      lines.push(`Audit freshness: stale (target ${tgt} vs current ${cur})`);
    } else {
      lines.push(`Audit freshness: ${audit.status}`);
    }
    if (audit.repairCommand && audit.status !== 'clean') {
      lines.push(`Audit repair: ${audit.repairCommand}`);
    }
  }
  if (report.diagnose.mcpResourceBridge) {
    const bridge = report.diagnose.mcpResourceBridge;
    lines.push(
      `MCP resource bridge: ${bridge.exposed ? `exposed (${bridge.exposedTo.join(', ')})` : 'not exposed'}`,
    );
  }
  if (report.diagnose.responseBudgetHealth) {
    const health = report.diagnose.responseBudgetHealth;
    lines.push(`Response guard: ${health.guardLimitBytes} bytes`);
    lines.push(`Guarded preview: ${health.guardedPreviewAvailable ? 'available' : 'unavailable'}`);
    if (health.recentOversizedTools.length > 0) {
      lines.push(`Recent oversized tools: ${health.recentOversizedTools.join(', ')}`);
    }
  }
  lines.push(...formatSupportLines(report.diagnose));
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
      for (const candidate of liveness.candidates ?? []) {
        lines.push(`Candidate: PID ${candidate.pid} -> ${candidate.projectCwd ?? '<unverified>'}`);
      }
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
  if (report.setupHealth && report.setupHealth.status !== 'ok') {
    const setup = report.setupHealth;
    lines.push(`Setup: ${setup.status}`);
    for (const issue of setup.issues) {
      lines.push(`Setup issue: ${issue.message}`);
      lines.push(`Setup repair: ${issue.repairCommand}`);
    }
  }
  lines.push('', 'Next command:', `  ${report.nextCommand}`);
  return lines.join('\n');
}

function resolveVerdict(
  diagnose: DiagnoseReport,
  symbolSmoke: McpDoctorReport['symbolSmoke'],
  processLiveness: McpDoctorReport['processLiveness'],
  setupHealth?: McpDoctorReport['setupHealth'],
  capabilityGaps: McpDoctorReport['capabilityGaps'] = [],
): McpDoctorVerdict {
  if (diagnose.misconfiguration.status === 'fail') return 'MISCONFIGURED';
  if (
    diagnose.targetContext &&
    diagnose.targetContext.status !== 'ok' &&
    !diagnose.degradedContext.reasons.includes('no-target-repo')
  )
    return 'MISCONFIGURED';
  if (processLiveness?.status === 'mismatch') return 'MISCONFIGURED';
  if (setupHealth?.status === 'misconfigured') return 'MISCONFIGURED';
  if (processLiveness?.status === 'ambiguous' || processLiveness?.status === 'missing') {
    return 'DEGRADED';
  }
  if (processLiveness?.status === 'unavailable') {
    return 'DEGRADED';
  }
  if (symbolSmoke?.status === 'failed') return 'DEGRADED';
  if (setupHealth?.status === 'degraded') return 'DEGRADED';
  return diagnose.degradedContext.reasons.some((reason) => !isOptionalCapabilityGap(reason))
    ? 'DEGRADED'
    : capabilityGaps.length > 0 || diagnose.degradedContext.status === 'ok'
      ? 'READY'
      : 'DEGRADED';
}

function isOptionalCapabilityGap(reason: string): boolean {
  return (
    reason === 'embeddings-unavailable' ||
    reason === 'embeddings-missing' ||
    reason.endsWith('-lsp-missing') ||
    reason === 'runtime-warnings'
  );
}

function isInformationalRuntimeWarning(warning: string): boolean {
  return [
    /untracked files are absent from the graph/i,
    /tracked changes are indexed at the indexed commit/i,
    /dirty worktree/i,
    /no embeddings/i,
  ].some((pattern) => pattern.test(warning));
}

function summarizeRuntimeWarnings(warnings: string[]): string[] {
  const unique = [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))];
  const details = unique
    .slice(0, 5)
    .map((warning) => (warning.length > 200 ? `${warning.slice(0, 199)}…` : warning));
  if (unique.length > 5) details.push(`+${unique.length - 5} more`);
  return details;
}

function resolveRepoSelector(
  options: McpDoctorOptions,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  return (
    options.repo?.trim() ||
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
  deps: McpDoctorDeps = {},
): Promise<McpDoctorReport['processLiveness']> {
  if (process.platform === 'win32') {
    return {
      status: 'unavailable',
      reason: 'process-discovery-unsupported-platform',
      repairCommand,
    };
  }

  try {
    const candidates: Array<{
      pid: number;
      command: string;
      projectCwd?: string;
      cwdBound?: boolean;
    }> = [];
    const child =
      deps.spawnPs?.('ps', ['-ax', '-o', 'pid=', '-o', 'args='], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }) ??
      spawn('ps', ['-ax', '-o', 'pid=', '-o', 'args='], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    const candidateLimit = 256;
    let enumerationCapped = false;
    const lineLimit = 16 * 1024;
    await new Promise<void>((resolve, reject) => {
      let pending = '';
      let oversized = false;
      let settled = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('ps process timed out'));
      }, 2_000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const consumeLine = (line: string) => {
        if (settled) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        const match = trimmed.match(/^(\d+)\s+(.*)$/);
        if (!match) return;

        const pid = Number.parseInt(match[1], 10);
        if (!Number.isFinite(pid) || pid <= 0) return;

        const command = match[2].trim();
        if (!looksLikeOntoindexMcpCommand(command)) return;

        const projectCwd = extractCliOptionValue(command, '--project');
        candidates.push(
          projectCwd && !hasUnambiguousProjectArgument(command)
            ? { pid, command }
            : { pid, command, projectCwd },
        );
        if (candidates.length >= candidateLimit) {
          enumerationCapped = true;
          child.kill('SIGKILL');
          finish();
        }
      };
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        for (const part of String(chunk).split(/(?<=\n)/)) {
          const hasNewline = part.endsWith('\n');
          if (oversized) {
            if (hasNewline) oversized = false;
            continue;
          }
          const line = pending + part.replace(/\n$/, '');
          pending = '';
          if (line.length > lineLimit) {
            oversized = !hasNewline;
            continue;
          }
          if (hasNewline) consumeLine(line);
          else pending = line;
        }
      });
      child.stderr?.on('data', () => {});
      child.once('error', (error: Error) => finish(error));
      child.once('close', (code: number | null) => {
        if (pending && !oversized) consumeLine(pending);
        finish(
          code === 0 || candidates.length >= candidateLimit
            ? undefined
            : new Error(`ps exited with code ${code}`),
        );
      });
    });

    if (process.platform === 'linux') {
      for (const candidate of candidates) {
        if (candidate.projectCwd) continue;
        try {
          const cwd = await (deps.readProcessCwd ?? readProcessCwd)(candidate.pid);
          if (!cwd) continue;
          candidate.projectCwd = getGitRoot(cwd) ?? path.resolve(cwd);
          candidate.cwdBound = true;
        } catch {
          // Process cwd can disappear or be inaccessible; keep it unbound.
        }
      }
    }

    const matching = candidates.filter((candidate) =>
      matchesBoundPath(candidate.projectCwd, projectCwd),
    );
    if (enumerationCapped) {
      return {
        status: 'ambiguous',
        reason: `MCP process enumeration capped at ${candidateLimit}; target binding cannot be established for ${projectCwd}`,
        candidates: candidates.slice(0, 5).map(({ pid, projectCwd }) => ({ pid, projectCwd })),
        repairCommand,
      };
    }
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
      const explicitMatches = matching.filter((candidate) => !candidate.cwdBound);
      const cwdBoundMatches = matching.length - explicitMatches.length;
      if (explicitMatches.length === 0 && cwdBoundMatches !== matching.length) {
        return {
          status: 'ambiguous',
          reason: `multiple matching MCP processes found for ${projectCwd}`,
          repairCommand,
        };
      }
      // Multiple servers can be bound to one project; prefer an explicit target binding.
      const match = explicitMatches[0] ?? matching[0];
      return {
        status: 'ok',
        reason: `${matching.length} servers bound to ${projectCwd} (${explicitMatches.length} by explicit --project, ${cwdBoundMatches} by working directory)`,
        pid: match.pid,
        command: match.command,
        projectCwd: match.projectCwd,
        repairCommand,
      };
    }

    if (candidates.some((candidate) => !isAbsolutePath(candidate.projectCwd))) {
      return {
        status: 'unavailable',
        reason: 'process-project-binding-unverified',
        repairCommand,
      };
    }

    if (candidates.length > 1) {
      return {
        status: 'ambiguous',
        reason: `${candidates.length} running MCP processes, none bound to ${projectCwd}`,
        candidates: candidates.slice(0, 5).map(({ pid, projectCwd }) => ({ pid, projectCwd })),
        repairCommand,
      };
    }

    if (candidates.length === 1) {
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

async function readProcessCwd(pid: number): Promise<string | undefined> {
  try {
    return await fs.readlink(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

async function probeSetupHealth(projectCwd: string): Promise<McpDoctorReport['setupHealth']> {
  const issues: NonNullable<McpDoctorReport['setupHealth']>['issues'] = [];
  const normalizedProjectCwd = normalizePath(projectCwd);
  const repairCommand = 'ontoindex setup';

  const configFiles = [
    path.join(projectCwd, '.claude', 'settings.local.json'),
    path.join(projectCwd, 'ontoindex', '.claude', 'settings.local.json'),
  ];

  for (const filePath of configFiles) {
    const raw = await readTextIfExists(filePath);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const staleMentions = findStaleRepoPaths(parsed, normalizedProjectCwd);
    if (staleMentions.length === 0) continue;
    issues.push({
      kind: 'stale-hardcoded-repo-path',
      path: filePath,
      repairCommand,
      message: `${relativeOrAbsolute(
        projectCwd,
        filePath,
      )} contains stale repo path(s): ${staleMentions.join(', ')}`,
    });
  }

  const skillChecks = [
    {
      root: path.join(os.homedir(), '.claude'),
      skillDir: path.join(os.homedir(), '.claude', 'skills'),
    },
    {
      root: path.join(os.homedir(), '.codex'),
      skillDir: path.join(os.homedir(), '.agents', 'skills'),
      usageFiles: [
        path.join(os.homedir(), '.codex', 'config.toml'),
        path.join(os.homedir(), '.codex', 'hooks.json'),
      ],
    },
    {
      root: path.join(os.homedir(), '.cursor'),
      skillDir: path.join(os.homedir(), '.cursor', 'skills'),
    },
    {
      root: path.join(os.homedir(), '.config', 'opencode'),
      skillDir: path.join(os.homedir(), '.config', 'opencode', 'skill'),
    },
  ];

  for (const { root, skillDir, usageFiles } of skillChecks) {
    if (!(await dirExists(root))) continue;
    if (usageFiles && !(await Promise.all(usageFiles.map(fileExists))).some(Boolean)) continue;
    if (await dirExists(skillDir)) continue;
    issues.push({
      kind: 'missing-generated-skill-dir',
      path: skillDir,
      repairCommand,
      message: `missing generated skill directory: ${skillDir}`,
    });
  }

  if (issues.length === 0) return { status: 'ok', issues };
  return {
    status: issues.some((issue) => issue.kind === 'stale-hardcoded-repo-path')
      ? 'misconfigured'
      : 'degraded',
    issues,
  };
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function findStaleRepoPaths(parsed: unknown, normalizedProjectCwd: string): string[] {
  const stale = new Set<string>();
  const inspectCommand = (command: string) => {
    const cd = command
      .match(/(?:^|\s)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/)
      ?.slice(1)
      .find(Boolean);
    for (const candidate of [
      extractCliOptionValue(command, '-C'),
      extractCliOptionValue(command, '--project'),
      extractCliOptionValue(command, '--repo'),
      cd,
    ]) {
      if (!candidate) continue;
      const target = normalizePath(path.resolve(candidate));
      const root = normalizePath(path.resolve(normalizedProjectCwd)).replace(/\/$/, '');
      if (target !== root && !target.startsWith(`${root}/`)) stale.add(candidate);
    }
  };
  const visit = (value: unknown, key = ''): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
      return;
    }
    if (typeof value !== 'string') return;
    if (['allow', 'deny', 'ask'].includes(key) && value.startsWith('Bash('))
      inspectCommand(value.slice(5, -1));
    if (/hook|command/i.test(key)) inspectCommand(value);
  };
  visit(parsed);
  return [...stale];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function relativeOrAbsolute(baseDir: string, targetPath: string): string {
  const relative = path.relative(baseDir, targetPath);
  return normalizePath(relative.startsWith('..') ? targetPath : relative || '.');
}

function looksLikeOntoindexMcpCommand(command: string): boolean {
  return (
    /(?:^|\s)mcp(?:\s|$)/.test(command) &&
    (/(?:^|[\s/\\])ontoindex(?:\s|$)/.test(command) ||
      /(?:^|[\s/\\])ontoindex(?:[\\/]ontoindex)?[\\/]dist[\\/]cli[\\/]index\.js(?:\s|$)/.test(
        command,
      ))
  );
}

function extractCliOptionValue(command: string, option: string): string | undefined {
  const optionPattern = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = command.match(
    new RegExp(`(?:^|\\s)${optionPattern}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function hasUnambiguousProjectArgument(command: string): boolean {
  const optionPattern = /(?:^|\s)--project(?:=|\s+)/g;
  const match = optionPattern.exec(command);
  if (!match) return true;
  const valueStart = match.index + match[0].length;
  const valueMatch = command.slice(valueStart).match(/^(?:"[^"]+"|'[^']+'|[^\s]+)/);
  if (!valueMatch) return false;
  return /^\s*(?:--\S.*)?$/.test(command.slice(valueStart + valueMatch[0].length));
}

function matchesBoundPath(observed: string | undefined, expected: string): boolean {
  if (!isAbsolutePath(observed) || !isAbsolutePath(expected)) return false;
  const normalizedObserved = path.resolve(observed);
  const normalizedExpected = path.resolve(expected);
  return process.platform === 'win32'
    ? normalizedObserved.toLowerCase() === normalizedExpected.toLowerCase()
    : normalizedObserved === normalizedExpected;
}

function isAbsolutePath(value: string | undefined): value is string {
  return !!value && path.isAbsolute(value);
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
