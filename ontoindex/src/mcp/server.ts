import { isAutomaticWorkspaceEnabled } from './local/backend-overlay.js';
/**
 * MCP Server (Multi-Repo)
 *
 * Model Context Protocol server that runs on stdio.
 * External AI tools (Cursor, Claude) spawn this process and
 * communicate via stdin/stdout using the MCP protocol.
 *
 * Supports multiple indexed repositories via the global registry.
 *
 * Tools: list_repos, query, cypher, context, impact, detect_changes, rename
 * Resources: repos, repo/{name}/context, repo/{name}/clusters, ...
 */

import { findOversizedArgument } from './shared/arg-limits.js';
import { createIdleTracker, resolveIdleExitMs } from './shared/idle-exit.js';
import { openPoolCount } from '../core/lbug/pool-adapter.js';
import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { CompatibleStdioServerTransport } from './compatible-stdio-transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { INTERNAL_TOOL_HANDLERS } from './tools.js';
import { dispatchFacade, type FacadeTool } from './facade/dispatch.js';
import { attachRepoScopeIdentity } from './shared/response-envelope.js';
import { isMarkedInvocationError } from './shared/invocation-error.js';
import { SUPER_NAMES, withPreparedSuperRead, type SuperTool } from './super/names.js';
import {
  getMcpStartupProfileFromEnv,
  getPublicToolDefinitions,
  isRepoOptionalSuperToolName,
} from './shared/tool-registry.js';
import { realStdoutWrite } from './core/lbug-adapter.js';
import type { LocalBackend } from './local/local-backend.js';
import {
  getResourceDefinitions,
  getResourceTemplates,
  parseResourceUri,
  readResource,
} from './resources.js';
import {
  boundMcpErrorText,
  MCP_RESPONSE_MAX_BYTES,
  pageMcpResponse,
  validateResponseBudget,
} from './shared/response-pages.js';

const MAX_PROMPT_ARGUMENT_BYTES = 4096;

// Explicit because the registry labels discover (sync writes group files) and gn_ensure_fresh (autoAnalyze starts a job) read_only; docs is omitted because it persists a sidecar manifest.
const READ_ONLY_TOOL_NAMES = new Set([
  'search',
  'inspect',
  'impact',
  'gn_help',
  'gn_tool_contract',
  'gn_explore',
  'gn_find_related',
  'gn_explain_module',
]);

export function getMcpShutdownGraceMs(): number {
  const raw = Number.parseInt(process.env.ONTOINDEX_MCP_SHUTDOWN_GRACE_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 100 && raw <= 60_000 ? raw : 5000;
}

/** Bound cleanup without changing the backend's disposal contract. Resolves false when the grace expired. */
export async function withShutdownGrace(
  cleanup: Promise<unknown>,
  graceMs = getMcpShutdownGraceMs(),
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cleanup.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          process.stderr.write('[ontoindex:mcp] shutdown grace expired; forcing exit\n');
          resolve(false);
        }, graceMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface StackLike {
  stack?: unknown;
}

function hasStack(value: unknown): value is StackLike {
  return (
    (typeof value === 'object' || typeof value === 'function') && value !== null && 'stack' in value
  );
}

function formatUnhandledRejectionReason(reason: unknown): string {
  if (hasStack(reason) && reason.stack) {
    return String(reason.stack);
  }
  return String(reason);
}

interface RepoIdentity {
  repoLabel: string;
  repoPath: string;
}

function readRepoIdentity(value: unknown): RepoIdentity | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const repoLabel = typeof candidate.repoLabel === 'string' ? candidate.repoLabel : undefined;
  const repoPath = typeof candidate.repoPath === 'string' ? candidate.repoPath : undefined;
  return repoLabel && repoPath ? { repoLabel, repoPath } : null;
}

