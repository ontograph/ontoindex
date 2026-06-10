#!/usr/bin/env node

// Heap re-spawn removed — only analyze.ts needs the 8GB heap (via its own ensureHeap()).
// Removing it from here improves MCP server startup time significantly.

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { createLazyAction } from './lazy-action.js';
import { registerGroupCommands } from './group.js';
import { registerReviewCommands } from './review.js';
import { registerExportCommands } from './export.js';
import { registerReportCommands } from './report.js';
import { registerPrCommands } from './pr.js';
import { applyLargeRepoSafeAnalyzePreset } from './analyze-large-repo-safe.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');
const program = new Command();

const collectOption = (value: string, previous: string[] = []): string[] => [...previous, value];

const requiredNodeMajor = 20;
const currentNodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
if (!Number.isFinite(currentNodeMajor) || currentNodeMajor < requiredNodeMajor) {
  console.error(
    `OntoIndex requires Node.js >=${requiredNodeMajor}; current runtime is ${process.version}. ` +
      'Use a supported Node binary in MCP config instead of bare "node" when your shell default is older.',
  );
  process.exit(1);
}

program.name('ontoindex').description('OntoIndex local CLI and MCP server').version(pkg.version);

program
  .command('setup')
  .description('One-time setup: configure MCP for Cursor, Claude Code, OpenCode, Codex')
  .action(createLazyAction(() => import('./setup.js'), 'setupCommand'));

program
  .command('analyze [path]')
  .description('Index a repository (full analysis)')
  .option('-f, --force', 'Force full re-index even if up to date')
  .option('--embeddings', 'Enable embedding generation for semantic search (off by default)')
  .option('--ann-neighbors', 'Build symbol-neighborhood ANN_NEIGHBOR edges (off by default)')
  .option('--skills', 'Generate repo-specific skill files from detected communities')
  .option('--skip-agents-md', 'Skip updating the ontoindex section in AGENTS.md and CLAUDE.md')
  .option('--no-stats', 'Omit volatile file/symbol counts from AGENTS.md and CLAUDE.md')
  .option('--skip-git', 'Index a folder without requiring a .git directory')
  .option('--index-only', 'Deprecated alias for --symbols-only')
  .option('--large-repo-safe', 'Apply conservative analyze defaults for large repositories')
  .option('--symbols-only', 'Build a minimal symbols index (scan, structure, parse only)')
  .option(
    '--huge-repo',
    'Compose --large-repo-safe and symbols-only indexing for huge repositories',
  )
  .option('--allow-huge-root', 'Allow --huge-repo without explicit --include-path scoping')
  .option(
    '--include-path <path>',
    'Limit analysis to a repository-relative file or directory; repeat for multiple roots',
    collectOption,
    [],
  )
  .option('--markdown-sidecar', 'Queue opt-in Markdown RAG sidecar enrichment after indexing')
  .option(
    '--name <alias>',
    'Register this repo under a custom name in ~/.ontoindex/registry.json ' +
      '(disambiguates repos whose paths share a basename, e.g. two different .../app folders)',
  )
  .option(
    '--allow-duplicate-name',
    'Register this repo even if another path already uses the same --name alias. ' +
      'Leaves `-r <name>` ambiguous for the two paths; use -r <path> to disambiguate.',
  )
  .option('-v, --verbose', 'Enable verbose ingestion warnings (default: false)')
  .addHelpText(
    'after',
    '\nEnvironment variables:\n' +
      '  ONTOINDEX_NO_GITIGNORE=1  Skip .gitignore parsing (still reads .ontoindexignore)\n' +
      '  --large-repo-safe sets unset ONTOINDEX_MAX_WORKERS, ONTOINDEX_WORKER_SUB_BATCH_SIZE,\n' +
      '    ONTOINDEX_WORKER_SUB_BATCH_TIMEOUT_MS, and ONTOINDEX_WORKER_SUB_BATCH_MAX_BYTES',
  )
  .action(async (inputPath, options) => {
    const applied = applyLargeRepoSafeAnalyzePreset(options);
    if (
      (options?.largeRepoSafe || options?.hugeRepo) &&
      process.env.ONTOINDEX_LARGE_REPO_SAFE_APPLIED === undefined
    ) {
      process.env.ONTOINDEX_LARGE_REPO_SAFE_APPLIED = applied.join(',');
    }
    await createLazyAction(() => import('./analyze.js'), 'analyzeCommand')(inputPath, options);
  });

