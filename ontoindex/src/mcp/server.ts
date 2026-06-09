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

import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CompatibleStdioServerTransport } from './compatible-stdio-transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { INTERNAL_TOOL_HANDLERS } from './tools.js';
import { dispatchFacade, type FacadeTool } from './facade/dispatch.js';
import { SUPER_NAMES, type SuperTool } from './super/names.js';
import {
  getMcpStartupProfileFromEnv,
  getPublicToolDefinitions,
  isRepoOptionalSuperToolName,
} from './shared/tool-registry.js';
import { realStdoutWrite } from './core/lbug-adapter.js';
import type { LocalBackend } from './local/local-backend.js';
import { getResourceDefinitions, getResourceTemplates, readResource } from './resources.js';

const GRAPH_BACKED_SUPER_TOOLS = new Set<SuperTool>([
  'gn_explore',
  'gn_explain_module',
  'gn_find_related',
  'gn_safe_edit_check',
  'gn_can_delete',
  'gn_pre_commit_audit',
  'gn_safe_refactor',
  'gn_diff_impact',
  'gn_review_diff',
  'gn_propose_location',
  'gn_docs',
]);

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

  switch (toolName) {
    case 'list_repos':
      return `\n\n---\n**Next:** READ ontoindex://repo/{name}/context for any repo above to get its overview and check staleness.`;

    case 'query':
      return `\n\n---\n**Next:** To understand a specific symbol in depth, use context({name: "<symbol_name>"${repoParam}}) to see categorized refs and process participation.`;

    case 'context':
      return `\n\n---\n**Next:** If planning changes, use impact({target: "${args?.name || '<name>'}", direction: "upstream"${repoParam}}) to check blast radius. To see execution flows, READ ontoindex://repo/${repoPath}/processes.`;

    case 'impact':
      return `\n\n---\n**Next:** Review d=1 items first (WILL BREAK). To check affected execution flows, READ ontoindex://repo/${repoPath}/processes.`;

    case 'detect_changes':
      return `\n\n---\n**Next:** Review affected processes. Use context() on high-risk changed symbols. READ ontoindex://repo/${repoPath}/process/{name} for full execution traces. For explicit post-edit verification, keep detect_changes for diff impact, then run gn_verify_diff({ expectedFiles: ["<file>"], expectedSymbols: ["<symbol>"]${repoParam ? `, repo: "${repo}"` : ''} }) and gn_test_gap({ executedTests: ["<test>"]${repoParam ? `, repo: "${repo}"` : ''} }).`;

    case 'cycle_detect':
      return `\n\n---\n**Next:** Pick a representative cycle member and run impact({target: "<name>", direction: "upstream"${repoParam}}) to see what keeps the cycle relevant. Use context({name: "<name>"${repoParam}}) to inspect the concrete edges inside the cycle.`;

    case 'coupling_matrix':
      return `\n\n---\n**Next:** Inspect the most unstable module, then use query({query: "<module name>"${repoParam}}) or cypher({query: "MATCH ... MEMBER_OF ... RETURN ... "${repoParam}}) to see the concrete cross-module edges behind its Ca/Ce score.`;

    case 'migration_progress':
      return `\n\n---\n**Next:** Start with remaining_files[0], then use gn_verify_diff({ expectedFiles: ["<file>"], expectedSymbols: ["<symbol>"]${repoParam ? `, repo: "${repo}"` : ''} }) after each migration slice to keep the blast radius controlled.`;

    case 'boundary_violations':
      return `\n\n---\n**Next:** Pick one violating source file and run context({name: "<symbol>", file_path: "<source_file>"${repoParam}}) or impact({target: "<symbol>", direction: "downstream"${repoParam}}) before untangling the dependency.`;

    case 'type_coverage':
      return `\n\n---\n**Next:** Start with the highest-risk finding, then use context({name: "<enclosing_symbol>"${repoParam}}) to inspect callers before tightening the type boundary.`;

    case 'rename':
      return `\n\n---\n**Next:** Run gn_verify_diff({ expectedSymbols: ["<renamed_symbol>"], expectedFiles: ["<expected_file>"]${repoParam ? `, repo: "${repo}"` : ''} }) and gn_test_gap({ executedTests: ["<test>"]${repoParam ? `, repo: "${repo}"` : ''} }) to verify no unexpected side effects from the rename.`;

    case 'rename_symbol':
      return `\n\n---\n**Next:** Run gn_verify_diff({ expectedSymbols: ["<renamed_symbol>"], expectedFiles: ["<expected_file>"]${repoParam ? `, repo: "${repo}"` : ''} }) and gn_test_gap({ executedTests: ["<test>"]${repoParam ? `, repo: "${repo}"` : ''} }) to verify no unexpected side effects from the rename.`;

    case 'cypher':
      return `\n\n---\n**Next:** To explore a result symbol, use context({name: "<name>"${repoParam}}). For schema reference, READ ontoindex://repo/${repoPath}/schema.`;

    case 'route_map':
      return `\n\n---\n**Next:** To trace the impact of a specific route, use api_impact({route: "<method> <path>"${repoParam}}). For a handler's blast radius, use impact({target: "<handler>"${repoParam}}).`;

    case 'tool_map':
      return `\n\n---\n**Next:** For details on any discovered tool, use context({name: "<tool_name>"${repoParam}}).`;

    case 'analysis_catalog':
      return `\n\n---\n**Next:** READ ontoindex://repo/${repoPath}/analysis-packs and ontoindex://repo/${repoPath}/analysis-suites to inspect the discovered pack and suite manifests in resource form.`;

    case 'audit_rerun':
      return `\n\n---\n**Next:** Review the rerun status for each finding, then update the source audit file or fix the still-live findings before rerunning the audit.`;

    case 'pattern_audit':
      return `\n\n---\n**Next:** Start with the highest-signal finding, then use evidence_pack({targets: ["<file>:<line>"]${repoParam}}) or context({name: "<symbol>"${repoParam}}) to inspect the risky code in place.`;

    case 'build_residue_audit':
      return `\n\n---\n**Next:** Triage build-output matches first. If they are real leakage, inspect the source file and the emitting build path before changing filters or bundling logic.`;

    case 'cross_doc_drift':
      return `\n\n---\n**Next:** Update the stale plan/audit docs or fix the still-open findings, then rerun cross_doc_drift(${repoParam ? `{repo: "${repo}"}` : ''}) to confirm the documentation matches reality.`;

    case 'evidence_pack':
      return `\n\n---\n**Next:** Use the snippets to verify the implementation detail you care about, then switch to context({name: "<symbol>"${repoParam}}) if you need callers, callees, or process participation.`;

    case 'graph_diff':
      return `\n\n---\n**Next:** Inspect the highest-signal added or removed edge, then use context({uid: "<symbol_uid>"${repoParam}}) or impact({target: "<name>", direction: "upstream"${repoParam}}) to understand the architectural consequence.`;

    case 'hotspot_analysis':
      return `\n\n---\n**Next:** Take the top hotspot file and run repomap({focus: ["<file>"]${repoParam}}) or impact({target: "<symbol>", direction: "upstream"${repoParam}}) before refactoring it.`;

    case 'impact_batch':
      return `\n\n---\n**Next:** Review shared callers in the union result first, then drill into the riskiest symbol with context({name: "<name>"${repoParam}}) before changing multiple targets together.`;

    case 'tech_debt':
      return `\n\n---\n**Next:** Start with the top-ranked symbol, then use impact({target: "<name>", direction: "upstream"${repoParam}}) to confirm the real blast radius before refactoring it.`;

    case 'verification_gap':
      return `\n\n---\n**Next:** Add or update tests for the uncovered files, then rerun verification_gap(${repoParam ? `{repo: "${repo}"}` : ''}) to confirm coverage moved from uncovered to covered.`;

    case 'ipc_trace':
      return `\n\n---\n**Next:** Follow the traced bridge steps into context({name: "<symbol>"${repoParam}}) or evidence_pack({targets: ["<file>:<line>"]${repoParam}}) to inspect the native boundary in detail.`;

    case 'requirements_trace':
      return `\n\n---\n**Next:** Review uncovered or weakly-linked requirement IDs first, then add the missing implementation/test trace points before rerunning requirements_trace(${repoParam ? `{repo: "${repo}"}` : ''}).`;

    case 'dead_code':
      return `\n\n---\n**Next:** Start with the highest-confidence unreached symbols, then use context({name: "<symbol>"${repoParam}}) or impact({target: "<symbol>", direction: "upstream"${repoParam}}) before deleting anything.`;

    case 'shape_check':
      return `\n\n---\n**Next:** If the shape diverges, use impact({target: "<symbol>", direction: "downstream"${repoParam}}) to see callers that assume the old shape.`;

    case 'api_impact':
      return `\n\n---\n**Next:** For each downstream symbol, run context({name: "<name>"${repoParam}}) before changing the route signature.`;

    case 'repomap':
      return `\n\n---\n**Next:** Review the top-ranked symbols; to dig into a specific one, use context({name: "<name>"${repoParam}}). For a downstream impact check, use impact({target: "<name>", direction: "downstream"${repoParam}}).`;

    case 'route':
      return `\n\n---\n**Next:** Call the suggested tool directly. If the classification misses, fall back to query({query: "..."${repoParam}}).`;

    case 'session':
      return `\n\n---\n**Next:** After set/get, use list({ action: "list", session_id: "${args?.session_id || '<id>'}"${repoParam} }) to see all keys for this session.`;

    case 'group_list':
      return `\n\n---\n**Next:** For cross-member impact, call impact({target: "<symbol>", repo: "@<groupName>"}).`;

    case 'group_sync':
      return `\n\n---\n**Next:** After sync, list_repos(${repoParam ? `{repo: "${repo}"}` : ''}) to verify fresh indexedAt. For a fresh query, use query({q: "<term>", repo: "@<groupName>"}).`;

    case 'sandbox':
      return `\n\n---\n**Next:** Staged a mutation? Rerun sandbox({ action: "apply", confirm: true${repoParam} }) to commit. Ensure the backend is started with --confirm-writes or apply will fail closed.`;

    case 'replace_symbol':
      return `\n\n---\n**Next:** Previewed with dry_run? Rerun replace_symbol({ uid: "${args?.uid || '<uid>'}", new_body: "...", dry_run: false, confirm: true${repoParam} }) to write. Then run gn_verify_diff({ expectedSymbols: ["<symbol>"], expectedFiles: ["<file>"]${repoParam ? `, repo: "${repo}"` : ''} }) and gn_test_gap({ executedTests: ["<test>"]${repoParam ? `, repo: "${repo}"` : ''} }) to verify the rewrite didn't regress callers.`;

    case 'get_symbol_info':
      return `\n\n---\n**Next:** Use the returned UID with rename_symbol({ uid: "<uid>", new_name: "..."${repoParam} }) for zero-ambiguity rename, or update_symbol_body({ uid: "<uid>", new_body: "..."${repoParam} }) to rewrite the implementation.`;

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
      return `\n\n---\n**Next:** If planning changes, use impact({target: "<name>", direction: "upstream"${repoParam}}).`;
    case 'overview':
      return `\n\n---\n**Next:** To drill into an area, READ ontoindex://repo/${repoPath}/cluster/{name}. To see execution flows, READ ontoindex://repo/${repoPath}/processes.`;

    default:
      return '';
  }
}