function formatToolCallErrorMessage(
  error: unknown,
  repo?: RepoIdentity | null,
  committedFallbackAvailable = false,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const candidate =
    error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  const code =
    typeof candidate?.code === 'string' &&
    [
      'workspace_busy',
      'workspace_build_failed',
      'workspace_too_large',
      'workspace_timeout',
      'workspace_cancelled',
    ].includes(candidate.code)
      ? candidate.code
      : undefined;
  const diagnostic = candidate?.diagnostics as Record<string, unknown> | undefined;
  const failureDiagnostic = diagnostic;
  const phases = ['planning', 'lock', 'recheck', 'build', 'release', 'verification'];
  const reasons = [
    'planning_failed',
    'lock_failed',
    'snapshot_failed',
    'inputs_changed',
    'build_failed',
    'timeout',
    'cancelled',
    'unstoppable',
    'release_failed',
    'capability_missing',
    'generation_unreadable',
    'input_refused',
    'coverage_degraded',
  ];
  const systemCodes = ['EACCES', 'EPERM', 'ENOSPC', 'ENOENT', 'EMFILE', 'ENFILE', 'EIO', 'EROFS'];
  const diagnostics =
    code === 'workspace_too_large' &&
    diagnostic &&
    typeof diagnostic === 'object' &&
    Number.isSafeInteger(diagnostic.observedIndexedFiles) &&
    (diagnostic.observedIndexedFiles as number) >= 0 &&
    Number.isSafeInteger(diagnostic.maxIndexedFiles) &&
    (diagnostic.maxIndexedFiles as number) > 0 &&
    diagnostic.requiredCapability === 'workspace-graph'
      ? {
          observedIndexedFiles: diagnostic.observedIndexedFiles,
          maxIndexedFiles: diagnostic.maxIndexedFiles,
          requiredCapability: 'workspace-graph',
        }
      : undefined;
  const failure =
    code === 'workspace_build_failed' &&
    failureDiagnostic &&
    typeof failureDiagnostic === 'object' &&
    phases.includes(failureDiagnostic.phase as string) &&
    reasons.includes(failureDiagnostic.reason as string)
      ? {
          phase: failureDiagnostic.phase,
          reason: failureDiagnostic.reason,
          ...(systemCodes.includes(failureDiagnostic.systemCode as string)
            ? { systemCode: failureDiagnostic.systemCode }
            : {}),
        }
      : undefined;
  const safeDiagnostics = diagnostics || failure ? { ...diagnostics, ...failure } : undefined;
  return boundMcpErrorText(
    (boundedMessage) =>
      repo || code
        ? JSON.stringify(
            {
              error: boundedMessage,
              ...(repo ? { repoLabel: repo.repoLabel, repoPath: repo.repoPath } : {}),
              ...(code ? { code } : {}),
              ...(safeDiagnostics ? { diagnostics: safeDiagnostics } : {}),
              ...(committedFallbackAvailable &&
              (code === 'workspace_too_large' || code === 'workspace_build_failed')
                ? {
                    remediation: {
                      read_mode: 'committed',
                      message:
                        'Explicitly set read_mode="committed" to query the indexed commit. Uncommitted source changes, manual overlays and live enrichment are excluded. Do not automatically retry or reindex.' +
                        (code === 'workspace_too_large'
                          ? ' To prepare a separate bounded workspace graph while preserving the committed index, explicitly run `ONTOINDEX_AUTO_WORKSPACE=1 ontoindex analyze --workspace-graph` in the repository. Rerun this command after workspace inputs change.'
                          : '') +
                        (failure?.reason === 'input_refused'
                          ? ' The working tree contains an input the workspace capture refuses, such as a tracked symlink or a file over the scan cap; exclude it with .ontoindexignore where allowed or run ontoindex analyze.'
                          : '') +
                        (failure?.reason === 'coverage_degraded'
                          ? ' The published workspace graph reports degraded coverage. Inspect the analysis diagnostics and correct the reported issues before explicitly rebuilding.'
                          : ''),
                    },
                  }
                : {}),
              ...(code && typeof candidate?.retryable === 'boolean'
                ? { retryable: candidate.retryable }
                : {}),
            },
            null,
            2,
          )
        : `Error: ${boundedMessage}`,
    message,
  );
}

/**
 * Next-step hints appended to tool responses.
 *
 * Agents often stop after one tool call. These hints guide them to the
 * logical next action, creating a self-guiding workflow without hooks.
 *
 * Design: Each hint is a short, actionable instruction (not a suggestion).
 * The hint references the specific tool/resource to use next.
 */