program
  .command('debug-bisect [path]')
  .description('Find a failing indexing subdirectory with bounded child analyze runs')
  .option('--timeout <ms>', 'Per-child analyze timeout in milliseconds', '120000')
  .option('--max-depth <n>', 'Maximum child-directory descent depth', '4')
  .option(
    '--name-prefix <prefix>',
    'Repository alias prefix for debug analyze runs',
    'debug-bisect-',
  )
  .option(
    '--include <token>',
    'Only scan child paths containing this token; repeat or comma-separate values',
    (value: string, previous: string[] = []) => [...previous, value],
    [],
  )
  .option(
    '--ext <extension>',
    'Only scan child dirs containing this file extension; repeat or comma-separate values',
    (value: string, previous: string[] = []) => [...previous, value],
    [],
  )
  .action(createLazyAction(() => import('./debug-bisect.js'), 'debugBisectCommand'));

program
  .command('index [path...]')
  .description(
    'Register an existing .ontoindex/ folder into the global registry (no re-analysis needed)',
  )
  .option('-f, --force', 'Register even if meta.json is missing (stats will be empty)')
  .option('--allow-non-git', 'Allow registering folders that are not Git repositories')
  .action(createLazyAction(() => import('./index-repo.js'), 'indexCommand'));

program
  .command('serve')
  .description('Start local HTTP server for web UI connection')
  .option('-p, --port <port>', 'Port number', '4747')
  .option('--host <host>', 'Bind address (default: 127.0.0.1, use 0.0.0.0 for remote access)')
  .action(createLazyAction(() => import('./serve.js'), 'serveCommand'));

program
  .command('mcp')
  .description('Start MCP server (stdio) — serves indexed repos')
  .option('--full', 'Expose all direct internal tools (DEPRECATED — default is public MCP tools)')
  .option('-r, --repo <repo>', 'Only expose one indexed repo by name or absolute path')
  .action(createLazyAction(() => import('./mcp.js'), 'mcpCommand'));

program
  .command('list')
  .description('List all indexed repositories')
  .action(createLazyAction(() => import('./list.js'), 'listCommand'));

program
  .command('status')
  .description('Show index status for current repo')
  .action(createLazyAction(() => import('./status.js'), 'statusCommand'));

program
  .command('clean')
  .description('Delete OntoIndex index for current repo')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--all', 'Clean all indexed repos')
  .action(createLazyAction(() => import('./clean.js'), 'cleanCommand'));

program
  .command('wiki [path]')
  .description('Generate repository wiki from knowledge graph')
  .option('-f, --force', 'Force full regeneration even if up to date')
  .option('--provider <provider>', 'LLM provider: openai or cursor (default: openai)')
  .option('--model <model>', 'LLM model or Azure deployment name (default: minimax/minimax-m2.5)')
  .option(
    '--base-url <url>',
    'LLM API base URL. Azure v1: https://{resource}.openai.azure.com/openai/v1',
  )
  .option('--api-key <key>', 'LLM API key or Azure api-key (saved to ~/.ontoindex/config.json)')
  .option(
    '--api-version <version>',
    'Azure api-version query param, e.g. 2024-10-21 (legacy Azure API only)',
  )
  .option(
    '--reasoning-model',
    'Mark deployment as reasoning model (o1/o3/o4-mini) — strips temperature, uses max_completion_tokens',
  )
  .option('--no-reasoning-model', 'Disable reasoning model mode (overrides saved config)')
  .option('--concurrency <n>', 'Parallel LLM calls (default: 3)', '3')
  .option('--gist', 'Publish wiki as a public GitHub Gist after generation')
  .option('-v, --verbose', 'Enable verbose output (show LLM commands and responses)')
  .option('--review', 'Stop after grouping to review module structure before generating pages')
  .option('--max-tokens <n>', 'Abort if estimated token budget exceeds N (default: no limit)')
  .action(createLazyAction(() => import('./wiki.js'), 'wikiCommand'));

const auditProgram = program
  .command('audit')
  .description('Generate a structured audit report from the knowledge graph')
  .option('--annotate', 'Add one LLM annotation pass interpreting the top findings (cached)')
  .option('--since <commit>', 'Lookback for graph diff (default: HEAD~30)', 'HEAD~30')
  .option('--output <path>', 'Output directory (default: ./ontoindex-audit/)')
  .option('-f, --force', 'Bypass annotation cache and force a fresh LLM call')
  .action(createLazyAction(() => import('./audit.js'), 'auditCommand'));

auditProgram
  .command('ingest <report>')
  .description('Ingest an audit report as candidate findings locked to target HEAD')
  .option('--target <ref>', 'Target git ref to lock (default: HEAD)', 'HEAD')
  .option('--json', 'Emit JSON')
  .option('--repo <path>', 'Repository path (defaults to current git root)')
  .option('--max-findings <n>', 'Maximum findings returned')
  .option('--no-persist', 'Do not write .ontoindex/audit events')
  .action(createLazyAction(() => import('./audit.js'), 'auditIngestCommand'));

