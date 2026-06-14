/**
 * MCP Command
 *
 * Starts the MCP server in standalone mode.
 * Default: public MCP tools (super-functions + facade API).
 * --full: direct internal tools (deprecated, one minor version).
 */

import { startMCPServer } from '../mcp/server.js';
import { LocalBackend } from '../mcp/local/local-backend.js';
import {
  formatMcpStartupMismatchError,
  formatRepoResolutionError,
  repoResolutionCandidatesFromEntries,
  repoResolutionEnvironmentFromProcess,
} from '../mcp/shared/repo-resolution-errors.js';
import { getPublicToolDefinitions } from '../mcp/shared/tool-registry.js';
import { INTERNAL_TOOL_HANDLERS } from '../mcp/tools.js';
import { getGitRoot } from '../storage/git.js';
import path from 'path';

const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000;
const MCP_PROJECT_CWD_ENV = 'ONTOINDEX_MCP_PROJECT_CWD';

function getMcpStartupTimeoutMs(): number {
  const raw = Number.parseInt(process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MCP_STARTUP_TIMEOUT_MS;
}

function initBackendWithTimeout(backend: LocalBackend): Promise<boolean> {
  const timeoutMs = getMcpStartupTimeoutMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`OntoIndex MCP startup timed out after ${timeoutMs}ms`);
      err.name = 'AbortError';
      controller.abort(err);
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });

  return Promise.race([backend.init({ signal: controller.signal }), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type RepoFilterSource = 'auto' | 'env' | 'cli';

function resolveRepoFilterSource(options: {
  full?: boolean;
  repo?: string;
  project?: string;
}): RepoFilterSource {
  if (options.repo || options.project) return 'cli';
  return process.env.ONTOINDEX_MCP_REPO ? 'env' : 'auto';
}

function getProjectPathFromCwd(): string {
  const cwd = process.cwd();
  const gitRoot = getGitRoot(cwd);
  return path.resolve(gitRoot || cwd);
}

function resolveConfiguredProjectPath(): string | null {
  const rawProjectCwd = process.env[MCP_PROJECT_CWD_ENV];
  if (!rawProjectCwd) return null;
  const trimmed = rawProjectCwd.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function hasExplicitMismatchOverride(): boolean {
  return process.env.ONTOINDEX_MCP_ALLOW_REPO_MISMATCH === '1';
}

function formatRepoFilterLabel(repoFilter: string | undefined): string {
  if (!repoFilter) return '<all repos>';
  return repoFilter;
}

export const mcpCommand = async (
  options: { full?: boolean; repo?: string; project?: string } = {},
) => {
  process.on('uncaughtException', (err) => {
    console.error(`OntoIndex MCP: uncaught exception — ${err.message}`);
    setTimeout(() => process.exit(1), 100);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`OntoIndex MCP: unhandled rejection — ${msg}`);
  });

  const cwd = path.resolve(process.cwd());
  const inferredProjectPath = getProjectPathFromCwd();
  const explicitProjectPath = options.project?.trim() ? path.resolve(options.project.trim()) : null;
  const configuredProjectPath = resolveConfiguredProjectPath();
  const targetProjectPath = explicitProjectPath ?? inferredProjectPath ?? configuredProjectPath;
  const repoFilter =
    options.repo ?? (explicitProjectPath === null ? process.env.ONTOINDEX_MCP_REPO : undefined);
  const repoFilterSource = resolveRepoFilterSource(options);
  console.error(`OntoIndex: MCP executable cwd: ${cwd}`);
  console.error(`OntoIndex: MCP target project path: ${targetProjectPath}`);
  console.error(`OntoIndex: MCP target repo filter: ${formatRepoFilterLabel(repoFilter)}`);

  const backend = new LocalBackend({
    repoFilter,
    preferredProjectPath: targetProjectPath,
  });
  try {
    await initBackendWithTimeout(backend);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`OntoIndex MCP: backend initialization failed — ${msg}`);
    await backend.dispose();
    process.exitCode = 1;
    return;
  }

  const repos = await backend.listRepos({ refresh: false });
  if (repos.length === 0) {
    if (repoFilter) {
      console.error(
        formatRepoResolutionError({
          reason: 'no-index',
          requestedRepo: repoFilter,
          candidates: [],
          environment: repoResolutionEnvironmentFromProcess(),
          intendedPath: targetProjectPath,
        }),
      );
      await backend.dispose();
      process.exitCode = 1;
      return;
    } else {
      console.error(
        'OntoIndex: No indexed repos yet. Run `ontoindex analyze` in a git repo — the server will pick it up automatically.',
      );
    }
  } else {
    const repoCandidates = repoResolutionCandidatesFromEntries(repos);
    if (repoFilter && repoCandidates.length > 1) {
      const detail = formatRepoResolutionError({
        reason: 'ambiguous',
        requestedRepo: repoFilter,
        candidates: repoCandidates,
        environment: repoResolutionEnvironmentFromProcess(),
        preferredRetryLabel: repoCandidates[0]?.label,
        intendedPath: targetProjectPath,
      });
      if (hasExplicitMismatchOverride()) {
        console.error(
          `OntoIndex WARNING: ${detail} Override enabled via ONTOINDEX_MCP_ALLOW_REPO_MISMATCH=1.`,
        );
      } else {
        console.error(`OntoIndex ERROR: ${detail} Startup blocked.`);
        process.exitCode = 1;
        await backend.dispose();
        return;
      }
    }

    if (repoFilter && repoCandidates.length === 1) {
      const resolvedRepo = repoCandidates[0];
      if (resolvedRepo && resolvedRepo.path !== targetProjectPath) {
        const detail = formatMcpStartupMismatchError({
          source: repoFilterSource === 'cli' ? 'cli' : 'env',
          repoSelector: repoFilter,
          resolvedRepo,
          projectCwd: targetProjectPath,
          processCwd: cwd,
          gitRoot:
            explicitProjectPath === null && inferredProjectPath !== targetProjectPath
              ? inferredProjectPath
              : undefined,
        });
        if (hasExplicitMismatchOverride()) {
          console.error(
            `OntoIndex WARNING: ${detail} Override enabled via ONTOINDEX_MCP_ALLOW_REPO_MISMATCH=1.`,
          );
        } else {
          console.error(`OntoIndex ERROR: ${detail} Startup blocked.`);
          process.exitCode = 1;
          await backend.dispose();
          return;
        }
      }
    }

    console.error(
      `OntoIndex: MCP server starting with ${repos.length} repo(s): ${repos.map((r) => r.name).join(', ')}${repoFilter ? ` (filtered by ${repoFilter})` : ''}`,
    );

    // Warn if no repo has embeddings — semantic search will silently degrade to BM25-only.
    // Check stats.embeddings (written by `ontoindex analyze --embeddings`); 0 or missing means
    // embeddings were never generated.  Warning goes to stderr only — stdout carries MCP JSON-RPC.
    const hasEmbeddings = repos.some((r) => (r.stats?.embeddings ?? 0) > 0);
    if (!hasEmbeddings) {
      process.stderr.write(
        '[ontoindex] WARNING: No embeddings found in index. ' +
          'Semantic search is disabled; only BM25 keyword search is active. ' +
          'Run `ontoindex analyze --embeddings` to enable full hybrid search.\n',
      );
    }
  }

  if (options.full) {
    console.error(
      `OntoIndex: --full mode — exposing ${INTERNAL_TOOL_HANDLERS.length} direct internal tools (DEPRECATED: will be removed in next minor version)`,
    );
  } else {
    console.error(
      `OntoIndex: exposing ${getPublicToolDefinitions().length} public MCP tools (super-functions + facade API)`,
    );
  }

  await startMCPServer(backend, { full: options.full });
};