export function getNextStepHint(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  const repo = args?.repo;
  const repoParam = repo ? `, repo: "${repo}"` : '';
  const repoPath = repo || '{name}';
  if (args?.read_mode === 'committed') {
    const committedParam = `${repoParam}, read_mode: "committed"`;
    if (toolName === 'search' && args.action === 'semantic') {
      return `\n\n---\n**Next:** Use inspect({action: "context", uid: "<result_uid>"${committedParam}}) to inspect an indexed result. Uncommitted source and live enrichment remain excluded.`;
    }
    if (toolName === 'inspect' && args.action === 'context') {
      return `\n\n---\n**Next:** Use impact({action: "symbol", target_uid: "<result_uid>", direction: "upstream"${committedParam}}) to inspect committed dependents.`;
    }
  }

  switch (toolName) {
    case 'list_repos':
      return `\n\n---\n**Next:** READ ontoindex://repo/{name}/context for any repo above to get its overview and check staleness. Outside MCP, the CLI equivalent is \`ontoindex list\`.`;

    case 'query':
      return `\n\n---\n**Next:** To understand a specific symbol in depth, use inspect({action: "context", name: "<symbol_name>"${repoParam}}) to see categorized refs and process participation.`;

    case 'context':
      return `\n\n---\n**Next:** If planning changes, use impact({action: "symbol", target: "${args?.name || '<name>'}", direction: "upstream"${repoParam}}) to check blast radius. To see execution flows, READ ontoindex://repo/${repoPath}/processes.`;

    case 'impact':
      return `\n\n---\n**Next:** Review depth-1 direct dependents first; they are the closest dependents, not proof of breakage. To check affected execution flows, READ ontoindex://repo/${repoPath}/processes.`;

    case 'detect_changes':
      return `\n\n---\n**Next:** Review affected processes. Use inspect({action: "context", ...}) on high-risk changed symbols. READ ontoindex://repo/${repoPath}/process/{name} for full execution traces. For explicit post-edit verification, then run gn_verify_diff({ expectedFiles: ["<file>"], expectedSymbols: ["<symbol>"]${repoParam ? `, repo: "${repo}"` : ''} }) and gn_test_gap({ executedTests: ["<test>"]${repoParam ? `, repo: "${repo}"` : ''} }).`;

    case 'cycle_detect':
      return `\n\n---\n**Next:** Pick a representative cycle member and run impact({action: "symbol", target: "<name>", direction: "upstream"${repoParam}}) to see what keeps the cycle relevant. Use inspect({action: "context", name: "<name>"${repoParam}}) to inspect the concrete edges inside the cycle.`;

    case 'coupling_matrix':
      return `\n\n---\n**Next:** Inspect the most unstable module, then use search({action: "semantic", query: "<module name>"${repoParam}}) or search({action: "cypher", query: "MATCH ... RETURN ... LIMIT 50"${repoParam}}) to see the concrete cross-module edges behind its Ca/Ce score.`;

    case 'migration_progress':
      return `\n\n---\n**Next:** Start with remaining_files[0], then use gn_verify_diff({ expectedFiles: ["<file>"], expectedSymbols: ["<symbol>"]${repoParam ? `, repo: "${repo}"` : ''} }) after each migration slice to keep the blast radius controlled.`;

    case 'boundary_violations':
      return `\n\n---\n**Next:** Pick one violating source file and run inspect({action: "context", name: "<symbol>", file_path: "<source_file>"${repoParam}}) or impact({action: "symbol", target: "<symbol>", direction: "downstream"${repoParam}}) before untangling the dependency.`;

    case 'type_coverage':
      return `\n\n---\n**Next:** Start with the highest-risk finding, then use inspect({action: "context", name: "<enclosing_symbol>"${repoParam}}) to inspect callers before tightening the type boundary.`;

    case 'rename':
      return `\n\n---\n**Next:** Rename is preview-only (refactor({action: "rename", target: "<symbol>", new_name: "<new>", dry_run: true${repoParam}})); review the candidate list, edit the affected files directly, then run gn_verify_diff({ expectedSymbols: ["<renamed_symbol>"], expectedFiles: ["<expected_file>"]${repoParam ? `, repo: "${repo}"` : ''} }) and gn_test_gap({ executedTests: ["<test>"]${repoParam ? `, repo: "${repo}"` : ''} }).`;

    case 'rename_symbol':
      return `\n\n---\n**Next:** Rename is preview-only (refactor({action: "rename", target: "<symbol>", new_name: "<new>", dry_run: true${repoParam}})); review the candidate list, edit the affected files directly, then run gn_verify_diff({ expectedSymbols: ["<renamed_symbol>"], expectedFiles: ["<expected_file>"]${repoParam ? `, repo: "${repo}"` : ''} }) and gn_test_gap({ executedTests: ["<test>"]${repoParam ? `, repo: "${repo}"` : ''} }).`;

    case 'cypher':
      return `\n\n---\n**Next:** To explore a result symbol, use inspect({action: "context", name: "<name>"${repoParam}}). For schema reference, READ ontoindex://repo/${repoPath}/schema.`;

    case 'route_map':
      return `\n\n---\n**Next:** To trace the impact of a specific route, use impact({action: "route", route: "<method> <path>"${repoParam}}). For a handler's blast radius, use impact({action: "symbol", target: "<handler>"${repoParam}}).`;

    case 'tool_map':
      return `\n\n---\n**Next:** For details on any discovered tool, use inspect({action: "context", name: "<tool_name>"${repoParam}}).`;

    case 'analysis_catalog':
      return `\n\n---\n**Next:** READ ontoindex://repo/${repoPath}/analysis-packs and ontoindex://repo/${repoPath}/analysis-suites to inspect the discovered pack and suite manifests in resource form.`;

    case 'audit_rerun':
      return `\n\n---\n**Next:** Review the rerun status for each finding, then update the source audit file or fix the still-live findings before rerunning the audit.`;

    case 'pattern_audit':
      return `\n\n---\n**Next:** Start with the highest-signal finding, then use inspect({action: "evidence", targets: ["<file>:<line>"]${repoParam}}) or inspect({action: "context", name: "<symbol>"${repoParam}}) to inspect the risky code in place.`;

    case 'build_residue_audit':
      return `\n\n---\n**Next:** Triage build-output matches first. If they are real leakage, inspect the source file and the emitting build path before changing filters or bundling logic.`;

    case 'cross_doc_drift':
      return `\n\n---\n**Next:** Update the stale plan/audit docs or fix the still-open findings, then rerun audit({action: "drift"${repoParam}}) to confirm the documentation matches reality.`;

    case 'evidence_pack':
      return `\n\n---\n**Next:** Use the snippets to verify the implementation detail you care about, then switch to inspect({action: "context", name: "<symbol>"${repoParam}}) if you need callers, callees, or process participation.`;

    case 'graph_diff':
      return `\n\n---\n**Next:** Inspect the highest-signal added or removed edge, then use inspect({action: "context", uid: "<symbol_uid>"${repoParam}}) or impact({action: "symbol", target: "<name>", direction: "upstream"${repoParam}}) to understand the architectural consequence.`;

    case 'hotspot_analysis':
      return `\n\n---\n**Next:** Take the top hotspot file and run search({action: "repomap", focus: ["<file>"]${repoParam}}) or impact({action: "symbol", target: "<symbol>", direction: "upstream"${repoParam}}) before refactoring it.`;

    case 'impact_batch':
      return `\n\n---\n**Next:** Review shared callers in the union result first, then drill into the riskiest symbol with inspect({action: "context", name: "<name>"${repoParam}}) before changing multiple targets together.`;

    case 'tech_debt':
      return `\n\n---\n**Next:** Start with the top-ranked symbol, then use impact({action: "symbol", target: "<name>", direction: "upstream"${repoParam}}) to confirm the real blast radius before refactoring it.`;

    case 'verification_gap':
      return `\n\n---\n**Next:** Add or update tests for the uncovered files, then rerun gn_test_gap({${repoParam ? ` repo: "${repo}" ` : ''}}) to confirm coverage moved from uncovered to covered.`;

    case 'ipc_trace':
      return `\n\n---\n**Next:** Follow the traced bridge steps into inspect({action: "context", name: "<symbol>"${repoParam}}) or inspect({action: "evidence", targets: ["<file>:<line>"]${repoParam}}) to inspect the native boundary in detail.`;

    case 'requirements_trace':
      return `\n\n---\n**Next:** Review uncovered or weakly-linked requirement IDs first, then add the missing implementation/test trace points before rerunning audit({action: "requirements"${repoParam}}).`;

    case 'dead_code':
      return `\n\n---\n**Next:** Start with the highest-confidence unreached symbols, then use inspect({action: "context", name: "<symbol>"${repoParam}}) or impact({action: "symbol", target: "<symbol>", direction: "upstream"${repoParam}}) before deleting anything.`;

    case 'shape_check':
      return `\n\n---\n**Next:** If the shape diverges, use impact({action: "symbol", target: "<symbol>", direction: "downstream"${repoParam}}) to see callers that assume the old shape.`;

    case 'api_impact':
      return `\n\n---\n**Next:** For each downstream symbol, run inspect({action: "context", name: "<name>"${repoParam}}) before changing the route signature.`;

    case 'repomap':
      return `\n\n---\n**Next:** Review the top-ranked symbols; to dig into a specific one, use inspect({action: "context", name: "<name>"${repoParam}}). For a downstream impact check, use impact({action: "symbol", target: "<name>", direction: "downstream"${repoParam}}).`;

    case 'route':
      return `\n\n---\n**Next:** Call the suggested tool directly. If the classification misses, fall back to search({action: "semantic", query: "..."${repoParam}}).`;

    case 'session':
      return `\n\n---\n**Next:** After set/get, use list({ action: "list", session_id: "${args?.session_id || '<id>'}"${repoParam} }) to see all keys for this session.`;

    case 'group_list':
      return `\n\n---\n**Next:** For cross-member impact, call impact({action: "symbol", target: "<symbol>", repo: "@<groupName>"}).`;

    case 'group_sync':
      return `\n\n---\n**Next:** After sync, discover({action: "repos"}) to verify fresh indexedAt. For a fresh query, use search({action: "semantic", query: "<term>", repo: "@<groupName>"}).`;

    case 'sandbox':
      return `\n\n---\n**Next:** Sandbox apply is unavailable. Review the staged preview, edit files directly, then verify with gn_verify_diff({ changedFiles: [...], expectedFiles: [...]${repoParam} }).`;

    case 'replace_symbol':
      return `\n\n---\n**Next:** Previewed with dry_run? Rerun replace_symbol({ uid: "${args?.uid || '<uid>'}", new_body: "...", dry_run: false, confirm: true${repoParam} }) to write. Then run gn_verify_diff({ expectedSymbols: ["<symbol>"], expectedFiles: ["<file>"]${repoParam ? `, repo: "${repo}"` : ''} }) and gn_test_gap({ executedTests: ["<test>"]${repoParam ? `, repo: "${repo}"` : ''} }) to verify the rewrite didn't regress callers.`;

    case 'get_symbol_info':
      return `\n\n---\n**Next:** Use the returned UID with refactor({action: "rename", uid: "<uid>", new_name: "...", dry_run: true${repoParam}}) to review zero-ambiguity rename candidates; then edit files directly and verify. Use update_symbol_body({ uid: "<uid>", new_body: "..."${repoParam} }) to rewrite the implementation.`;

    case 'update_symbol_body':
      return `\n\n---\n**Next:** Run gn_verify_diff({ expectedSymbols: ["<symbol>"], expectedFiles: ["<file>"]${repoParam ? `, repo: "${repo}"` : ''} }) and gn_test_gap({ executedTests: ["<test>"]${repoParam ? `, repo: "${repo}"` : ''} }) to verify the rewrite didn't regress callers.`;

    case 'extract_function':
      return `\n\n---\n**Next:** Run gn_verify_diff({ expectedSymbols: ["<source_symbol>", "<extracted_symbol>"], expectedFiles: ["<file>"]${repoParam ? `, repo: "${repo}"` : ''} }) and gn_test_gap({ executedTests: ["<test>"]${repoParam ? `, repo: "${repo}"` : ''} }) to verify no unexpected side effects from the extraction.`;

    case 'move_symbol':
      return `\n\n---\n**Next:** Run gn_verify_diff({ expectedSymbols: ["<moved_symbol>"], expectedFiles: ["<old_file>", "<new_file>"]${repoParam ? `, repo: "${repo}"` : ''} }) and gn_test_gap({ executedTests: ["<test>"]${repoParam ? `, repo: "${repo}"` : ''} }) to verify no unexpected side effects from the move.`;

    case 'discover':
      return `\n\n---\n**Next:** Use search({action: "semantic", query: "..."}) to find code, or inspect({action: "context", name: "..."}) for a symbol deep-dive.`;
    case 'search':
      if (args?.action === 'semantic' && args?.consume_enrichment_facts !== true) {
        return `\n\n---\n**Next:** To include opt-in sidecar context, rerun search({action: "semantic", query: "...", consume_enrichment_facts: true, include_passive_related_facts: true, include_markdown_context: true${repoParam}}), then inspect({action: "context", target: "<symbol>"${repoParam}}) for a result.`;
      }
      if (args?.action === 'semantic' && args?.include_markdown_context === true) {
        return `\n\n---\n**Next:** Use inspect({action: "context", target: "<symbol>", consume_enrichment_facts: true${repoParam}}) for code refs, or rerun search with include_markdown_ppr: true to include bounded Markdown document PPR metadata.`;
      }
      return `\n\n---\n**Next:** Use inspect({action: "context", name: "<symbol>"}) to explore a result in depth.`;
    case 'inspect':
      return `\n\n---\n**Next:** If planning changes, use impact({action: "symbol", target: "<name>", direction: "upstream"}) to check blast radius.`;
    case 'audit':
      return `\n\n---\n**Next:** Use inspect({action: "evidence", targets: ["<file>:<line>"]}) to collect code snippets for the top finding.`;
    case 'refactor':
      return `\n\n---\n**Next:** Run gn_verify_diff({ expectedFiles: ["<file>"], expectedSymbols: ["<symbol>"] }) and gn_test_gap({ executedTests: ["<test>"] }) to verify no unexpected side effects from the change.`;
    case 'manage':
      return `\n\n---\n**Next:** Use search({action: "semantic", query: "..."}) to continue exploring the codebase.`;

    // Legacy tool names — still return useful hints
    case 'explore':
      return `\n\n---\n**Next:** If planning changes, use impact({action: "symbol", target: "<name>", direction: "upstream"${repoParam}}).`;
    case 'overview':
      return `\n\n---\n**Next:** To drill into an area, READ ontoindex://repo/${repoPath}/cluster/{name}. To see execution flows, READ ontoindex://repo/${repoPath}/processes.`;

    default:
      return '';
  }
}