auditProgram
  .command('verify')
  .description('Verify candidate findings against fresh target HEAD evidence')
  .requiredOption('--session <id>', 'Audit session id')
  .option('--finding-id <id>', 'Optional finding id filter')
  .option('--json', 'Emit JSON')
  .option('--format <format>', 'Output format: json or sarif')
  .option('--repo <path>', 'Repository path (defaults to current git root)')
  .option('--max-findings <n>', 'Maximum findings verified')
  .option('--max-evidence <n>', 'Maximum evidence items per finding')
  .option('--no-persist', 'Do not write verification/status events')
  .action(createLazyAction(() => import('./audit.js'), 'auditVerifyCommand'));

auditProgram
  .command('lint [report]')
  .description('Lint audit lifecycle findings or bundles')
  .option('--target <ref>', 'Target git ref to lock when ingesting a report', 'HEAD')
  .option('--session <id>', 'Audit session id')
  .option('--scope <scope>', 'report, bundle, or all', 'report')
  .option('--advisory', 'Compatibility flag; advisory/blocking mode is controlled by repo policy')
  .option('--strict', 'Compatibility flag; blocking mode is controlled by repo policy')
  .option('--json', 'Emit JSON')
  .option('--format <format>', 'Output format: json, sarif, or junit')
  .option('--repo <path>', 'Repository path (defaults to current git root)')
  .option('--max-issues <n>', 'Maximum issues returned')
  .option('--max-findings <n>', 'Maximum findings returned for report ingest')
  .option('--no-persist', 'Do not write audit events')
  .action(createLazyAction(() => import('./audit.js'), 'auditLintCommand'));

auditProgram
  .command('bundle')
  .description('Project verified findings into implementation bundles without dispatching work')
  .requiredOption('--session <id>', 'Audit session id')
  .option('--json', 'Emit JSON')
  .option('--repo <path>', 'Repository path (defaults to current git root)')
  .option('--max-bundles <n>', 'Maximum bundles returned')
  .option('--no-persist', 'Do not write bundle events')
  .action(createLazyAction(() => import('./audit.js'), 'auditBundleCommand'));

program
  .command('augment <pattern>')
  .description('Augment a search pattern with knowledge graph context (used by hooks)')
  .action(createLazyAction(() => import('./augment.js'), 'augmentCommand'));

const packsProgram = program
  .command('packs')
  .description('Inspect and run local analysis packs and suites');

packsProgram
  .command('list')
  .description('List discovered analysis packs and suites from ontoindex-packs/')
  .option(
    '-p, --path <path>',
    'Repository path that contains ontoindex-packs/ (defaults to git root)',
  )
  .option('--kind <kind>', 'Filter packs by kind: library, query, model')
  .option('--tier <tier>', 'Filter packs by tier: stable, experimental')
  .option('--json', 'Emit JSON instead of text')
  .action(createLazyAction(() => import('./packs.js'), 'listPacksCommand'));

packsProgram
  .command('describe <id>')
  .description('Describe a pack or suite and show its execution plan')
  .option(
    '-p, --path <path>',
    'Repository path that contains ontoindex-packs/ (defaults to git root)',
  )
  .option('--json', 'Emit JSON instead of text')
  .action(createLazyAction(() => import('./packs.js'), 'describePackCommand'));

packsProgram
  .command('run <id>')
  .description('Expand a pack or suite and execute its tool-backed steps')
  .option(
    '-p, --path <path>',
    'Repository path that contains ontoindex-packs/ (defaults to git root)',
  )
  .option('-r, --repo <name>', 'Indexed repository name/path for tool execution')
  .option('--fail-fast', 'Stop on the first tool error')
  .option('--json', 'Emit JSON instead of text')
  .action(createLazyAction(() => import('./packs.js'), 'runPackCommand'));

const docsProgram = program
  .command('docs')
  .description('Documentation sidecar and graph integration');

const sidecarProgram = docsProgram
  .command('sidecar')
  .description('Manage the Markdown enrichment sidecar');

sidecarProgram
  .command('status')
  .description('Show sidecar execution status')
  .option('--json', 'Output stable JSON')
  .option('--strict', 'Exit nonzero on failed/stale/partial states')
  .option('-r, --repo <path>', 'Target repository')
  .action(createLazyAction(() => import('./docs.js'), 'sidecarStatusCommand'));

sidecarProgram
  .command('run <type>')
  .description('Run a specific sidecar executor (e.g. markdown)')
  .option('--json', 'Output stable JSON')
  .option('-r, --repo <path>', 'Target repository')
  .action(createLazyAction(() => import('./docs.js'), 'sidecarRunCommand'));

docsProgram
  .command('trace')
  .description('Generate documentation trace reports')
  .option('--requirements', 'Trace Markdown requirement evidence')
  .option('--id <requirementId>', 'Filter to one requirement id')
  .option('--json', 'Output stable JSON')
  .option('-r, --repo <path>', 'Target repository')
  .action(createLazyAction(() => import('./docs.js'), 'traceCommand'));