function getReadResourceErrorMessage(err: unknown): unknown {
  if (err instanceof Error) {
    return err.message;
  }
  if (
    ((typeof err === 'object' && err !== null) || typeof err === 'function') &&
    'message' in err
  ) {
    return (err as { message: unknown }).message;
  }
  return undefined;
}

async function dispatchLazySuper(
  name: SuperTool,
  params: Record<string, unknown>,
  repoId: string,
): Promise<unknown> {
  const { dispatchSuper } = await import('./super/dispatch.js');
  return dispatchSuper(name, params, repoId);
}

/**
 * Create a configured MCP Server with all handlers registered.
 * Transport-agnostic — caller connects the desired transport.
 */
export function createMCPServer(backend: LocalBackend, options: { full?: boolean } = {}): Server {
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

  // Handle list resources request
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = getResourceDefinitions();
    return {
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    };
  });

  // Handle list resource templates request (for dynamic resources)
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const templates = getResourceTemplates();
    return {
      resourceTemplates: templates.map((t) => ({
        uriTemplate: t.uriTemplate,
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
      })),
    };
  });

  // Handle read resource request
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    try {
      const content = await readResource(uri, backend);
      return {
        contents: [
          {
            uri,
            mimeType: 'text/yaml',
            text: content,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `Error: ${getReadResourceErrorMessage(err)}`,
          },
        ],
      };
    }
  });

  // Handle list tools request
  const startupProfile = getMcpStartupProfileFromEnv();
  const activeTools = options.full
    ? INTERNAL_TOOL_HANDLERS
    : getPublicToolDefinitions({ startupProfile });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

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
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const typedArgs = (args ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;
      if (!options.full && SUPER_NAMES.has(name as SuperTool)) {
        if (isRepoOptionalSuperToolName(name)) {
          result = await dispatchLazySuper(name as SuperTool, typedArgs, '');
        } else {
          const repo = await backend.resolveRepo(typedArgs.repo as string | undefined);
          if (GRAPH_BACKED_SUPER_TOOLS.has(name as SuperTool)) {
            await backend.ensureRepoInitialized(repo.id);
          }
          result = await dispatchLazySuper(name as SuperTool, typedArgs, repo.id);
        }
      } else if (!options.full && FACADE_NAMES.has(name)) {
        const action = typedArgs.action as string;
        if (!action) throw new Error(`Tool "${name}" requires an "action" parameter.`);
        result = await dispatchFacade(name as FacadeTool, action, typedArgs, backend);
      } else {
        result = await backend.callTool(name, typedArgs);
      }
      const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      const hint = getNextStepHint(name, typedArgs);
      return {
        content: [{ type: 'text', text: resultText + hint }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Handle list prompts request
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
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
  }));

  // Handle get prompt request
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'detect_impact') {
      const scope = args?.scope || 'all';
      const baseRef = args?.base_ref || '';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Analyze the impact of my current code changes before committing.

Follow these steps:
1. Run \`detect_changes(${JSON.stringify({ scope, ...(baseRef ? { base_ref: baseRef } : {}) })})\` to find what changed and affected processes
2. For each changed symbol in critical processes, run \`context({name: "<symbol>"})\` to see its full reference graph
3. For any high-risk items (many callers or cross-process), run \`impact({target: "<symbol>", direction: "upstream"})\` for blast radius
4. Summarize: changes, affected processes, risk level, and recommended actions

Present the analysis as a clear risk report.`,
            },
          },
        ],
      };
    }

    if (name === 'generate_map') {
      const repo = args?.repo || '';
      return {
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
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  return server;
}

/**
 * Start the MCP server on stdio transport (for CLI use).
 */
export async function startMCPServer(
  backend: LocalBackend,
  options: { full?: boolean } = {},
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
  await server.connect(transport);

  // Graceful shutdown helper
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await backend.dispose();
    } catch {}
    try {
      await server.close();
    } catch {}
    process.exit(exitCode);
  };

  // Handle graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Log crashes to stderr so they aren't silently lost.
  // uncaughtException is fatal — shut down.
  // unhandledRejection is logged but kept non-fatal (availability-first):
  // killing the server for one missed catch would be worse than logging it.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`OntoIndex MCP uncaughtException: ${err?.stack || err}\n`);
    shutdown(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(
      `OntoIndex MCP unhandledRejection: ${formatUnhandledRejectionReason(reason)}\n`,
    );
  });

  // Handle stdio errors — stdin close means the parent process is gone
  process.stdin.on('end', shutdown);
  process.stdin.on('error', () => shutdown());
  process.stdout.on('error', () => shutdown());
}