async function dispatchLazySuper(
  name: SuperTool,
  params: Record<string, unknown>,
  repoId: string,
  backend?: import('./super/safe-refactor.js').RefactorBackend,
  context?: { repoPath: string; projectCwd?: string | null },
  readBackend?: Pick<
    LocalBackend,
    'resolveRepo' | 'ensureRepoInitialized' | 'withPreparedRepoRead'
  >,
): Promise<unknown> {
  const { dispatchSuper } = await import('./super/dispatch.js');
  if (readBackend) return dispatchSuper(name, params, repoId, backend, context, readBackend);
  if (context) return dispatchSuper(name, params, repoId, backend, context);
  return backend
    ? dispatchSuper(name, params, repoId, backend)
    : dispatchSuper(name, params, repoId);
}

/**
 * Create a configured MCP Server with all handlers registered.
 * Transport-agnostic — caller connects the desired transport.
 */
export function createMCPServer(
  backend: LocalBackend,
  options: { full?: boolean; transport?: 'stdio' | 'http'; projectCwd?: string } = {},
): Server {
  const require = createRequire(import.meta.url);
  const pkgVersion: string = require('../../package.json').version;
  const server = new Server(
    {
      name: 'ontoindex',
      version: pkgVersion,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  const activeRequests = new Set<Promise<unknown>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  function trackRequest<T>(
    operation: () => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    if (closing) return Promise.reject(new McpError(ErrorCode.InternalError, 'Server is closing.'));
    const pending = Promise.resolve().then(() =>
      typeof backend.withOperation === 'function'
        ? backend.withOperation(operation, options)
        : operation(),
    );
    activeRequests.add(pending);
    void pending.then(
      () => activeRequests.delete(pending),
      () => activeRequests.delete(pending),
    );
    return pending;
  }
  const closeTransport = server.close.bind(server);
  server.close = () => {
    closing = true;
    closePromise ??= Promise.resolve().then(async () => {
      try {
        await closeTransport();
      } finally {
        await Promise.allSettled([...activeRequests]);
      }
    });
    return closePromise;
  };

  // Handle list resources request
  server.setRequestHandler(ListResourcesRequestSchema, () =>
    trackRequest(async () => {
      const resources = getResourceDefinitions();
      return {
        resources: resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })),
      };
    }),
  );

  // Handle list resource templates request (for dynamic resources)
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
    trackRequest(async () => {
      const templates = getResourceTemplates();
      return {
        resourceTemplates: templates.map((t) => ({
          uriTemplate: t.uriTemplate,
          name: t.name,
          description: t.description,
          mimeType: t.mimeType,
        })),
      };
    }),
  );

  // Handle read resource request
  server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    trackRequest(async () => {
      const { uri } = request.params;

      try {
        const content = await readResource(uri, backend);
        const parsed = parseResourceUri(uri);
        let canonicalUri = uri;
        if (parsed.kind === 'repo') {
          canonicalUri =
            `ontoindex://repo/${encodeURIComponent(parsed.repoName)}/${parsed.resourceType}` +
            (parsed.param === undefined ? '' : `/${encodeURIComponent(parsed.param)}`);
        } else if (parsed.kind === 'group') {
          canonicalUri = `ontoindex://group/${encodeURIComponent(parsed.groupName)}/${parsed.resourceType}`;
        }
        const resource =
          getResourceDefinitions().find((entry) => entry.uri === canonicalUri) ??
          getResourceTemplates().find((entry) =>
            new UriTemplate(entry.uriTemplate).match(canonicalUri),
          );
        const response = {
          contents: [
            {
              uri,
              mimeType: resource?.mimeType ?? 'text/plain',
              text: boundMcpErrorText(
                (text) => text,
                content,
                MCP_RESPONSE_MAX_BYTES,
                (text) =>
                  Buffer.byteLength(
                    JSON.stringify({
                      contents: [{ uri, mimeType: resource?.mimeType ?? 'text/plain', text }],
                    }),
                    'utf8',
                  ),
              ),
            },
          ],
        };
        if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MCP_RESPONSE_MAX_BYTES) {
          throw new Error('Resource response exceeded the byte limit.');
        }
        return response;
      } catch (err: unknown) {
        const classified =
          err instanceof McpError && (err.code === ErrorCode.InvalidParams || err.code === -32002);
        const code = classified ? err.code : ErrorCode.InternalError;
        const message = classified ? err.message : 'Resource read failed.';
        // Reserve protocol framing and the SDK's error-code prefix; never echo backend data.
        throw new McpError(
          code,
          boundMcpErrorText(
            (text) => text,
            message,
            MCP_RESPONSE_MAX_BYTES - 1024,
            (text) => Buffer.byteLength(JSON.stringify({ code, message: text }), 'utf8'),
          ),
        );
      }
    }),
  );

  // Handle list tools request
  const startupProfile = getMcpStartupProfileFromEnv();
  const activeTools = options.full
    ? INTERNAL_TOOL_HANDLERS
    : getPublicToolDefinitions({ startupProfile });
  // Helper to remove strict constraints from schemas for better LLM (e.g. Gemini) compatibility
  function relaxSchemaForClient(schema: any): any {
    if (Array.isArray(schema)) {
      return schema.map(relaxSchemaForClient);
    }
    if (schema !== null && typeof schema === 'object') {
      const relaxed: any = {};
      for (const [k, v] of Object.entries(schema)) {
        if (['default', 'minimum', 'maximum', 'minLength'].includes(k)) continue;
        relaxed[k] = relaxSchemaForClient(v);
      }
      return relaxed;
    }
    return schema;
  }

  server.setRequestHandler(ListToolsRequestSchema, () =>
    trackRequest(async () => ({
      tools: activeTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: relaxSchemaForClient(
          withResponseCursor(
            [
              'gn_explore',
              'gn_find_related',
              'gn_safe_edit_check',
              'gn_can_delete',
              'inspect',
              'impact',
              'search',
              'audit',
            ].includes(tool.name)
              ? {
                  ...tool.inputSchema,
                  properties: {
                    ...(tool.inputSchema as any).properties,
                    read_mode: {
                      type: 'string',
                      enum: ['committed'],
                      description:
                        'Explicit indexed-commit view; excludes uncommitted source and live enrichment. Supported for explore, find_related, safe_edit_check, can_delete, inspect/context or related, impact/symbol, search/semantic and audit/safe_edit_check or can_delete.',
                    },
                  },
                }
              : tool.inputSchema,
          ),
        ),
        ...(READ_ONLY_TOOL_NAMES.has(tool.name)
          ? { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
          : {}),
      })),
    })),
  );

  // Handle tool calls — append next-step hints to guide agent workflow
  const FACADE_NAMES = new Set<string>([
    'discover',
    'search',
    'inspect',
    'impact',
    'audit',
    'refactor',
    'manage',
    'docs',
  ]);
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    trackRequest(
      async () => {
        const { name, arguments: args } = request.params;
        const typedArgs = (args ?? {}) as Record<string, unknown>;
        let repoIdentity: RepoIdentity | null = null;
        const supportedCommittedRead =
          name === 'gn_explore' ||
          name === 'gn_find_related' ||
          name === 'gn_safe_edit_check' ||
          name === 'gn_can_delete' ||
          (name === 'audit' &&
            (typedArgs.action === 'safe_edit_check' || typedArgs.action === 'can_delete')) ||
          (name === 'inspect' &&
            (typedArgs.action === 'context' ||
              typedArgs.action === 'related' ||
              typedArgs.action === 'explore')) ||
          (name === 'impact' && typedArgs.action === 'symbol') ||
          (name === 'search' && typedArgs.action === 'semantic');
        const committedFallbackAvailable =
          supportedCommittedRead &&
          !options.full &&
          typedArgs.read_mode === undefined &&
          typeof typedArgs.repo === 'string' &&
          typedArgs.repo.trim().length > 0 &&
          !typedArgs.repo.startsWith('@') &&
          typedArgs.include_lsp_refs !== true &&
          typedArgs.consume_enrichment_facts !== true &&
          typedArgs.include_passive_related_facts !== true &&
          typedArgs.include_markdown_context !== true &&
          (!typedArgs.retrieval_policy || typedArgs.retrieval_policy === 'graph-only');

        try {
          const oversized = findOversizedArgument(typedArgs);
          if (oversized) throw new Error(`Invalid arguments for ${name}: ${oversized}`);
          const responseBudgetBytes = validateResponseBudget(typedArgs.response_budget_bytes);
          const committedRead = typedArgs.read_mode !== undefined;
          if (committedRead) {
            if (
              typedArgs.read_mode !== 'committed' ||
              !supportedCommittedRead ||
              options.full ||
              typeof typedArgs.repo !== 'string' ||
              typedArgs.repo.startsWith('@')
            ) {
              throw new Error(
                'read_mode=committed requires an explicit single repository and a supported navigation operation.',
              );
            }
            if (
              typedArgs.include_lsp_refs === true ||
              typedArgs.consume_enrichment_facts === true ||
              typedArgs.include_passive_related_facts === true ||
              typedArgs.include_markdown_context === true ||
              (typedArgs.retrieval_policy && typedArgs.retrieval_policy !== 'graph-only')
            ) {
              throw new Error('Committed reads do not support live or external enrichment.');
            }
          }
          if (options.transport === 'http' && name === 'gn_quality_mode') {
            throw new Error(
              'gn_quality_mode is unavailable over HTTP because it changes process-wide configuration.',
            );
          }
          const responseCursor =
            typeof typedArgs.response_cursor === 'string' ? typedArgs.response_cursor : undefined;
          if (responseCursor) {
            const page = await pageMcpResponse({
              tool: name,
              args: typedArgs,
              cursor: responseCursor,
              responseBudgetBytes,
            });
            return { content: [{ type: 'text', text: page.text }] };
          }

          const execute = async () => {
            let result: unknown;
            if (!options.full && SUPER_NAMES.has(name as SuperTool)) {
              if (isRepoOptionalSuperToolName(name)) {
                result = await dispatchLazySuper(name as SuperTool, typedArgs, '');
              } else {
                const repo = await backend.resolveRepo(typedArgs.repo as string | undefined);
                repoIdentity = {
                  repoLabel: repo.name ?? repo.id,
                  repoPath: repo.repoPath,
                };
                const operation = () =>
                  dispatchLazySuper(
                    name as SuperTool,
                    typedArgs,
                    repo.id,
                    name === 'gn_safe_refactor'
                      ? {
                          repoPath: repo.repoPath,
                          callTool: backend.callTool.bind(backend),
                        }
                      : undefined,
                    name === 'gn_diagnose'
                      ? { repoPath: repo.repoPath, projectCwd: options.projectCwd ?? null }
                      : name === 'gn_audit_logic'
                        ? { repoPath: repo.repoPath }
                        : undefined,
                    name === 'gn_test_gap' || name === 'gn_verify_diff' ? backend : undefined,
                  );
                const superResult = await withPreparedSuperRead(
                  name as SuperTool,
                  typedArgs,
                  repo,
                  backend,
                  { automaticWorkspace: isAutomaticWorkspaceEnabled(), committedRead },
                  operation,
                );
                result = attachRepoScopeIdentity(superResult, repo);
              }
            } else if (!options.full && FACADE_NAMES.has(name)) {
              const action = typedArgs.action as string;
              if (!action) throw new Error(`Tool "${name}" requires an "action" parameter.`);
              result = await dispatchFacade(name as FacadeTool, action, typedArgs, backend);
            } else {
              result = await backend.callTool(name, typedArgs);
            }
            return result;
          };
          let result: unknown;
          if (committedRead) {
            const repo = await backend.resolveRepo(typedArgs.repo as string);
            repoIdentity = { repoLabel: repo.name ?? repo.id, repoPath: repo.repoPath };
            await backend.ensureRepoInitialized(repo.id);
            result = await backend.withPreparedRepoRead(
              repo,
              { needsRelationships: true, readMode: 'committed' },
              execute,
            );
          } else {
            result = await execute();
          }
          const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          const hint = responseBudgetBytes === undefined ? getNextStepHint(name, typedArgs) : '';
          const page = await pageMcpResponse({
            tool: name,
            args: typedArgs,
            text: resultText + hint,
            identityText: resultText,
            responseBudgetBytes,
            isError: isMarkedInvocationError(result),
          });
          return {
            content: [{ type: 'text', text: page.text }],
            ...(isMarkedInvocationError(result) ? { isError: true } : {}),
          };
        } catch (error) {
          const scopedRepoIdentity = repoIdentity ?? readRepoIdentity(error);
          return {
            content: [
              {
                type: 'text',
                text: formatToolCallErrorMessage(
                  error,
                  scopedRepoIdentity,
                  committedFallbackAvailable,
                ),
              },
            ],
            isError: true,
          };
        }
      },
      { signal: extra?.signal },
    ),
  );

  // Handle list prompts request
  server.setRequestHandler(ListPromptsRequestSchema, () =>
    trackRequest(async () => ({
      prompts: [
        {
          name: 'detect_impact',
          description:
            'Analyze the impact of your current changes before committing. Guides through scope selection, change detection, process analysis, and risk assessment.',
          arguments: [
            {
              name: 'scope',
              description: 'What to analyze: unstaged, staged, all, or compare',
              required: false,
            },
            { name: 'base_ref', description: 'Branch/commit for compare scope', required: false },
          ],
        },
        {
          name: 'generate_map',
          description:
            'Generate architecture documentation from the knowledge graph. Creates a codebase overview with execution flows and mermaid diagrams.',
          arguments: [
            {
              name: 'repo',
              description: 'Repository name (omit if only one indexed)',
              required: false,
            },
          ],
        },
      ],
    })),
  );

  // Handle get prompt request
  server.setRequestHandler(GetPromptRequestSchema, (request) =>
    trackRequest(async () => {
      const { name, arguments: args } = request.params;
      const argument = (key: string): string => {
        const value = args?.[key];
        if (value === undefined) return '';
        if (
          typeof value !== 'string' ||
          Buffer.byteLength(value, 'utf8') > MAX_PROMPT_ARGUMENT_BYTES
        ) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid prompt argument.');
        }
        return value;
      };
      const boundedPrompt = <T>(response: T): T => {
        if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MCP_RESPONSE_MAX_BYTES) {
          throw new McpError(ErrorCode.InvalidParams, 'Prompt response exceeded the byte limit.');
        }
        return response;
      };

      if (name === 'detect_impact') {
        const scope = argument('scope') || 'all';
        const baseRef = argument('base_ref');
        if (!['unstaged', 'staged', 'all', 'compare'].includes(scope)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid impact scope.');
        }
        return boundedPrompt({
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `Analyze the impact of my current code changes before committing.

Follow these steps:
1. Run \`impact(${JSON.stringify({ action: 'diff', scope, ...(baseRef ? { base_ref: baseRef } : {}) })})\` to find what changed and affected processes
2. For each changed symbol in critical processes, run \`inspect({action: "context", name: "<symbol>"})\` to see its full reference graph
3. For any high-risk items (many callers or cross-process), run \`impact({action: "symbol", target: "<symbol>", direction: "upstream"})\` for blast radius
4. Summarize: changes, affected processes, risk level, and recommended actions

Present the analysis as a clear risk report.`,
              },
            },
          ],
        });
      }

      if (name === 'generate_map') {
        const repo = argument('repo');
        return boundedPrompt({
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `Generate architecture documentation for this codebase using the knowledge graph.

Follow these steps:
1. READ \`ontoindex://repo/${repo || '{name}'}/context\` for codebase stats
2. READ \`ontoindex://repo/${repo || '{name}'}/clusters\` to see all functional areas
3. READ \`ontoindex://repo/${repo || '{name}'}/processes\` to see all execution flows
4. For the top 5 most important processes, READ \`ontoindex://repo/${repo || '{name}'}/process/{name}\` for step-by-step traces
5. Generate a mermaid architecture diagram showing the major areas and their connections
6. Write an ARCHITECTURE.md file with: overview, functional areas, key execution flows, and the mermaid diagram`,
              },
            },
          ],
        });
      }

      throw new McpError(ErrorCode.InvalidParams, 'Unknown prompt.');
    }),
  );

  return server;
}

