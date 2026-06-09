/**
 * MCP Command
 *
 * Starts the MCP server in standalone mode.
 * Default: public MCP tools (super-functions + facade API).
 * --full: direct internal tools (deprecated, one minor version).
 */

import { startMCPServer } from '../mcp/server.js';
import { LocalBackend } from '../mcp/local/local-backend.js';
import { getPublicToolDefinitions } from '../mcp/shared/tool-registry.js';
import { INTERNAL_TOOL_HANDLERS } from '../mcp/tools.js';

const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000;

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

export const mcpCommand = async (options: { full?: boolean; repo?: string } = {}) => {
  process.on('uncaughtException', (err) => {
    console.error(`OntoIndex MCP: uncaught exception — ${err.message}`);
    setTimeout(() => process.exit(1), 100);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`OntoIndex MCP: unhandled rejection — ${msg}`);
  });

  const repoFilter = options.repo ?? process.env.ONTOINDEX_MCP_REPO;
  const backend = new LocalBackend({ repoFilter });
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
        `OntoIndex: No indexed repo matches "${repoFilter}". Run \`ontoindex list\` to see registered repos, or run \`ontoindex analyze\` in the target repo.`,
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
