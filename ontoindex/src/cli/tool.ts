/**
 * Direct CLI Tool Commands
 *
 * Exposes OntoIndex tools (query, context, impact, cypher) as direct CLI commands.
 * Bypasses MCP entirely — invokes LocalBackend directly for minimal overhead.
 *
 * Usage:
 *   ontoindex query "authentication flow"
 *   ontoindex context --name "validateUser"
 *   ontoindex impact --target "AuthService" --direction upstream
 *   ontoindex cypher "MATCH (n:Function) RETURN n.name LIMIT 10"
 *
 * Note: Output goes to stdout via fs.writeSync(fd 1), bypassing LadybugDB's
 * native module which captures the Node.js process.stdout stream during init.
 * See the output() function for details (#324).
 */

import { writeSync } from 'node:fs';
import { parseTypedQueryDocument } from '../core/search/typed-query-document.js';
import { LocalBackend } from '../mcp/local/local-backend.js';

let _backend: LocalBackend | null = null;

async function getBackend(): Promise<LocalBackend> {
  if (_backend) return _backend;
  _backend = new LocalBackend();
  const ok = await _backend.init();
  if (!ok) {
    console.error('OntoIndex: No indexed repositories found. Run: ontoindex analyze');
    process.exit(1);
  }
  return _backend;
}

/**
 * Write tool output to stdout using low-level fd write.
 *
 * LadybugDB's native module captures Node.js process.stdout during init,
 * but the underlying OS file descriptor 1 (stdout) remains intact.
 * By using fs.writeSync(1, ...) we bypass the Node.js stream layer
 * and write directly to the real stdout fd (#324).
 *
 * Falls back to stderr if the fd write fails (e.g., broken pipe).
 */
function thrownCode(err: unknown): unknown {
  if (err == null) return undefined;
  return (Object(err) as { readonly code?: unknown }).code;
}