function withResponseCursor(schema: any): any {
  if (!schema || schema.type !== 'object') return schema;
  return {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      response_cursor: {
        type: 'string',
        description:
          'Opaque continuation cursor returned by a truncated response. Repeat the same tool request with this value to read the next immutable UTF-8 JSON-text page.',
      },
      response_budget_bytes: {
        type: 'integer',
        description:
          'Optional positive safe-integer logical response budget in serialized MCP bytes.',
      },
    },
  };
}

/**
 * Start the MCP server on stdio transport (for CLI use).
 */
export async function startMCPServer(
  backend: LocalBackend,
  options: { full?: boolean; projectCwd?: string } = {},
): Promise<void> {
  const server = createMCPServer(backend, options);

  // Use the shared stdout reference captured at module-load time by the
  // lbug-adapter.  Avoids divergence if anything patches stdout between
  // module load and server start.
  const _safeStdout = new Proxy(process.stdout, {
    get(target, prop, receiver) {
      if (prop === 'write') return realStdoutWrite;
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
  const transport = new CompatibleStdioServerTransport(process.stdin, _safeStdout);
  const trace = ['1', 'true', 'yes'].includes(
    process.env.ONTOINDEX_MCP_STARTUP_TRACE?.toLowerCase() ?? '',
  );

  // Graceful shutdown helper and listeners must be ready before connect, which
  // may observe an already-closed stdio stream or emit errors while starting.
  let shuttingDown = false;
  let shutdownExitCode = 0;
  const shutdown = async (exitCode = 0) => {
    shutdownExitCode = Math.max(shutdownExitCode, exitCode);
    // Repeated signals do not cut cleanup short; the grace deadline is the only bound.
    if (shuttingDown) return;
    shuttingDown = true;
    const completed = await withShutdownGrace(
      (async () => {
        // close fences admission synchronously; disposal cancels builders that
        // admitted readers may be waiting on, so both must drain together.
        const closing = (async () => server.close())();
        const disposing = (async () => backend.dispose())();
        const results = await Promise.allSettled([closing, disposing]);
        for (const [index, result] of results.entries()) {
          if (result.status === 'rejected') {
            shutdownExitCode = 1;
            process.stderr.write(
              `[ontoindex:mcp] ${index === 0 ? 'server close' : 'backend disposal'} failed: ${boundMcpErrorText((message) => message, String(result.reason))}\n`,
            );
          }
        }
      })(),
    );
    if (!completed) shutdownExitCode = 1;
    process.exit(shutdownExitCode);
  };

  // Wrapped: Node passes the signal name to handlers, and process.exit()
  // throws ERR_INVALID_ARG_TYPE on a string exit code.
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  // uncaughtException is fatal; unhandledRejection is logged but non-fatal (availability-first).
  process.on('uncaughtException', (err) => {
    process.stderr.write(`OntoIndex MCP uncaughtException: ${err?.stack || err}\n`);
    shutdown(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(
      `OntoIndex MCP unhandledRejection: ${formatUnhandledRejectionReason(reason)}\n`,
    );
  });
  // stdin end/close/error means the parent process is gone.
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('close', () => void shutdown());
  process.stdin.on('error', () => void shutdown());
  process.stdout.on('error', () => void shutdown());
  if (process.stdin.destroyed || process.stdin.readableEnded) void shutdown();

  const idleMs = resolveIdleExitMs(process.env.ONTOINDEX_MCP_IDLE_EXIT_MS);
  if (idleMs !== null) {
    process.stderr.write(
      `[ontoindex] idle exit enabled after ${idleMs} ms; clients must restart the MCP connection to resume\n`,
    );
    const requests = new Set<string>();
    const idleTracker = createIdleTracker({
      idleMs,
      isBusy: () => openPoolCount() > 0,
      onIdle: () => {
        process.stderr.write(
          `[ontoindex] idle for ${idleMs} ms; exiting (restart the MCP client connection to resume)\n`,
        );
        void shutdown(0);
      },
    });
    const checkIntervalMs = Math.min(30_000, idleMs / 4);
    const idleTimer = setInterval(() => idleTracker.check(), checkIntervalMs);
    idleTimer.unref();

    const onmessage = transport.onmessage;
    transport.onmessage = (message) => {
      if ('method' in message) {
        idleTracker.touch();
        if ('id' in message) {
          const key = `${typeof message.id}:${String(message.id)}`;
          requests.add(key);
          idleTracker.begin();
        }
      }
      onmessage?.(message);
    };
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      let requestKey: string | undefined;
      if (!('method' in message) && 'id' in message) {
        requestKey = `${typeof message.id}:${String(message.id)}`;
      }
      try {
        return await send(message, options);
      } finally {
        if (requestKey !== undefined && requests.delete(requestKey)) idleTracker.end();
      }
    };
  }

  if (trace) console.error('[ontoindex:mcp:init] server.connect: start');
  try {
    await server.connect(transport);
  } catch (error) {
    if (trace)
      console.error(
        `[ontoindex:mcp:init] server.connect: failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    throw error;
  }
}