docsProgram
  .command('drift')
  .description('Generate documentation drift reports')
  .option('--api', 'Compare Markdown API routes to code routes')
  .option('--json', 'Output stable JSON')
  .option('-r, --repo <path>', 'Target repository')
  .action(createLazyAction(() => import('./docs.js'), 'driftCommand'));

docsProgram
  .command('knowledge')
  .description('Generate advisory Markdown knowledge concept reports')
  .option('--json', 'Output stable JSON')
  .option('-r, --repo <path>', 'Target repository')
  .option('--max-items <n>', 'Maximum concepts returned')
  .option('--max-candidates-per-fact <n>', 'Maximum linked graph identities per concept')
  .action(createLazyAction(() => import('./docs.js'), 'knowledgeCommand'));

program
  .command('memory <name>')
  .description('Create a local advisory memory skeleton in .ontoindex/memories/')
  .option(
    '-s, --source <source>',
    'Source path or ADR backing this advisory memory',
    (value: string, previous: string[] = []) => [...previous, value],
    [],
  )
  .option('-f, --force', 'Overwrite an existing memory skeleton')
  .action(createLazyAction(() => import('./memory.js'), 'memoryCommand'));

// ─── Direct Tool Commands (no MCP overhead) ────────────────────────
// These invoke LocalBackend directly for use in eval, scripts, and CI.

program
  .command('query <search_query>')
  .description('Search the knowledge graph for execution flows related to a concept')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('-c, --context <text>', 'Task context to improve ranking')
  .option('-g, --goal <text>', 'What you want to find')
  .option('-l, --limit <n>', 'Max processes to return (default: 5)')
  .option('--content', 'Include full symbol source code')
  .option('--typed', 'Parse <search_query> as a typed query document before searching')
  .option('--consume-enrichment-facts', 'Opt in to HippoRAG enrichment fact consumption')
  .option(
    '--include-passive-related-facts',
    'Include passive related enrichment facts when consuming enrichment facts',
  )
  .option(
    '--include-markdown-context',
    'Include Markdown document context when consuming passive enrichment facts',
  )
  .option(
    '--include-markdown-ppr',
    'Include bounded Markdown document-only PPR when Markdown context is enabled',
  )
  .action(createLazyAction(() => import('./tool.js'), 'queryCommand'));

program
  .command('context [name]')
  .description('360-degree view of a code symbol: callers, callees, processes')
  .option('-r, --repo <name>', 'Target repository')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('--content', 'Include full symbol source code')
  .action(createLazyAction(() => import('./tool.js'), 'contextCommand'));

program
  .command('impact <target>')
  .description('Blast radius analysis: what breaks if you change a symbol')
  .option('-d, --direction <dir>', 'upstream (dependants) or downstream (dependencies)', 'upstream')
  .option('-r, --repo <name>', 'Target repository')
  .option('--depth <n>', 'Max relationship depth (default: 3)')
  .option('--include-tests', 'Include test files in results')
  .action(createLazyAction(() => import('./tool.js'), 'impactCommand'));

program
  .command('cypher <query>')
  .description('Execute raw Cypher query against the knowledge graph')
  .option('-r, --repo <name>', 'Target repository')
  .action(createLazyAction(() => import('./tool.js'), 'cypherCommand'));

program
  .command('detect-changes')
  .alias('detect_changes')
  .description('Map git diff hunks to indexed symbols and affected execution flows')
  .option('-s, --scope <scope>', 'What to analyze: unstaged, staged, all, or compare', 'unstaged')
  .option('-b, --base-ref <ref>', 'Branch/commit for compare scope (e.g. main)')
  .option('-r, --repo <name>', 'Target repository')
  .action(createLazyAction(() => import('./tool.js'), 'detectChangesCommand'));

program
  .command('check')
  .description('Run repository checks from .ontoindex/checks.yml (non-zero exit on failure)')
  .option('-r, --repo <path>', 'Repository path (defaults to current working directory)')
  .action(createLazyAction(() => import('./check.js'), 'checkCommand'));

// ─── Eval Server (persistent daemon for SWE-bench) ─────────────────

program
  .command('eval-server')
  .description('Start lightweight HTTP server for fast tool calls during evaluation')
  .option('-p, --port <port>', 'Port number', '4848')
  .option('--idle-timeout <seconds>', 'Auto-shutdown after N seconds idle (0 = disabled)', '0')
  .action(createLazyAction(() => import('./eval-server.js'), 'evalServerCommand'));

registerGroupCommands(program);
registerReviewCommands(program);
registerExportCommands(program);
registerReportCommands(program);
registerPrCommands(program);

program.parse(process.argv);