function output(data: unknown): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  try {
    writeSync(1, text + '\n');
  } catch (err: unknown) {
    if (thrownCode(err) === 'EPIPE') {
      // Consumer closed the pipe (e.g., `ontoindex cypher ... | head -1`)
      // Exit cleanly per Unix convention
      process.exit(0);
    }
    // Fallback: stderr (previous behavior, works on all platforms)
    process.stderr.write(text + '\n');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asFormatterArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function recordField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

interface DetectChangesSummaryFormat {
  changed_files?: unknown;
  changed_count?: unknown;
  affected_count?: unknown;
  risk_level?: unknown;
}

interface ChangedSymbolFormat {
  type?: unknown;
  name?: unknown;
  filePath?: unknown;
}

interface ChangedStepFormat {
  symbol?: unknown;
}

interface AffectedProcessFormat {
  name?: unknown;
  step_count?: unknown;
  changed_steps?: ChangedStepFormat[];
}

export async function queryCommand(
  queryText: string,
  options?: {
    repo?: string;
    context?: string;
    goal?: string;
    limit?: string;
    content?: boolean;
    typed?: boolean;
    consumeEnrichmentFacts?: boolean;
    includePassiveRelatedFacts?: boolean;
    includeMarkdownContext?: boolean;
    includeMarkdownPpr?: boolean;
  },
): Promise<void> {
  if (!queryText?.trim()) {
    console.error('Usage: ontoindex query <search_query>');
    process.exit(1);
  }

  const query = options?.typed ? parseTypedQueryDocument(queryText) : queryText;
  const backend = await getBackend();
  const params: Record<string, unknown> = {
    task_context: options?.context,
    goal: options?.goal,
    limit: options?.limit ? parseInt(options.limit) : undefined,
    include_content: options?.content ?? false,
    repo: options?.repo,
  };
  if (options?.typed) {
    params.typedQuery = query;
  } else {
    params.query = query;
  }
  if (options?.consumeEnrichmentFacts !== undefined) {
    params.consume_enrichment_facts = options.consumeEnrichmentFacts;
  }
  if (options?.includePassiveRelatedFacts !== undefined) {
    params.include_passive_related_facts = options.includePassiveRelatedFacts;
  }
  if (options?.includeMarkdownContext !== undefined) {
    params.include_markdown_context = options.includeMarkdownContext;
  }
  if (options?.includeMarkdownPpr !== undefined) {
    params.include_markdown_ppr = options.includeMarkdownPpr;
  }
  const result = await backend.callTool('query', params);
  output(result);
}

export async function contextCommand(
  name: string,
  options?: {
    repo?: string;
    file?: string;
    uid?: string;
    content?: boolean;
  },
): Promise<void> {
  if (!name?.trim() && !options?.uid) {
    console.error('Usage: ontoindex context <symbol_name> [--uid <uid>] [--file <path>]');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('context', {
    name: name || undefined,
    uid: options?.uid,
    file_path: options?.file,
    include_content: options?.content ?? false,
    repo: options?.repo,
  });
  output(result);
}

export async function impactCommand(
  target: string,
  options?: {
    direction?: string;
    repo?: string;
    depth?: string;
    includeTests?: boolean;
  },
): Promise<void> {
  if (!target?.trim()) {
    console.error('Usage: ontoindex impact <symbol_name> [--direction upstream|downstream]');
    process.exit(1);
  }

  try {
    const backend = await getBackend();
    const result = await backend.callTool('impact', {
      target,
      direction: options?.direction || 'upstream',
      maxDepth: options?.depth ? parseInt(options.depth, 10) : undefined,
      includeTests: options?.includeTests ?? false,
      repo: options?.repo,
    });
    output(result);
  } catch (err: unknown) {
    // Belt-and-suspenders: catch infrastructure failures (getBackend, callTool transport)
    // The backend's impact() already returns structured errors for graph query failures
    output({
      error:
        (err instanceof Error ? err.message : String(err)) || 'Impact analysis failed unexpectedly',
      target: { name: target },
      direction: options?.direction || 'upstream',
      suggestion: 'Try reducing --depth or using ontoindex context <symbol> as a fallback',
    });
    process.exit(1);
  }
}

export async function cypherCommand(
  query: string,
  options?: {
    repo?: string;
  },
): Promise<void> {
  if (!query?.trim()) {
    console.error('Usage: ontoindex cypher <cypher_query>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('cypher', {
    query,
    repo: options?.repo,
  });
  output(result);
}

function formatDetectChangesResult(result: unknown): string {
  const error = recordField(result, 'error');
  if (error) return `Error: ${error}`;

  const summary = (recordField(result, 'summary') || {}) as DetectChangesSummaryFormat;
  if ((summary.changed_count || 0) === 0) {
    return 'No changes detected.';
  }

  const lines: string[] = [];
  lines.push(`Changes: ${summary.changed_files || 0} files, ${summary.changed_count || 0} symbols`);
  lines.push(`Affected processes: ${summary.affected_count || 0}`);
  lines.push(`Risk level: ${summary.risk_level || 'unknown'}`);
  lines.push('');

  const changed = asFormatterArray<ChangedSymbolFormat>(recordField(result, 'changed_symbols'));
  if (changed.length > 0) {
    lines.push('Changed symbols:');
    for (const symbol of changed.slice(0, 15)) {
      lines.push(`  ${symbol.type} ${symbol.name} → ${symbol.filePath}`);
    }
    if (changed.length > 15) {
      lines.push(`  ... and ${changed.length - 15} more`);
    }
    lines.push('');
  }

  const affected = asFormatterArray<AffectedProcessFormat>(
    recordField(result, 'affected_processes'),
  );
  if (affected.length > 0) {
    lines.push('Affected execution flows:');
    for (const processInfo of affected.slice(0, 10)) {
      const steps = asFormatterArray<ChangedStepFormat>(processInfo.changed_steps)
        .map((s) => s.symbol)
        .join(', ');
      lines.push(`  • ${processInfo.name} (${processInfo.step_count} steps) — changed: ${steps}`);
    }
  }

  return lines.join('\n').trim();
}

export async function detectChangesCommand(options?: {
  scope?: string;
  baseRef?: string;
  repo?: string;
}): Promise<void> {
  const backend = await getBackend();
  const result = await backend.callTool('detect_changes', {
    scope: options?.scope || 'unstaged',
    base_ref: options?.baseRef,
    repo: options?.repo,
  });
  output(formatDetectChangesResult(result));
}
